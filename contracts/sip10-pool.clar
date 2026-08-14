;; =============================================================================
;; sip10-pool.clar
;; =============================================================================
;; STX Shield -- SIP-10 Privacy Pool (v1.0.0)
;;
;; The generic, user-facing entry point for shielding ANY registered SIP-10
;; asset. It is the SIP-10 sibling of `privacy-pool.clar` and mirrors it: it owns
;; no privacy state of its own beyond per-asset accounting and per-operation
;; emergency switches, and it ORCHESTRATES the shared layers:
;;
;;   asset-registry        (NEW)   supported assets, metadata, limits, fee config
;;   sip10-protocol-fees   (NEW)   token-native fee collection + per-asset treasury
;;   sip10-zk-verifier     (NEW)   SIP-10 proof acceptance (own vkey/version namespace)
;;   privacy-registry     (FROZEN) commitments, nullifiers, roots, tree, access control
;;   note-manager         (FROZEN) note lifecycle
;;
;; The STX pool and STX circuits are untouched. This pool shares the frozen
;; registry's single commitment tree with STX; that is safe because a SIP-10 note
;; commitment binds the asset (see the SIP-10 circuit family), so an STX leaf and
;; a SIP-10 leaf can never coincide and cross-asset membership fails cryptographically.
;;
;; TWO ASSET IDENTIFIERS (kept strictly separate):
;;   * asset-uid  -- the asset-registry's uint id. Used for config/accounting.
;;   * asset-fe   -- fe-principal(token) = the 32-byte field the CIRCUIT binds as
;;                   `asset_id`. Used only in the proof `inputs-hash`. Deriving it
;;                   from the exact `<sip-010-trait>` the pool will `transfer` on
;;                   is what ties the moved token to the proven asset.
;;
;; PROOF BINDING: for each operation the pool reproduces EXACTLY the SIP-10
;; circuit's public inputs (see zk/circuits/sip10/README.md section 4), field-serialized,
;; and keccak256s them into `inputs-hash`; `sip10-zk-verifier` binds the proof to
;; that hash. `asset_id` (asset-fe) sits immediately before `circuit_version` in
;; every tuple.
;;
;; NOTE ON split/merge: the frozen `split-merge-manager` is STX-only (it hashes
;; STX public inputs and calls the frozen verifier), so it cannot asset-bind.
;; SIP-10 split/merge are therefore implemented here, using the SIP-10 verifier
;; and asset-aware hashes. No new manager contract is introduced.
;;
;; CONSERVATION INVARIANT (per asset A): token_A.balance(this pool) ==
;;   shielded-total[A]. shield: +amount to both; withdraw: -amount from both
;;   (fee + net both paid out of the withdrawn amount, to the fee manager and the
;;   recipient); transfer/split/merge: net zero. Fees never sit in the pool.
;;
;; Error space: u450-u499 (reserved for the SIP-10 pool across the protocol).
;; =============================================================================

(use-trait sip-010-trait .sip-010-trait.sip-010-trait)

;; -----------------------------------------------------------------------------
;; CONSTANTS
;; -----------------------------------------------------------------------------

(define-constant CONTRACT-VERSION u1)

;; This pool's proofs live in the SIP-10 verifier's circuit-version namespace.
(define-constant SIP10-CIRCUIT-VERSION u1)

;; Proof types (reused) / fee types (mirror asset-registry & sip10-protocol-fees).
(define-constant PROOF-TYPE-SHIELD u1)
(define-constant PROOF-TYPE-TRANSFER u2)
(define-constant PROOF-TYPE-WITHDRAWAL u3)
(define-constant PROOF-TYPE-SPLIT u4)
(define-constant PROOF-TYPE-MERGE u5)
(define-constant FEE-TYPE-SHIELD u1)
(define-constant FEE-TYPE-TRANSFER u2)
(define-constant FEE-TYPE-WITHDRAWAL u3)
(define-constant FEE-TYPE-SPLIT u4)
(define-constant FEE-TYPE-MERGE u5)

