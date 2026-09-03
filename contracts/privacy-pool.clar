;; =============================================================================
;; privacy-pool.clar
;; =============================================================================
;; STX Shield -- Privacy Pool (v1.0.0)
;;
;; THE core contract: the only user-facing entry point of STX Shield and the
;; custodian of all shielded STX. It owns no protocol state of its own beyond
;; three emergency operation switches -- every fact lives in its layer:
;;
;;   privacy-registry        commitments, nullifiers, roots, limits,
;;                              versions, statistics, access control
;;   note-manager              note lifecycle
;;   zk-verifier                proof acceptance
;;   protocol-fees              fee configuration and treasury
;;
;; The pool is the single principal on the registry's authorized-callers
;; allowlist: one list entry gates every protected write in the system.
;; Users call the pool; the pool orchestrates; the layers enforce.
;;
;; OPERATIONS
;;   shield    STX in:  user pays amount+fee; commitment + note registered;
;;             tree root advances; shielded accounting increases by amount.
;;   transfer  private ownership move: nullifier registered, old note spent,
;;             new commitment + note created, root advances. No STX moves
;;             (a configured transfer fee is paid transparently by tx-sender).
;;   withdraw  STX out: nullifier registered, note withdrawn, amount leaves
;;             the pool -- fee to the treasury, remainder to the recipient.
;;
;; SEQUENCING / TREE CONSISTENCY
;;   The commitment tree lives off-chain (Poseidon, computed by the SDK); the
;;   chain cannot recompute it. Linearity is enforced by root binding:
;;   shield and transfer must present the CURRENT root and the proof binds
;;   the declared new root -- a stale tree view fails with ERR-STALE-ROOT and
;;   the client retries against the fresh root. Withdrawals add no leaf, so
;;   they accept any historical root still active in the registry.
;;
;; PROOF BINDING
;;   For every operation the pool computes public-inputs-hash = sha256 of the
;;   consensus serialization of the operation's exact parameters, and the
;;   attestation committee's signatures (checked by zk-verifier) bind the
;;   proof to that hash. A valid proof authorizes exactly one operation with
;;   exactly these parameters: recipients cannot be swapped, amounts cannot
;;   be altered, roots cannot be substituted, and accepted proofs cannot be
;;   replayed (verifier proof-id registry + registry nullifiers).
;;
;; PRIVACY PROPERTIES (v1 -- stated precisely)
;;   Hidden:  note ownership (opaque owner commitments; ZK ownership proofs),
;;            note amounts (never on-chain; conservation proven in-circuit),
;;            recipient identity (new notes carry only opaque hashes).
;;   Visible: the note succession graph (a transfer names the note it
;;            consumes) and transparent deposit/withdrawal amounts.
;;   Full note-graph unlinkability ships as a circuit-version upgrade through
;;   the registry's UPGRADING flow (transfer drops its note-id argument);
;;   storage and frozen layers already support it.
;;
;; CONSERVATION INVARIANT
;;   pool STX balance == registry total-shielded-stx, always: shield adds
;;   `amount` to both; withdraw removes `amount` from both (fee + net are
;;   both paid out of the withdrawn amount); transfers touch neither.
;;
;; Error space: u250-u299 (reserved for pool errors across the protocol).
;; Errors from the layers (u100-u149 registry, u150-u199 notes, u200-u249
;; fees, u300-u349 verifier) pass through unchanged.
;; =============================================================================

;; -----------------------------------------------------------------------------
;; CONSTANTS
;; -----------------------------------------------------------------------------

(define-constant CONTRACT-VERSION u1)

;; Mirrors of zk-verifier proof types and protocol-fees fee types.
(define-constant PROOF-TYPE-SHIELD u1)
(define-constant PROOF-TYPE-TRANSFER u2)
(define-constant PROOF-TYPE-WITHDRAWAL u3)
(define-constant FEE-TYPE-SHIELD u1)
(define-constant FEE-TYPE-TRANSFER u2)
(define-constant FEE-TYPE-WITHDRAWAL u3)

;; Mirror of the frozen registry's emergency-admin role id.
(define-constant REGISTRY-ROLE-EMERGENCY-ADMIN u2)

