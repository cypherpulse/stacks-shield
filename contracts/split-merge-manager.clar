;; =============================================================================
;; split-merge-manager.clar
;; =============================================================================
;; STX Shield -- Split & Merge Manager (v1.0.0)
;;
;; Private note reshaping. Two operations that change the SHAPE of a user's
;; shielded holdings without changing their total value and without moving any
;; STX in or out of the pool:
;;
;;   split  1 note  -> 2 notes   (e.g. 100 STX -> 40 STX + 60 STX)
;;   merge  2 notes -> 1 note    (e.g. 40 STX + 60 STX -> 100 STX)
;;
;; Value conservation is proven in-circuit (the Noir split/merge circuits
;; prove sum(inputs) == sum(outputs)); on-chain, no STX moves, so the
;; protocol's core invariant -- pool balance == registry total-shielded-stx --
;; is preserved trivially by construction.
;;
;; Like privacy-pool, this contract owns no authoritative protocol state. It
;; delegates every authority and protocol-state decision to the FROZEN
;; privacy-registry v1.0.0 and orchestrates the frozen layers:
;;   registry     commitments, nullifiers, roots, protocol state, versions
;;   note-manager note lifecycle
;;   zk-verifier  SPLIT / MERGE proof acceptance (attestation committee)
;;   protocol-fees the flat reshaping fee (charged as the TRANSFER fee type,
;;                 since split/merge move no STX -- amounts are hidden, so a
;;                 percentage is uncomputable)
;;
;; This contract must be an authorized caller in BOTH the registry and
;; note-manager (owner adds it at integration time), exactly like privacy-pool.
;;
;; PROOF BINDING. As in privacy-pool, the public-inputs hash is computed from
;; the operation's exact parameters and the attestation committee's signatures
;; bind the proof to it, so a proof authorizes exactly one split/merge with
;; exactly these commitments, nullifiers, and roots -- no substitution, no
;; replay (verifier proof-id registry + registry nullifiers).
;;
;; Error space: u350-u399 (reserved for integration errors across the protocol).
;; Errors from the frozen layers pass through unchanged.
;; =============================================================================

;; -----------------------------------------------------------------------------
;; CONSTANTS
;; -----------------------------------------------------------------------------

(define-constant CONTRACT-VERSION u1)

;; Mirrors of frozen zk-verifier proof types and protocol-fees fee type.
(define-constant PROOF-TYPE-SPLIT u4)
(define-constant PROOF-TYPE-MERGE u5)
(define-constant FEE-TYPE-TRANSFER u2)

;; Mirror of the frozen registry's emergency-admin role id.
(define-constant REGISTRY-ROLE-EMERGENCY-ADMIN u2)

;; The all-zero hash is never a valid commitment, nullifier, or note id.
(define-constant ZERO-HASH 0x0000000000000000000000000000000000000000000000000000000000000000)

;; -----------------------------------------------------------------------------
;; ERRORS -- Reserved integration space u350-u399
;; -----------------------------------------------------------------------------

(define-constant ERR-UNAUTHORIZED (err u350))          ;; caller lacks registry owner/role authority
(define-constant ERR-OPERATION-DISABLED (err u351))    ;; per-operation emergency switch is off
(define-constant ERR-STALE-ROOT (err u352))            ;; declared current root != live current root
(define-constant ERR-UNKNOWN-ROOT (err u353))          ;; declared root not active in the registry
(define-constant ERR-INVALID-INPUT (err u354))         ;; zero-valued commitment / nullifier / note id
(define-constant ERR-DUPLICATE-INPUT (err u355))       ;; the two merge inputs are the same note/nullifier
(define-constant ERR-DUPLICATE-OUTPUT (err u356))      ;; the two split outputs collide
(define-constant ERR-SWITCH-UNCHANGED (err u357))      ;; operation switch no-op

;; -----------------------------------------------------------------------------
;; STORAGE -- Emergency operation switches
;; -----------------------------------------------------------------------------
;; Granular kill switches, controlled by the registry emergency admin or owner,
;; effective in ANY protocol state, composing with (never replacing) the
;; registry state machine.

(define-data-var split-enabled bool true)
(define-data-var merge-enabled bool true)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Canonical public-input encoding
;; ---------------------------------------------------------------------------
;; Identical rules to privacy-pool: keccak256 over the circuit's public input
;; field elements, 32 bytes big-endian, in declaration order, and nothing the
;; circuit does not take.

(define-constant FE-PAD 0x00000000000000000000000000000000)