;; Mirror of the frozen registry's emergency-admin role id.
(define-constant REGISTRY-ROLE-EMERGENCY-ADMIN u2)

;; Burn address: never a valid withdrawal recipient.
(define-constant BURN-ADDRESS 'SP000000000000000000002Q6VF78)

;; 16 zero bytes: left-pad a 128-bit Clarity uint to a 32-byte field element.
(define-constant FE-PAD 0x00000000000000000000000000000000)

;; -----------------------------------------------------------------------------
;; ERRORS -- Reserved SIP-10 pool space u450-u499
;; -----------------------------------------------------------------------------

(define-constant ERR-UNAUTHORIZED (err u450))            ;; caller lacks registry owner/role authority
(define-constant ERR-OPERATION-DISABLED (err u451))      ;; per-operation emergency switch is off
(define-constant ERR-STALE-ROOT (err u452))              ;; declared current root != live current root
(define-constant ERR-UNKNOWN-ROOT (err u453))            ;; root not active in the registry
(define-constant ERR-UNKNOWN-ASSET (err u454))           ;; token not registered in asset-registry
(define-constant ERR-ASSET-NOT-SHIELDABLE (err u455))    ;; asset disabled/deprecated: no new shields
(define-constant ERR-AMOUNT-OUT-OF-RANGE (err u456))     ;; amount outside the asset's shield limits
(define-constant ERR-FEE-EXCEEDS-AMOUNT (err u457))      ;; fee would consume the whole withdrawal
(define-constant ERR-INVALID-RECIPIENT (err u458))       ;; burn / pool / fee-manager as recipient
(define-constant ERR-TOKEN-TRANSFER-FAILED (err u459))   ;; underlying SIP-10 transfer failed
(define-constant ERR-TOKEN-TRANSFER-MISMATCH (err u460)) ;; pool balance delta != amount (malicious token)
(define-constant ERR-TOKEN-BALANCE-FAILED (err u461))    ;; token get-balance failed
(define-constant ERR-SWITCH-UNCHANGED (err u462))        ;; operation switch no-op
(define-constant ERR-INSUFFICIENT-SHIELDED (err u463))   ;; withdraw exceeds this asset's shielded total
(define-constant ERR-INVALID-OP (err u464))              ;; unknown op for the switch setter

;; -----------------------------------------------------------------------------
;; STORAGE
;; -----------------------------------------------------------------------------

;; Per-asset shielded total (asset-registry uid -> token base units). The
;; conservation anchor: must always equal this pool's balance of that token.
(define-map shielded-total uint uint)

;; Per-operation emergency switches (proof-type -> enabled). Unset == enabled.
(define-map operation-switches uint bool)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Canonical public-input encoding (identical scheme to privacy-pool)
;; -----------------------------------------------------------------------------

;; uint -> 32-byte big-endian field element.
(define-private (fe-uint (n uint))
  (concat FE-PAD (unwrap-panic (slice? (unwrap-panic (to-consensus-buff? n)) u1 u17)))
)

;; principal -> field element (sha256 over the consensus encoding, top byte 0 so
;; the value is < 2^248 < p). Used for the withdraw recipient AND for asset_id.
(define-private (fe-principal (who principal))
  (concat 0x00 (unwrap-panic (slice? (sha256 (unwrap-panic (to-consensus-buff? who))) u1 u32)))
)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Authority (delegated to the frozen registry)
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
;; PRIVATE -- Root binding (shared registry tree; identical to privacy-pool)
;; -----------------------------------------------------------------------------

(define-private (check-current-root (declared (buff 32)))
  (begin
    (asserts! (is-eq declared (get root (contract-call? .privacy-registry get-current-root))) ERR-STALE-ROOT)
    (asserts! (contract-call? .privacy-registry is-known-root declared) ERR-UNKNOWN-ROOT)
    (ok true)
  )
)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Pool token balance helper (malicious-token defense)
;; -----------------------------------------------------------------------------

(define-private (pool-balance (token <sip-010-trait>))
  (contract-call? token get-balance (as-contract tx-sender))
)

;; -----------------------------------------------------------------------------
;; READ-ONLY
;; -----------------------------------------------------------------------------

(define-read-only (get-shielded-total (asset-uid uint))
  (default-to u0 (map-get? shielded-total asset-uid))
)

(define-read-only (is-operation-enabled (op uint))
  (default-to true (map-get? operation-switches op))
)

(define-read-only (get-pool-contract-version)
  CONTRACT-VERSION
)

(define-read-only (get-pool-info)
  {
    contract-version: CONTRACT-VERSION,
    circuit-version: SIP10-CIRCUIT-VERSION,
    shield-enabled: (is-operation-enabled PROOF-TYPE-SHIELD),
    transfer-enabled: (is-operation-enabled PROOF-TYPE-TRANSFER),
    split-enabled: (is-operation-enabled PROOF-TYPE-SPLIT),
    merge-enabled: (is-operation-enabled PROOF-TYPE-MERGE),
    withdraw-enabled: (is-operation-enabled PROOF-TYPE-WITHDRAWAL),
    protocol-state: (contract-call? .privacy-registry get-protocol-state),
    current-root: (contract-call? .privacy-registry get-current-root),
  }
)

;; =============================================================================
;; PUBLIC -- SHIELD
;; =============================================================================
;; Security invariants: protocol active; shield enabled; asset registered AND
;; shieldable (ACTIVE); amount within the asset's shield limits; declared root is
;; the live current root; proof binds (op, commitment, owner_commitment, amount,
;; asset_id, version); the pool actually RECEIVES `amount` of the token (balance
;; delta asserted, defending against fee-on-transfer / lying tokens); the fee is
;; paid by the user to the fee manager; commitment uniqueness + root advance are
;; enforced by the frozen registry. Returns (ok leaf-index).
(define-public (shield
    (token <sip-010-trait>)
    (amount uint)
    (commitment (buff 32))
    (owner-commitment (buff 32))
    (metadata (buff 32))
    (current-root (buff 32))
    (new-root (buff 32))
    (domain-id uint)
    (aggregation-id uint)
    (merkle-path (list 32 (buff 32)))
    (agg-leaf-index uint)
  )
  (let (
      (token-principal (contract-of token))
      (asset-uid (unwrap! (contract-call? .asset-registry get-asset-id-by-principal (contract-of token)) ERR-UNKNOWN-ASSET))
    )
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (is-operation-enabled PROOF-TYPE-SHIELD) ERR-OPERATION-DISABLED)
    (asserts! (contract-call? .asset-registry can-shield asset-uid) ERR-ASSET-NOT-SHIELDABLE)
    (let (
        (asset (unwrap! (contract-call? .asset-registry get-asset asset-uid) ERR-UNKNOWN-ASSET))
        (asset-fe (fe-principal token-principal))
      )
      (asserts! (and (>= amount (get min-shield asset)) (<= amount (get max-shield asset))) ERR-AMOUNT-OUT-OF-RANGE)
      (try! (check-current-root current-root))
      (let (
          (fee (try! (contract-call? .sip10-protocol-fees calculate-fee asset-uid FEE-TYPE-SHIELD amount)))
          ;; CANONICAL shield public inputs: op, commitment, owner_commitment, amount, asset_id, version
          (inputs-hash (keccak256 (concat
            (concat (concat (fe-uint PROOF-TYPE-SHIELD) commitment) owner-commitment)
            (concat (concat (fe-uint amount) asset-fe) (fe-uint SIP10-CIRCUIT-VERSION)))))
          (bal-before (unwrap! (pool-balance token) ERR-TOKEN-BALANCE-FAILED))
        )
        (try! (contract-call? .sip10-zk-verifier verify-proof
          PROOF-TYPE-SHIELD SIP10-CIRCUIT-VERSION inputs-hash domain-id aggregation-id merkle-path agg-leaf-index))
        ;; pull the deposit into the pool and PROVE it landed
        (unwrap! (contract-call? token transfer amount tx-sender (as-contract tx-sender) none) ERR-TOKEN-TRANSFER-FAILED)
        (asserts! (is-eq (unwrap! (pool-balance token) ERR-TOKEN-BALANCE-FAILED) (+ bal-before amount)) ERR-TOKEN-TRANSFER-MISMATCH)
        ;; fee: user -> fee manager, in the token
        (if (> fee u0) (try! (contract-call? .sip10-protocol-fees collect-fee asset-uid FEE-TYPE-SHIELD fee token)) u0)
        ;; register note + commitment, advance the shared root
        (try! (contract-call? .note-manager register-note commitment owner-commitment metadata (contract-call? .privacy-registry get-note-version)))
        (let ((leaf-index (try! (contract-call? .privacy-registry register-commitment commitment (contract-call? .privacy-registry get-commitment-version)))))
          (try! (contract-call? .privacy-registry update-root new-root (contract-call? .privacy-registry get-root-version)))
          (map-set shielded-total asset-uid (+ (get-shielded-total asset-uid) amount))
          (print { event: "sip10-shielded", asset-id: asset-uid, token: token-principal, commitment: commitment, leaf-index: leaf-index, amount: amount, fee: fee, new-root: new-root, height: stacks-block-height })
          (ok leaf-index)
        )
      )
    )
  )
)