;; Burn address: never a valid withdrawal recipient.
(define-constant BURN-ADDRESS 'SP000000000000000000002Q6VF78)

;; -----------------------------------------------------------------------------
;; ERRORS -- Reserved pool space u250-u299
;; -----------------------------------------------------------------------------

(define-constant ERR-UNAUTHORIZED (err u250))         ;; caller lacks registry owner/role authority
(define-constant ERR-OPERATION-DISABLED (err u251))   ;; per-operation emergency switch is off
(define-constant ERR-STALE-ROOT (err u252))           ;; declared current root != live current root
(define-constant ERR-UNKNOWN-ROOT (err u253))         ;; root not active in the registry
(define-constant ERR-FEE-EXCEEDS-AMOUNT (err u254))   ;; fee would consume the whole withdrawal
(define-constant ERR-INVALID-RECIPIENT (err u255))    ;; burn / pool / fees contract as recipient
(define-constant ERR-STX-TRANSFER-FAILED (err u256))  ;; underlying STX transfer failed
(define-constant ERR-SWITCH-UNCHANGED (err u257))     ;; operation switch no-op
(define-constant ERR-LEAF-INDEX-MISMATCH (err u258))  ;; registry slot != proof-bound leaf-index

;; -----------------------------------------------------------------------------
;; STORAGE -- Emergency operation switches
;; -----------------------------------------------------------------------------
;; Granular kill switches per user operation, controlled by the registry
;; emergency admin or owner, effective in ANY protocol state. They compose
;; with (never replace) the registry's protocol state machine.

(define-data-var shield-enabled bool true)
(define-data-var transfer-enabled bool true)
(define-data-var withdraw-enabled bool true)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Canonical public-input encoding
;; -----------------------------------------------------------------------------
;; A circuit public input is a BN254 field element, which barretenberg
;; serializes as 32 bytes BIG-ENDIAN. zkVerify hashes the concatenation of
;; those bytes with keccak256. The canonical binding is therefore:
;;
;;   keccak256( fe_0 || fe_1 || ... || fe_n )
;;
;; in the circuit's declaration order, and NOTHING ELSE.
;;
;; CORRECTNESS RULE: this contract must hash EXACTLY the circuit's public
;; inputs, in declaration order -- no more, no less. The tree transition is a
;; circuit input: `current-root` (the old root the append starts from),
;; `new-root` (the root after it), and `leaf-index` (the slot) are all bound in
;; the proof, so they are hashed here. `metadata` is NOT a circuit input and is
;; enforced by contract-level checks instead -- hashing it would commit to data
;; no proof verifies.

;; 16 zero bytes: a Clarity uint is 128-bit, so a field element built from one
;; is left-padded to 32 bytes.
(define-constant FE-PAD 0x00000000000000000000000000000000)

;; uint -> 32-byte big-endian field element. `to-consensus-buff?` of a uint is
;; a 0x01 type tag followed by 16 big-endian bytes; the tag is sliced off and
;; the remainder left-padded.
(define-private (fe-uint (n uint))
  (concat FE-PAD
    (unwrap-panic (slice? (unwrap-panic (to-consensus-buff? n)) u1 u17))
  )
)

;; principal -> field element. sha256 over the consensus encoding with the top
;; byte forced to zero, so the value is < 2^248 and therefore always below the
;; BN254 modulus -- a hash used raw could exceed it and not be a valid field
;; element. The SDK and the circuit witness use this identical derivation.
(define-private (fe-principal (who principal))
  (concat 0x00
    (unwrap-panic (slice? (sha256 (unwrap-panic (to-consensus-buff? who))) u1 u32))
  )
)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Authority (fully delegated to the frozen registry)
;; -----------------------------------------------------------------------------

(define-private (is-registry-owner (who principal))
  (is-eq who (contract-call? .privacy-registry get-owner))
)

(define-private (is-emergency-admin (who principal))
  (or
    (is-registry-owner who)
    (contract-call? .privacy-registry has-role who REGISTRY-ROLE-EMERGENCY-ADMIN)
  )
)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Root binding
;; -----------------------------------------------------------------------------

;; For tree-extending operations: the declared root must be the live current
;; root AND still active (deactivating the current root is the registry's
;; root-level kill switch and must halt insertions here).
(define-private (check-current-root (declared (buff 32)))
  (begin
    (asserts!
      (is-eq declared
        (get root (contract-call? .privacy-registry get-current-root))
      )
      ERR-STALE-ROOT
    )
    (asserts! (contract-call? .privacy-registry is-known-root declared)
      ERR-UNKNOWN-ROOT
    )
    (ok true)
  )
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Pool status
;; -----------------------------------------------------------------------------

(define-read-only (get-pool-balance)
  (stx-get-balance (as-contract tx-sender))
)

(define-read-only (is-shield-enabled)
  (var-get shield-enabled)
)

(define-read-only (is-transfer-enabled)
  (var-get transfer-enabled)
)

(define-read-only (is-withdraw-enabled)
  (var-get withdraw-enabled)
)

(define-read-only (get-pool-contract-version)
  CONTRACT-VERSION
)

;; One-read snapshot for the SDK: switches, balance, and the registry context
;; the pool currently operates under.
(define-read-only (get-pool-info)
  {
    contract-version: CONTRACT-VERSION,
    balance: (stx-get-balance (as-contract tx-sender)),
    shield-enabled: (var-get shield-enabled),
    transfer-enabled: (var-get transfer-enabled),
    withdraw-enabled: (var-get withdraw-enabled),
    protocol-state: (contract-call? .privacy-registry get-protocol-state),
    current-root: (contract-call? .privacy-registry get-current-root),
    total-shielded-stx: (contract-call? .privacy-registry get-total-shielded-stx),
  }
)

;; =============================================================================
;; PUBLIC -- SHIELD
;; =============================================================================

;; Shields `amount` uSTX. The user pays amount + shield fee: the amount backs
;; the new note in the pool, the fee goes straight to the treasury.
;;
;; The proof (attested, see zk-verifier) proves the commitment is well-formed
;; for exactly `amount` and that new-root is the correct tree after inserting
;; it -- a malformed commitment can neither lock funds nor mint value.
;;
;; Returns (ok leaf-index) of the registered commitment.
(define-public (shield
    (amount uint)
    (commitment (buff 32))
    (owner-commitment (buff 32))
    (metadata (buff 32))
    (current-root (buff 32))
    (new-root (buff 32))
    (leaf-index uint)
    (domain-id uint)
    (aggregation-id uint)
    (merkle-path (list 32 (buff 32)))
    (agg-leaf-index uint)
  )
  (begin
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (var-get shield-enabled) ERR-OPERATION-DISABLED)
    (try! (contract-call? .privacy-registry validate-shield-amount amount))
    (try! (check-current-root current-root))
    (let (
        (fee (try! (contract-call? .protocol-fees calculate-fee FEE-TYPE-SHIELD amount)))
        ;; CANONICAL: exactly the shield circuit's public inputs, in order:
        ;; op, commitment, owner_commitment, amount, old_root, new_root,
        ;; leaf_index, circuit_version. metadata is NOT a circuit input and is
        ;; validated by contract checks, never hashed here.
        (inputs-hash (keccak256 (concat
          (concat (fe-uint PROOF-TYPE-SHIELD) commitment)
          (concat (concat (concat (concat (concat owner-commitment (fe-uint amount)) current-root) new-root) (fe-uint leaf-index))
                  (fe-uint (contract-call? .privacy-registry get-circuit-version)))
        )))
      )
      (try! (contract-call? .zk-verifier verify-proof
        PROOF-TYPE-SHIELD
        (contract-call? .privacy-registry get-circuit-version)
        inputs-hash
        domain-id
        aggregation-id
        merkle-path
        agg-leaf-index
      ))
      ;; the shielded amount backs the note in the pool ...
      (unwrap! (stx-transfer? amount tx-sender (as-contract tx-sender))
        ERR-STX-TRANSFER-FAILED
      )
      ;; ... and the fee (if any) goes straight from the user to the treasury
      (if (> fee u0)
        (try! (contract-call? .protocol-fees collect-fee FEE-TYPE-SHIELD fee))
        u0
      )
      (try! (contract-call? .note-manager register-note
        commitment
        owner-commitment
        metadata
        (contract-call? .privacy-registry get-note-version)
      ))
      (let (
          (registered-index (try! (contract-call? .privacy-registry register-commitment
            commitment
            (contract-call? .privacy-registry get-commitment-version)
          )))
        )
        ;; the registry-assigned slot must equal the proof-bound leaf-index.
        (asserts! (is-eq registered-index leaf-index) ERR-LEAF-INDEX-MISMATCH)
        (try! (contract-call? .privacy-registry update-root
          new-root
          (contract-call? .privacy-registry get-root-version)
        ))
        (try! (contract-call? .privacy-registry record-shield amount))
        (print {
          event: "shielded",
          commitment: commitment,
          leaf-index: registered-index,
          amount: amount,
          fee: fee,
          new-root: new-root,
          height: stacks-block-height,
        })
        (ok registered-index)
      )
    )
  )
)

;; =============================================================================
;; PUBLIC -- PRIVATE TRANSFER
;; =============================================================================

;; Transfers note ownership privately: consumes `old-note-id` (nullifier
;; registered, note spent) and creates `new-commitment` for the hidden
;; recipient. No shielded STX moves; a configured transfer fee is paid
;; transparently by tx-sender.
;;
;; The proof proves: ownership of the old note, correct nullifier
;; derivation, value conservation into the new commitment, and correct
;; insertion producing new-root.
;;
;; Returns (ok leaf-index) of the new commitment.
(define-public (transfer
    (nullifier (buff 32))
    (new-commitment (buff 32))
    (new-owner-commitment (buff 32))
    (new-metadata (buff 32))
    (current-root (buff 32))
    (new-root (buff 32))
    (leaf-index uint)
    (domain-id uint)
    (aggregation-id uint)
    (merkle-path (list 32 (buff 32)))
    (agg-leaf-index uint)
  )
  (begin
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (var-get transfer-enabled) ERR-OPERATION-DISABLED)
    (try! (check-current-root current-root))
    (let (
        (fee (try! (contract-call? .protocol-fees calculate-fee FEE-TYPE-TRANSFER u0)))
        ;; CANONICAL: the transfer circuit's public inputs, in order:
        ;; op, nullifier, new_commitment, new_owner_commitment, merkle_root,
        ;; new_root, leaf_index, circuit_version. merkle_root is the root
        ;; membership is proven against = current-root.
        (inputs-hash (keccak256 (concat
          (concat (concat (fe-uint PROOF-TYPE-TRANSFER) nullifier) new-commitment)
          (concat (concat (concat (concat new-owner-commitment current-root) new-root) (fe-uint leaf-index))
                  (fe-uint (contract-call? .privacy-registry get-circuit-version)))
        )))
      )
      (try! (contract-call? .zk-verifier verify-proof
        PROOF-TYPE-TRANSFER
        (contract-call? .privacy-registry get-circuit-version)
        inputs-hash
        domain-id
        aggregation-id
        merkle-path
        agg-leaf-index
      ))
      ;; flat transfer fee (amounts are hidden, so no percentage component),
      ;; paid transparently by tx-sender straight to the treasury
      (if (> fee u0)
        (try! (contract-call? .protocol-fees collect-fee FEE-TYPE-TRANSFER fee))
        u0
      )
      ;; double-spend / replay protection FIRST: the nullifier is the
      ;; protocol-level one-time token for the consumed note
      (try! (contract-call? .privacy-registry register-nullifier nullifier))
      (let (
          (registered-index (try! (contract-call? .privacy-registry register-commitment
            new-commitment
            (contract-call? .privacy-registry get-commitment-version)
          )))
        )
        ;; the registry-assigned slot must equal the proof-bound leaf-index.
        (asserts! (is-eq registered-index leaf-index) ERR-LEAF-INDEX-MISMATCH)
        (try! (contract-call? .note-manager register-note
          new-commitment
          new-owner-commitment
          new-metadata
          (contract-call? .privacy-registry get-note-version)
        ))
        (try! (contract-call? .privacy-registry update-root
          new-root
          (contract-call? .privacy-registry get-root-version)
        ))
        (try! (contract-call? .privacy-registry record-transfer))
        (print {
          event: "transferred",
          nullifier: nullifier,
          new-commitment: new-commitment,
          leaf-index: registered-index,
          fee: fee,
          new-root: new-root,
          height: stacks-block-height,
        })
        (ok registered-index)
      )
    )
  )
)