(define-private (fe-uint (n uint))
  (concat FE-PAD
    (unwrap-panic (slice? (unwrap-panic (to-consensus-buff? n)) u1 u17))
  )
)

;; ---------------------------------------------------------------------------
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

;; Tree-extending operations must present the live current root, and it must
;; still be active (a deactivated current root is the registry's tree-level
;; kill switch and must halt insertions here).
(define-private (check-current-root (declared (buff 32)))
  (begin
    (asserts!
      (is-eq declared (get root (contract-call? .privacy-registry get-current-root)))
      ERR-STALE-ROOT
    )
    (asserts! (contract-call? .privacy-registry is-known-root declared) ERR-UNKNOWN-ROOT)
    (ok true)
  )
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Status
;; -----------------------------------------------------------------------------

(define-read-only (is-split-enabled)
  (var-get split-enabled)
)

(define-read-only (is-merge-enabled)
  (var-get merge-enabled)
)

(define-read-only (get-manager-version)
  CONTRACT-VERSION
)

;; One-read snapshot for the SDK.
(define-read-only (get-manager-info)
  {
    contract-version: CONTRACT-VERSION,
    split-enabled: (var-get split-enabled),
    merge-enabled: (var-get merge-enabled),
    protocol-state: (contract-call? .privacy-registry get-protocol-state),
    current-root: (contract-call? .privacy-registry get-current-root),
  }
)

;; =============================================================================
;; PUBLIC -- SPLIT (1 note -> 2 notes)
;; =============================================================================
;;
;; Consumes `old-note-id` (nullifier registered, note spent) and creates two
;; new notes/commitments for the (possibly different) hidden recipients. The
;; new root reflects both insertions. A flat reshaping fee is paid
;; transparently by tx-sender.
;;
;; Registers: 2 commitments, 1 nullifier, 2 notes, 1 new root.
;; Returns (ok { leaf-1, leaf-2 }): the two zero-based leaf indices.
;;
;; (Named `split-note` because `split` reads more clearly paired with
;; `merge-notes`; the SDK exposes it as `split()`.)
(define-public (split-note
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
  (begin
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (var-get split-enabled) ERR-OPERATION-DISABLED)
    (asserts!
      (and
        (not (is-eq nullifier ZERO-HASH))
        (not (is-eq commitment-1 ZERO-HASH))
        (not (is-eq commitment-2 ZERO-HASH))
      )
      ERR-INVALID-INPUT
    )
    ;; the two outputs must be distinct commitments (the second register-commitment
    ;; would fail anyway, but fail early with a precise error)
    (asserts! (not (is-eq commitment-1 commitment-2)) ERR-DUPLICATE-OUTPUT)
    (try! (check-current-root current-root))
    (let (
        (fee (try! (contract-call? .protocol-fees calculate-fee FEE-TYPE-TRANSFER u0)))
        ;; CANONICAL: the split circuit's public inputs, in order.
        ;; metadata-1 / metadata-2 / new-root are contract-level only.
        (inputs-hash (keccak256 (concat
          (concat (concat (fe-uint PROOF-TYPE-SPLIT) nullifier)
                  (concat commitment-1 owner-commitment-1))
          (concat (concat commitment-2 owner-commitment-2)
                  (concat current-root
                          (fe-uint (contract-call? .privacy-registry get-circuit-version))))
        )))
      )
      (try! (contract-call? .zk-verifier verify-proof
        PROOF-TYPE-SPLIT
        (contract-call? .privacy-registry get-circuit-version)
        inputs-hash
        domain-id
        aggregation-id
        merkle-path
        agg-leaf-index
      ))
      ;; flat reshaping fee, transparent, tx-sender -> treasury
      (if (> fee u0)
        (try! (contract-call? .protocol-fees collect-fee FEE-TYPE-TRANSFER fee))
        u0
      )
      ;; double-spend / replay protection, then consume the input note
      (try! (contract-call? .privacy-registry register-nullifier nullifier))
      ;; create the two output notes + commitments
      (let (
          (leaf-1 (try! (contract-call? .privacy-registry register-commitment
            commitment-1 (contract-call? .privacy-registry get-commitment-version)
          )))
        )
        (try! (contract-call? .note-manager register-note
          commitment-1 owner-commitment-1 metadata-1
          (contract-call? .privacy-registry get-note-version)
        ))
        (let (
            (leaf-2 (try! (contract-call? .privacy-registry register-commitment
              commitment-2 (contract-call? .privacy-registry get-commitment-version)
            )))
          )
          (try! (contract-call? .note-manager register-note
            commitment-2 owner-commitment-2 metadata-2
            (contract-call? .privacy-registry get-note-version)
          ))
          (try! (contract-call? .privacy-registry update-root
            new-root (contract-call? .privacy-registry get-root-version)
          ))
          (print {
            event: "note-split",
              nullifier: nullifier,
            commitment-1: commitment-1,
            commitment-2: commitment-2,
            leaf-1: leaf-1,
            leaf-2: leaf-2,
            fee: fee,
            new-root: new-root,
            height: stacks-block-height,
          })
          (ok { leaf-1: leaf-1, leaf-2: leaf-2 })
        )
      )
    )
  )
)

;; =============================================================================
;; PUBLIC -- MERGE (2 notes -> 1 note)
;; =============================================================================
;;
;; Consumes two distinct notes (two nullifiers registered, both notes spent)
;; and creates one new note/commitment for the hidden recipient. The new root
;; reflects the single insertion. A flat reshaping fee is paid transparently.
;;
;; Registers: 1 commitment, 2 nullifiers, 1 note, 1 new root.
;; Returns (ok leaf-index) of the merged commitment.
;;
;; (Named `merge-notes` because `merge` is a Clarity built-in for tuples and
;; cannot be a public function name; the SDK exposes it as `merge()`.)
(define-public (merge-notes
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
  (begin
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (var-get merge-enabled) ERR-OPERATION-DISABLED)
    (asserts!
      (and
        (not (is-eq nullifier-1 ZERO-HASH))
        (not (is-eq nullifier-2 ZERO-HASH))
        (not (is-eq commitment ZERO-HASH))
      )
      ERR-INVALID-INPUT
    )
    ;; The two inputs must be genuinely distinct. Note ids are private, so
    ;; distinctness is enforced on the nullifiers -- which is exactly the
    ;; right check: the circuit already proves each nullifier derives from a
    ;; distinct committed note, and the registry rejects any duplicate.
    (asserts! (not (is-eq nullifier-1 nullifier-2)) ERR-DUPLICATE-INPUT)
    (try! (check-current-root current-root))
    (let (
        (fee (try! (contract-call? .protocol-fees calculate-fee FEE-TYPE-TRANSFER u0)))
        ;; CANONICAL: the merge circuit's public inputs, in order.
        (inputs-hash (keccak256 (concat
          (concat (concat (fe-uint PROOF-TYPE-MERGE) nullifier-1) nullifier-2)
          (concat (concat commitment owner-commitment)
                  (concat current-root
                          (fe-uint (contract-call? .privacy-registry get-circuit-version))))
        )))
      )
      (try! (contract-call? .zk-verifier verify-proof
        PROOF-TYPE-MERGE
        (contract-call? .privacy-registry get-circuit-version)
        inputs-hash
        domain-id
        aggregation-id
        merkle-path
        agg-leaf-index
      ))
      (if (> fee u0)
        (try! (contract-call? .protocol-fees collect-fee FEE-TYPE-TRANSFER fee))
        u0
      )
      ;; consume both input notes: two nullifiers, two spends
      (try! (contract-call? .privacy-registry register-nullifier nullifier-1))
      (try! (contract-call? .privacy-registry register-nullifier nullifier-2))
      ;; create the single merged output
      (let (
          (leaf-index (try! (contract-call? .privacy-registry register-commitment
            commitment (contract-call? .privacy-registry get-commitment-version)
          )))
        )
        (try! (contract-call? .note-manager register-note
          commitment owner-commitment metadata
          (contract-call? .privacy-registry get-note-version)
        ))
        (try! (contract-call? .privacy-registry update-root
          new-root (contract-call? .privacy-registry get-root-version)
        ))
        (print {
          event: "note-merge",
          nullifier-1: nullifier-1,
          nullifier-2: nullifier-2,
          commitment: commitment,
          leaf-index: leaf-index,
          fee: fee,
          new-root: new-root,
          height: stacks-block-height,
        })
        (ok leaf-index)
      )
    )
  )
)

;; =============================================================================
;; PUBLIC -- Emergency operation switches (emergency admin or owner)
;; =============================================================================

(define-public (set-split-enabled (enabled bool))
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq (var-get split-enabled) enabled)) ERR-SWITCH-UNCHANGED)
    (var-set split-enabled enabled)
    (print { event: "split-switch", enabled: enabled, height: stacks-block-height })
    (ok true)
  )
)

(define-public (set-merge-enabled (enabled bool))
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq (var-get merge-enabled) enabled)) ERR-SWITCH-UNCHANGED)
    (var-set merge-enabled enabled)
    (print { event: "merge-switch", enabled: enabled, height: stacks-block-height })
    (ok true)
  )
)