;; =============================================================================
;; PUBLIC -- PRIVATE TRANSFER
;; =============================================================================
;; Consumes `nullifier` and creates `new-commitment` for a hidden recipient; no
;; tokens move (a flat transfer fee is paid transparently by tx-sender). Proof
;; binds (op, nullifier, new_commitment, new_owner_commitment, merkle_root,
;; asset_id, version). Nullifier registration first (double-spend/replay).
;; Returns (ok leaf-index).
(define-public (transfer
    (token <sip-010-trait>)
    (nullifier (buff 32))
    (new-commitment (buff 32))
    (new-owner-commitment (buff 32))
    (new-metadata (buff 32))
    (current-root (buff 32))
    (new-root (buff 32))
    (domain-id uint)
    (aggregation-id uint)
    (merkle-path (list 32 (buff 32)))
    (agg-leaf-index uint)
  )
  (let (
      (asset-uid (unwrap! (contract-call? .asset-registry get-asset-id-by-principal (contract-of token)) ERR-UNKNOWN-ASSET))
    )
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (is-operation-enabled PROOF-TYPE-TRANSFER) ERR-OPERATION-DISABLED)
    ;; spend of an existing note is allowed for any KNOWN asset (never trap funds)
    (asserts! (contract-call? .asset-registry can-spend asset-uid) ERR-UNKNOWN-ASSET)
    (try! (check-current-root current-root))
    (let (
        (asset-fe (fe-principal (contract-of token)))
        (fee (try! (contract-call? .sip10-protocol-fees calculate-fee asset-uid FEE-TYPE-TRANSFER u0)))
        ;; CANONICAL transfer public inputs: op, nullifier, new_commitment, new_owner_commitment, merkle_root, asset_id, version
        (inputs-hash (keccak256 (concat
          (concat (concat (concat (fe-uint PROOF-TYPE-TRANSFER) nullifier) new-commitment) new-owner-commitment)
          (concat (concat current-root asset-fe) (fe-uint SIP10-CIRCUIT-VERSION)))))
      )
      (try! (contract-call? .sip10-zk-verifier verify-proof
        PROOF-TYPE-TRANSFER SIP10-CIRCUIT-VERSION inputs-hash domain-id aggregation-id merkle-path agg-leaf-index))
      (if (> fee u0) (try! (contract-call? .sip10-protocol-fees collect-fee asset-uid FEE-TYPE-TRANSFER fee token)) u0)
      (try! (contract-call? .privacy-registry register-nullifier nullifier))
      (let ((leaf-index (try! (contract-call? .privacy-registry register-commitment new-commitment (contract-call? .privacy-registry get-commitment-version)))))
        (try! (contract-call? .note-manager register-note new-commitment new-owner-commitment new-metadata (contract-call? .privacy-registry get-note-version)))
        (try! (contract-call? .privacy-registry update-root new-root (contract-call? .privacy-registry get-root-version)))
        (print { event: "sip10-transferred", asset-id: asset-uid, nullifier: nullifier, new-commitment: new-commitment, leaf-index: leaf-index, fee: fee, new-root: new-root, height: stacks-block-height })
        (ok leaf-index)
      )
    )
  )
)