;; =============================================================================
;; PUBLIC -- WITHDRAWAL
;; =============================================================================

;; Withdraws `amount` uSTX to `recipient`: the note is consumed (nullifier +
;; WITHDRAWN state), the withdrawal fee goes to the treasury, and the
;; remainder goes to the recipient -- both paid out of the shielded amount,
;; so pool balance and registry accounting decrease by exactly `amount`.
;;
;; Withdrawals accept any root still ACTIVE in the registry (they add no
;; leaf), so proofs against recent-but-not-latest roots remain valid and
;; withdrawals cannot be griefed by concurrent tree updates.
;;
;; Returns (ok net-amount) paid to the recipient.
(define-public (withdraw
    (nullifier (buff 32))
    (amount uint)
    (recipient principal)
    (root (buff 32))
    (domain-id uint)
    (aggregation-id uint)
    (merkle-path (list 32 (buff 32)))
    (agg-leaf-index uint)
  )
  (begin
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (var-get withdraw-enabled) ERR-OPERATION-DISABLED)
    (try! (contract-call? .privacy-registry validate-withdrawal-amount amount))
    (asserts! (contract-call? .privacy-registry is-known-root root)
      ERR-UNKNOWN-ROOT
    )
    (asserts!
      (and
        (not (is-eq recipient BURN-ADDRESS))
        (not (is-eq recipient (as-contract tx-sender)))
        (not (is-eq recipient .protocol-fees))
      )
      ERR-INVALID-RECIPIENT
    )
    (let (
        (fee (try! (contract-call? .protocol-fees calculate-fee FEE-TYPE-WITHDRAWAL amount)))
        ;; CANONICAL: the withdraw circuit's public inputs, in order. The
        ;; recipient is bound as a FIELD (fe-principal), matching the
        ;; circuit's `recipient_hash` -- not as a Clarity principal.
        (inputs-hash (keccak256 (concat
          (concat (concat (fe-uint PROOF-TYPE-WITHDRAWAL) nullifier) (fe-uint amount))
          (concat (concat (fe-principal recipient) root)
                  (fe-uint (contract-call? .privacy-registry get-circuit-version)))
        )))
      )
      (asserts! (< fee amount) ERR-FEE-EXCEEDS-AMOUNT)
      (try! (contract-call? .zk-verifier verify-proof
        PROOF-TYPE-WITHDRAWAL
        (contract-call? .privacy-registry get-circuit-version)
        inputs-hash
        domain-id
        aggregation-id
        merkle-path
        agg-leaf-index
      ))
      ;; double-spend / replay protection FIRST
      (try! (contract-call? .privacy-registry register-nullifier nullifier))
      ;; accounting gate BEFORE any STX moves: record-withdrawal enforces
      ;; amount <= total-shielded-stx. Given the conservation invariant
      ;; (pool balance == total-shielded-stx), passing this guarantees the
      ;; pool holds enough, so the transfers below cannot fail for lack of
      ;; funds -- ERR-STX-TRANSFER-FAILED becomes a should-never-happen guard.
      (try! (contract-call? .privacy-registry record-withdrawal amount))
      ;; fee out of the withdrawn amount, pool -> treasury
      (if (> fee u0)
        (try! (as-contract (contract-call? .protocol-fees collect-fee
          FEE-TYPE-WITHDRAWAL fee
        )))
        u0
      )
      ;; remainder to the recipient, pool -> recipient
      (unwrap!
        (as-contract (stx-transfer? (- amount fee) tx-sender recipient))
        ERR-STX-TRANSFER-FAILED
      )
      (print {
        event: "withdrawn",
        nullifier: nullifier,
        amount: amount,
        fee: fee,
        recipient: recipient,
        height: stacks-block-height,
      })
      (ok (- amount fee))
    )
  )
)

;; =============================================================================
;; PUBLIC -- Emergency operation switches (emergency admin or owner)
;; =============================================================================

(define-public (set-shield-enabled (enabled bool))
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq (var-get shield-enabled) enabled)) ERR-SWITCH-UNCHANGED)
    (var-set shield-enabled enabled)
    (print { event: "shield-switch", enabled: enabled, height: stacks-block-height })
    (ok true)
  )
)

(define-public (set-transfer-enabled (enabled bool))
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq (var-get transfer-enabled) enabled)) ERR-SWITCH-UNCHANGED)
    (var-set transfer-enabled enabled)
    (print { event: "transfer-switch", enabled: enabled, height: stacks-block-height })
    (ok true)
  )
)

(define-public (set-withdraw-enabled (enabled bool))
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq (var-get withdraw-enabled) enabled)) ERR-SWITCH-UNCHANGED)
    (var-set withdraw-enabled enabled)
    (print { event: "withdraw-switch", enabled: enabled, height: stacks-block-height })
    (ok true)
  )
)