;; =============================================================================
;; PUBLIC -- SPLIT (1 note -> 2 notes)
;; =============================================================================
;; Proof binds (op, nullifier, commitment_1, owner_commitment_1, commitment_2,
;; owner_commitment_2, merkle_root, asset_id, version). No tokens move; a flat
;; split fee is paid by tx-sender. Returns (ok { leaf-1, leaf-2 }).
(define-public (split
    (token <sip-010-trait>)
    (nullifier (buff 32))
    (commitment-1 (buff 32))
    (owner-commitment-1 (buff 32))
    (metadata-1 (buff 32))
    (commitment-2 (buff 32))
    (owner-commitment-2 (buff 32))
    (metadata-2 (buff 32))
    (current-root (buff 32))
    (new-root (buff 32))
    (domain-id uint)
    (aggregation-id uint)
    (merkle-path (list 32 (buff 32)))
    (agg-leaf-index uint)
  )
  (let (
      (asset-uid (unwrap! (contract-call? .asset-registry get-asset-id-by-principal (contract-of token)) ERR-UNKNOWN-ASSET))
    )
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (is-operation-enabled PROOF-TYPE-SPLIT) ERR-OPERATION-DISABLED)
    (asserts! (contract-call? .asset-registry can-spend asset-uid) ERR-UNKNOWN-ASSET)
    (try! (check-current-root current-root))
    (let (
        (asset-fe (fe-principal (contract-of token)))
        (fee (try! (contract-call? .sip10-protocol-fees calculate-fee asset-uid FEE-TYPE-SPLIT u0)))
        ;; CANONICAL split public inputs: op, nullifier, commitment_1, owner_commitment_1, commitment_2, owner_commitment_2, merkle_root, asset_id, version
        (inputs-hash (keccak256 (concat
          (concat (concat (concat (concat (concat (fe-uint PROOF-TYPE-SPLIT) nullifier) commitment-1) owner-commitment-1) commitment-2) owner-commitment-2)
          (concat (concat current-root asset-fe) (fe-uint SIP10-CIRCUIT-VERSION)))))
      )
      (try! (contract-call? .sip10-zk-verifier verify-proof
        PROOF-TYPE-SPLIT SIP10-CIRCUIT-VERSION inputs-hash domain-id aggregation-id merkle-path agg-leaf-index))
      (if (> fee u0) (try! (contract-call? .sip10-protocol-fees collect-fee asset-uid FEE-TYPE-SPLIT fee token)) u0)
      (try! (contract-call? .privacy-registry register-nullifier nullifier))
      (let (
          (leaf-1 (try! (contract-call? .privacy-registry register-commitment commitment-1 (contract-call? .privacy-registry get-commitment-version))))
          (leaf-2 (try! (contract-call? .privacy-registry register-commitment commitment-2 (contract-call? .privacy-registry get-commitment-version))))
        )
        (try! (contract-call? .note-manager register-note commitment-1 owner-commitment-1 metadata-1 (contract-call? .privacy-registry get-note-version)))
        (try! (contract-call? .note-manager register-note commitment-2 owner-commitment-2 metadata-2 (contract-call? .privacy-registry get-note-version)))
        (try! (contract-call? .privacy-registry update-root new-root (contract-call? .privacy-registry get-root-version)))
        (print { event: "sip10-split", asset-id: asset-uid, nullifier: nullifier, leaf-1: leaf-1, leaf-2: leaf-2, fee: fee, new-root: new-root, height: stacks-block-height })
        (ok { leaf-1: leaf-1, leaf-2: leaf-2 })
      )
    )
  )
)

;; =============================================================================
;; PUBLIC -- MERGE (2 notes -> 1 note)
;; =============================================================================
;; Proof binds (op, nullifier_1, nullifier_2, commitment, owner_commitment,
;; merkle_root, asset_id, version). No tokens move; a flat merge fee is paid by
;; tx-sender. Returns (ok leaf-index).
;; Named `merge-notes` because `merge` is a Clarity built-in (tuple merge).
(define-public (merge-notes
    (token <sip-010-trait>)
    (nullifier-1 (buff 32))
    (nullifier-2 (buff 32))
    (commitment (buff 32))
    (owner-commitment (buff 32))
    (metadata (buff 32))
    (current-root (buff 32))
    (new-root (buff 32))
    (domain-id uint)
    (aggregation-id uint)
    (merkle-path (list 32 (buff 32)))
    (agg-leaf-index uint)
  )
  (let (
      (asset-uid (unwrap! (contract-call? .asset-registry get-asset-id-by-principal (contract-of token)) ERR-UNKNOWN-ASSET))
    )
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (is-operation-enabled PROOF-TYPE-MERGE) ERR-OPERATION-DISABLED)
    (asserts! (contract-call? .asset-registry can-spend asset-uid) ERR-UNKNOWN-ASSET)
    (try! (check-current-root current-root))
    (let (
        (asset-fe (fe-principal (contract-of token)))
        (fee (try! (contract-call? .sip10-protocol-fees calculate-fee asset-uid FEE-TYPE-MERGE u0)))
        ;; CANONICAL merge public inputs: op, nullifier_1, nullifier_2, commitment, owner_commitment, merkle_root, asset_id, version
        (inputs-hash (keccak256 (concat
          (concat (concat (concat (concat (fe-uint PROOF-TYPE-MERGE) nullifier-1) nullifier-2) commitment) owner-commitment)
          (concat (concat current-root asset-fe) (fe-uint SIP10-CIRCUIT-VERSION)))))
      )
      (try! (contract-call? .sip10-zk-verifier verify-proof
        PROOF-TYPE-MERGE SIP10-CIRCUIT-VERSION inputs-hash domain-id aggregation-id merkle-path agg-leaf-index))
      (if (> fee u0) (try! (contract-call? .sip10-protocol-fees collect-fee asset-uid FEE-TYPE-MERGE fee token)) u0)
      (try! (contract-call? .privacy-registry register-nullifier nullifier-1))
      (try! (contract-call? .privacy-registry register-nullifier nullifier-2))
      (let ((leaf-index (try! (contract-call? .privacy-registry register-commitment commitment (contract-call? .privacy-registry get-commitment-version)))))
        (try! (contract-call? .note-manager register-note commitment owner-commitment metadata (contract-call? .privacy-registry get-note-version)))
        (try! (contract-call? .privacy-registry update-root new-root (contract-call? .privacy-registry get-root-version)))
        (print { event: "sip10-merged", asset-id: asset-uid, nullifier-1: nullifier-1, nullifier-2: nullifier-2, commitment: commitment, leaf-index: leaf-index, fee: fee, new-root: new-root, height: stacks-block-height })
        (ok leaf-index)
      )
    )
  )
)

;; =============================================================================
;; PUBLIC -- WITHDRAWAL
;; =============================================================================
;; Consumes a note (nullifier) and pays `amount` of the token out: fee to the fee
;; manager, net to `recipient`, both from the pool -- so pool balance and this
;; asset's shielded total each decrease by exactly `amount`. Accepts any KNOWN
;; root (adds no leaf). Proof binds (op, nullifier, amount, recipient_hash,
;; merkle_root, asset_id, version). Returns (ok net-amount).
(define-public (withdraw
    (token <sip-010-trait>)
    (nullifier (buff 32))
    (amount uint)
    (recipient principal)
    (root (buff 32))
    (domain-id uint)
    (aggregation-id uint)
    (merkle-path (list 32 (buff 32)))
    (agg-leaf-index uint)
  )
  (let (
      (asset-uid (unwrap! (contract-call? .asset-registry get-asset-id-by-principal (contract-of token)) ERR-UNKNOWN-ASSET))
    )
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (is-operation-enabled PROOF-TYPE-WITHDRAWAL) ERR-OPERATION-DISABLED)
    (asserts! (contract-call? .asset-registry can-spend asset-uid) ERR-UNKNOWN-ASSET)
    (asserts! (contract-call? .privacy-registry is-known-root root) ERR-UNKNOWN-ROOT)
    (asserts!
      (and
        (not (is-eq recipient BURN-ADDRESS))
        (not (is-eq recipient (as-contract tx-sender)))
        (not (is-eq recipient .sip10-protocol-fees))
      )
      ERR-INVALID-RECIPIENT
    )
    (let (
        (asset-fe (fe-principal (contract-of token)))
        (fee (try! (contract-call? .sip10-protocol-fees calculate-fee asset-uid FEE-TYPE-WITHDRAWAL amount)))
        ;; CANONICAL withdraw public inputs: op, nullifier, amount, recipient_hash, merkle_root, asset_id, version
        (inputs-hash (keccak256 (concat
          (concat (concat (concat (fe-uint PROOF-TYPE-WITHDRAWAL) nullifier) (fe-uint amount)) (fe-principal recipient))
          (concat (concat root asset-fe) (fe-uint SIP10-CIRCUIT-VERSION)))))
        (bal-before (unwrap! (pool-balance token) ERR-TOKEN-BALANCE-FAILED))
      )
      (asserts! (< fee amount) ERR-FEE-EXCEEDS-AMOUNT)
      ;; accounting gate BEFORE any token moves: cannot withdraw more than this
      ;; asset holds. With the conservation invariant, passing this guarantees
      ;; the pool has the tokens.
      (asserts! (<= amount (get-shielded-total asset-uid)) ERR-INSUFFICIENT-SHIELDED)
      (try! (contract-call? .sip10-zk-verifier verify-proof
        PROOF-TYPE-WITHDRAWAL SIP10-CIRCUIT-VERSION inputs-hash domain-id aggregation-id merkle-path agg-leaf-index))
      (try! (contract-call? .privacy-registry register-nullifier nullifier))
      (map-set shielded-total asset-uid (- (get-shielded-total asset-uid) amount))
      ;; fee out of the withdrawn amount, pool -> fee manager (token)
      (if (> fee u0) (try! (as-contract (contract-call? .sip10-protocol-fees collect-fee asset-uid FEE-TYPE-WITHDRAWAL fee token))) u0)
      ;; remainder to the recipient, pool -> recipient (token)
      (unwrap! (as-contract (contract-call? token transfer (- amount fee) tx-sender recipient none)) ERR-TOKEN-TRANSFER-FAILED)
      ;; PROVE the pool paid out exactly `amount` (fee + net); defends against
      ;; a lying token that reports success without moving value.
      (asserts! (is-eq (unwrap! (pool-balance token) ERR-TOKEN-BALANCE-FAILED) (- bal-before amount)) ERR-TOKEN-TRANSFER-MISMATCH)
      (print { event: "sip10-withdrawn", asset-id: asset-uid, nullifier: nullifier, amount: amount, fee: fee, recipient: recipient, height: stacks-block-height })
      (ok (- amount fee))
    )
  )
)

;; =============================================================================
;; PUBLIC -- Emergency operation switches (emergency admin or owner)
;; =============================================================================

(define-public (set-operation-enabled (op uint) (enabled bool))
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts!
      (or (is-eq op PROOF-TYPE-SHIELD) (is-eq op PROOF-TYPE-TRANSFER)
          (is-eq op PROOF-TYPE-SPLIT) (is-eq op PROOF-TYPE-MERGE)
          (is-eq op PROOF-TYPE-WITHDRAWAL))
      ERR-INVALID-OP
    )
    (asserts! (not (is-eq (is-operation-enabled op) enabled)) ERR-SWITCH-UNCHANGED)
    (map-set operation-switches op enabled)
    (print { event: "sip10-operation-switch", op: op, enabled: enabled, height: stacks-block-height })
    (ok true)
  )
)
