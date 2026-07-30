;; =============================================================================
;; STX Shield -- zk-verifier
;; =============================================================================
;; Proof acceptance for the STX Shield protocol.
;;
;; PHASE 6 MIGRATION -- the attestation committee has been REMOVED.
;;
;; Previously this contract counted M-of-N secp256k1 signatures from an
;; enrolled committee. That made every user operation depend on committee
;; participation: a valid proof could be refused, and the committee could
;; approve an operation whose "proof" was arbitrary bytes, because the proof
;; was never examined.
;;
;; Proofs are now verified by zkVerify, an independent proof-verification L1
;; that natively supports UltraHonk proofs produced by Noir/Barretenberg.
;; zkVerify verifies each proof in its own consensus and aggregates verified
;; statements into a binary Merkle tree; the root of that tree is published
;; here. A user proves their statement was verified by supplying a Merkle
;; inclusion path against a published root.
;;
;;   user proof -> zkVerify (UltraHonk verified) -> aggregation root
;;              -> published here -> user submits inclusion path -> accepted
;;
;; What this changes for users:
;;   * No signature, approval, threshold, or committee member is involved in
;;     any user transaction. Anyone holding an inclusion path against a
;;     published root can transact.
;;   * The proof bytes are no longer submitted on chain at all. The chain
;;     checks a 32-byte leaf and a Merkle path, not a 16 KiB proof.
;;
;; Trust model, stated plainly:
;;   Aggregation roots are published by a relayer. A relayer is a LIVENESS
;;   dependency for publishing roots -- it cannot approve or reject any
;;   individual user transaction, and it cannot make one user's proof valid
;;   and another's invalid. Root publication is protocol-level plumbing, not
;;   per-transaction approval. Soundness rests on zkVerify's verification of
;;   the proof, not on the relayer.
;;
;; Everything else is unchanged: the immutable vkey registry, per-statement
;; replay protection, the verification freeze, statistics, and the fully
;; delegated authority model (all roles live in the frozen privacy-registry).
;; =============================================================================

;; -----------------------------------------------------------------------------
;; CONSTANTS -- Proof types (mirrors of the protocol's operation set)
;; -----------------------------------------------------------------------------

(define-constant PROOF-TYPE-SHIELD u1)
(define-constant PROOF-TYPE-TRANSFER u2)
(define-constant PROOF-TYPE-WITHDRAWAL u3)
(define-constant PROOF-TYPE-SPLIT u4)
(define-constant PROOF-TYPE-MERGE u5)

;; -----------------------------------------------------------------------------
;; CONSTANTS -- Identity and limits
;; -----------------------------------------------------------------------------

(define-constant CONTRACT-VERSION u2)

;; Hard cap on registered proof sizes; UltraHonk proofs are ~14-16 KiB. Kept
;; for vkey registration validation even though proof bytes no longer reach
;; the chain.
(define-constant MAX-PROOF-LENGTH u16384)

;; Merkle inclusion bounds. zkVerify aggregation trees are far smaller than
;; 2^32 leaves; 32 is a generous ceiling on path length.
(define-constant MAX-MERKLE-DEPTH u32)

;; Mirrors of the frozen registry's role ids (stable public API).
(define-constant REGISTRY-ROLE-EMERGENCY-ADMIN u2)
(define-constant REGISTRY-ROLE-VERIFIER-ADMIN u3)

;; The all-zero hash is never a valid vkey hash, leaf, root, or inputs hash.
(define-constant ZERO-HASH 0x0000000000000000000000000000000000000000000000000000000000000000)

;; -----------------------------------------------------------------------------
;; ERRORS -- Reserved verifier space u300-u349
;; -----------------------------------------------------------------------------

(define-constant ERR-UNAUTHORIZED (err u300))            ;; caller lacks registry owner/role authority
(define-constant ERR-UNAUTHORIZED-CALLER (err u301))     ;; contract-caller not on the registry allowlist
(define-constant ERR-VERIFICATION-FROZEN (err u302))     ;; verification is frozen
(define-constant ERR-UNKNOWN-PROOF-TYPE (err u303))      ;; proof type outside the defined set
(define-constant ERR-VKEY-NOT-FOUND (err u304))          ;; no vkey for (type, circuit version)
(define-constant ERR-VKEY-DISABLED (err u305))           ;; vkey kill-switched
(define-constant ERR-VKEY-EXISTS (err u306))             ;; vkey already registered (immutable)
(define-constant ERR-INVALID-PROOF-LENGTH (err u307))    ;; registered proof length out of range
(define-constant ERR-INVALID-PUBLIC-INPUTS (err u308))   ;; zero public-inputs hash
(define-constant ERR-PROOF-ALREADY-VERIFIED (err u309))  ;; statement replay
(define-constant ERR-PROOF-NOT-AGGREGATED (err u310))    ;; Merkle inclusion check failed
(define-constant ERR-AGGREGATION-NOT-FOUND (err u311))   ;; no root for (domain, aggregation)
(define-constant ERR-AGGREGATION-EXISTS (err u312))      ;; aggregation root already published (immutable)
(define-constant ERR-INVALID-AGGREGATION (err u313))     ;; zero root, or empty tree
(define-constant ERR-INVALID-VKEY (err u314))            ;; zero vkey hash or bad proof length
(define-constant ERR-VERSION-MISMATCH (err u315))        ;; circuit version != registry's current
(define-constant ERR-INVALID-LEAF-INDEX (err u316))      ;; leaf index outside the tree
(define-constant ERR-VKEY-STATUS-UNCHANGED (err u317))   ;; enable/disable no-op
(define-constant ERR-RELAYER-EXISTS (err u318))          ;; relayer already registered
(define-constant ERR-RELAYER-NOT-FOUND (err u319))       ;; relayer not registered
(define-constant ERR-BINDING-NOT-SET (err u320))         ;; zkVerify binding unconfigured for this circuit
(define-constant ERR-INVALID-BINDING (err u321))         ;; zero context, vk, or version hash

;; -----------------------------------------------------------------------------
;; STORAGE -- Verification keys
;; -----------------------------------------------------------------------------

;; One immutable record per (proof type, circuit version): the hash of the
;; Barretenberg verification key REGISTERED WITH zkVerify for this circuit,
;; and the proof byte length the circuit produces. A wrong registration is
;; corrected by advancing the circuit version, never by mutation.
;;
;; `vkey-hash` is the binding between an on-chain operation and a zkVerify
;; statement: the aggregation leaf commits to it, so a proof verified against
;; a different circuit can never be replayed into this protocol.
(define-map verification-keys
  { proof-type: uint, circuit-version: uint }
  {
    vkey-hash: (buff 32),
    proof-length: uint,
    enabled: bool,
    registered-at: uint,
  }
)

;; -----------------------------------------------------------------------------
;; STORAGE -- zkVerify aggregation roots
;; -----------------------------------------------------------------------------

;; Published aggregation roots, keyed exactly as zkVerify keys them:
;; (domain id, aggregation id) -> Merkle root. Append-only and immutable --
;; a published root can never be altered or withdrawn, so an inclusion path
;; that verifies today verifies forever.
(define-map aggregations
  { domain-id: uint, aggregation-id: uint }
  {
    root: (buff 32),
    leaf-count: uint,
    posted-at: uint,
    posted-by: principal,
  }
)

(define-data-var aggregation-count uint u0)

;; -----------------------------------------------------------------------------
;; STORAGE -- zkVerify statement binding (configuration, not code)
;; -----------------------------------------------------------------------------

;; keccak256(verifier_ctx) for the UltraHonk pallet. One value for the whole
;; verifier; set once from the live network.
(define-data-var zkverify-context-hash (buff 32) 0x)

;; Per (proof-type, circuit-version): the vk hash zkVerify assigns at
;; registration (from its VkRegistered event) and the proof version hash.
;; Both are observed from zkVerify, never derived locally.
(define-map zkverify-bindings
  { proof-type: uint, circuit-version: uint }
  {
    zkv-vkey-hash: (buff 32),
    version-hash: (buff 32),
    set-at: uint,
  }
)

;; Principals permitted to publish aggregation roots. Managed by the verifier
;; admin so a hot relayer key is never the admin key. A relayer can only
;; publish roots; it has no power over any individual user transaction.
(define-map aggregation-relayers principal { enabled: bool, added-at: uint })

(define-data-var relayer-count uint u0)

;; -----------------------------------------------------------------------------
;; STORAGE -- Accepted statements (replay protection) and statistics
;; -----------------------------------------------------------------------------

;; Append-only: statement leaf -> acceptance record. The leaf commits to the
;; vkey and the public inputs, so one verified statement can be spent exactly
;; once regardless of how many aggregations contain it.
(define-map verified-proofs
  (buff 32)
  { proof-type: uint, verified-at: uint }
)

(define-data-var verification-stats
  { total-verified: uint, shield: uint, transfer: uint, withdrawal: uint, other: uint }
  { total-verified: u0, shield: u0, transfer: u0, withdrawal: u0, other: u0 }
)

;; When true, verify-proof rejects everything.
(define-data-var verification-frozen bool false)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Authority (fully delegated to the frozen registry)
;; -----------------------------------------------------------------------------

(define-private (is-registry-owner (who principal))
  (is-eq who (contract-call? .privacy-registry get-owner))
)

(define-private (is-verifier-admin (who principal))
  (or
    (is-registry-owner who)
    (contract-call? .privacy-registry has-role who REGISTRY-ROLE-VERIFIER-ADMIN)
  )
)

(define-private (is-emergency-admin (who principal))
  (or
    (is-registry-owner who)
    (contract-call? .privacy-registry has-role who REGISTRY-ROLE-EMERGENCY-ADMIN)
  )
)

;; vkey status may be toggled by verifier admin (operations), emergency admin
;; (incident response), or owner.
(define-private (is-vkey-controller (who principal))
  (or (is-verifier-admin who) (is-emergency-admin who))
)

(define-private (is-authorized-protocol-caller (who principal))
  (contract-call? .privacy-registry is-authorized-caller who)
)

(define-private (is-relayer (who principal))
  (or
    (is-verifier-admin who)
    (default-to false (get enabled (map-get? aggregation-relayers who)))
  )
)

(define-private (is-valid-proof-type (proof-type uint))
  (or
    (is-eq proof-type PROOF-TYPE-SHIELD)
    (is-eq proof-type PROOF-TYPE-TRANSFER)
    (is-eq proof-type PROOF-TYPE-WITHDRAWAL)
    (is-eq proof-type PROOF-TYPE-SPLIT)
    (is-eq proof-type PROOF-TYPE-MERGE)
  )
)

;; -----------------------------------------------------------------------------
;; PRIVATE -- zkVerify statement leaf and Merkle inclusion
;; -----------------------------------------------------------------------------

;; The aggregation leaf for a verified statement, computed EXACTLY as zkVerify
;; computes it:
;;
;;   leaf = keccak256( keccak256(verifier_ctx)
;;                     || zkverify_vk_hash
;;                     || version_hash
;;                     || keccak256(public_inputs) )
;;
;; Three of these four components are zkVerify-internal constants that cannot
;; be derived from anything we hold: `keccak256(verifier_ctx)` identifies the
;; UltraHonk pallet, `zkverify_vk_hash` is the hash zkVerify assigns a key when
;; it is registered (emitted in its VkRegistered event -- NOT barretenberg's
;; vk_hash), and `version_hash` identifies the proof version.
;;
;; They are therefore CONFIGURATION, not code. Guessing them in a contract is
;; how the previous construction went wrong. `verify-proof` fails closed until
;; a binding is set, so an unconfigured circuit rejects every proof rather than
;; silently accepting a leaf nobody agrees with.
(define-private (statement-leaf
    (context-hash (buff 32))
    (zkv-vkey-hash (buff 32))
    (version-hash (buff 32))
    (public-inputs-hash (buff 32))
  )
  (keccak256 (concat (concat context-hash zkv-vkey-hash)
                     (concat version-hash public-inputs-hash)))
)

;; One level of Merkle path verification. Sibling order is determined by the
;; One level of Substrate `binary-merkle-tree` proof verification. The running
;; node sits on the RIGHT when its position is odd OR it is the last node of an
;; odd-width level (position + 1 == width) -- exactly Substrate's condition.
;; `width` is the node count at the current level and shrinks as ((w-1)/2)+1.
(define-private (merkle-step
    (sibling (buff 32))
    (acc { hash: (buff 32), position: uint, width: uint })
  )
  (let (
      (h (get hash acc))
      (pos (get position acc))
      (w (get width acc))
    )
    {
      hash: (if (or (is-eq (mod pos u2) u1) (is-eq (+ pos u1) w))
        (keccak256 (concat sibling h)) ;; node on the right
        (keccak256 (concat h sibling)) ;; node on the left
      ),
      position: (/ pos u2),
      width: (+ (/ (- w u1) u2) u1),
    }
  )
)

;; Recomputes the tree root from a statement leaf, its sibling path, index, and
;; the aggregation's leaf-count -- matching zkVerify's Substrate
;; `binary-merkle-tree::verify_proof` byte for byte:
;;
;;   * LEAVES ARE HASHED: the tree node for a statement is keccak256(statement).
;;     A single-leaf aggregation therefore has root == keccak256(leaf), which is
;;     why the fold starts from the hash.
;;   * internal nodes: keccak256(left || right).
;;   * an odd trailing node carries UP UNCHANGED; the path omits a sibling for
;;     those levels, and the position/width tracking keeps the ordering correct.
(define-private (compute-merkle-root
    (leaf (buff 32))
    (path (list 32 (buff 32)))
    (leaf-index uint)
    (leaf-count uint)
  )
  (get hash (fold merkle-step path
    { hash: (keccak256 leaf), position: leaf-index, width: leaf-count }))
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Verification keys, aggregations, statements, status
;; -----------------------------------------------------------------------------

;; Full vkey record for (proof type, circuit version), or none.
(define-read-only (get-verification-key (proof-type uint) (circuit-version uint))
  (map-get? verification-keys { proof-type: proof-type, circuit-version: circuit-version })
)

;; Published aggregation record, or none.
(define-read-only (get-aggregation (domain-id uint) (aggregation-id uint))
  (map-get? aggregations { domain-id: domain-id, aggregation-id: aggregation-id })
)

(define-read-only (get-zkverify-context-hash)
  (var-get zkverify-context-hash)
)

(define-read-only (get-zkverify-binding (proof-type uint) (circuit-version uint))
  (map-get? zkverify-bindings
    { proof-type: proof-type, circuit-version: circuit-version }
  )
)

;; True once every value the statement leaf needs is configured for a circuit.
(define-read-only (is-binding-ready (proof-type uint) (circuit-version uint))
  (and
    (not (is-eq (var-get zkverify-context-hash) ZERO-HASH))
    (> (len (var-get zkverify-context-hash)) u0)
    (is-some (map-get? zkverify-bindings
      { proof-type: proof-type, circuit-version: circuit-version }
    ))
  )
)

(define-read-only (get-aggregation-count)
  (var-get aggregation-count)
)

(define-read-only (get-relayer (who principal))
  (map-get? aggregation-relayers who)
)

(define-read-only (get-relayer-count)
  (var-get relayer-count)
)

;; The statement leaf for a given operation binding -- exposed so the SDK can
;; compute exactly what the contract will compute.
(define-read-only (get-statement-leaf
    (proof-type uint)
    (circuit-version uint)
    (public-inputs-hash (buff 32))
  )
  (match (map-get? zkverify-bindings
      { proof-type: proof-type, circuit-version: circuit-version }
    )
    binding (let ((context-hash (var-get zkverify-context-hash)))
      (asserts! (> (len context-hash) u0) ERR-BINDING-NOT-SET)
      (ok (statement-leaf
        context-hash
        (get zkv-vkey-hash binding)
        (get version-hash binding)
        public-inputs-hash
      ))
    )
    ERR-BINDING-NOT-SET
  )
)

;; True when this statement leaf has already been accepted.
(define-read-only (is-proof-verified (proof-id (buff 32)))
  (is-some (map-get? verified-proofs proof-id))
)

;; Full acceptance record for a statement leaf, or none.
(define-read-only (get-verified-proof (proof-id (buff 32)))
  (map-get? verified-proofs proof-id)
)

(define-read-only (get-verification-stats)
  (var-get verification-stats)
)

(define-read-only (is-verification-frozen)
  (var-get verification-frozen)
)

(define-read-only (get-verifier-contract-version)
  CONTRACT-VERSION
)

;; Off-chain check that an inclusion path is well formed before submitting.
(define-read-only (check-inclusion
    (domain-id uint)
    (aggregation-id uint)
    (leaf (buff 32))
    (merkle-path (list 32 (buff 32)))
    (leaf-index uint)
  )
  (match (map-get? aggregations { domain-id: domain-id, aggregation-id: aggregation-id })
    agg (ok (and
      (< leaf-index (get leaf-count agg))
      (is-eq (compute-merkle-root leaf merkle-path leaf-index (get leaf-count agg)) (get root agg))
    ))
    ERR-AGGREGATION-NOT-FOUND
  )
)

;; One-read snapshot for the SDK.
(define-read-only (get-verifier-info)
  {
    contract-version: CONTRACT-VERSION,
    verification-frozen: (var-get verification-frozen),
    aggregation-count: (var-get aggregation-count),
    relayer-count: (var-get relayer-count),
    circuit-version: (contract-call? .privacy-registry get-circuit-version),
    verifier-version: (contract-call? .privacy-registry get-verifier-version),
    statistics: (var-get verification-stats),
  }
)

;; =============================================================================
;; PUBLIC -- Proof verification (authorized protocol contracts)
;; =============================================================================

;; Accepts one zkVerify-verified statement and registers it. Returns (ok leaf).
;;
;; NO SIGNATURES, NO APPROVALS, NO THRESHOLD. The only questions asked are:
;;   1. Is the protocol active and verification unfrozen?
;;   2. Is the caller an authorized protocol contract?
;;   3. Does the circuit version match the registry's current version?
;;   4. Is there an enabled vkey for this (proof type, circuit version)?
;;   5. Does the leaf -- which commits to that vkey and to the caller's
;;      public inputs -- appear in a published aggregation root?
;;   6. Has this statement been spent before?
;;
;; `public-inputs-hash` is computed by the CALLER (privacy-pool /
;; split-merge-manager) from the actual operation parameters, so acceptance
;; binds the verified proof to exactly one on-chain operation. Substituting a
;; recipient or an amount changes the hash, changes the leaf, and fails the
;; inclusion check.
(define-public (verify-proof
    (proof-type uint)
    (circuit-version uint)
    (public-inputs-hash (buff 32))
    (domain-id uint)
    (aggregation-id uint)
    (merkle-path (list 32 (buff 32)))
    (leaf-index uint)
  )
  (begin
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (not (var-get verification-frozen)) ERR-VERIFICATION-FROZEN)
    (asserts! (is-authorized-protocol-caller contract-caller)
      ERR-UNAUTHORIZED-CALLER
    )
    (asserts! (is-valid-proof-type proof-type) ERR-UNKNOWN-PROOF-TYPE)
    (asserts!
      (is-eq circuit-version (contract-call? .privacy-registry get-circuit-version))
      ERR-VERSION-MISMATCH
    )
    (asserts! (not (is-eq public-inputs-hash ZERO-HASH)) ERR-INVALID-PUBLIC-INPUTS)
    (let (
        (vkey (unwrap!
          (map-get? verification-keys
            { proof-type: proof-type, circuit-version: circuit-version }
          )
          ERR-VKEY-NOT-FOUND
        ))
        (agg (unwrap!
          (map-get? aggregations
            { domain-id: domain-id, aggregation-id: aggregation-id }
          )
          ERR-AGGREGATION-NOT-FOUND
        ))
      )
      (asserts! (get enabled vkey) ERR-VKEY-DISABLED)
      (asserts! (< leaf-index (get leaf-count agg)) ERR-INVALID-LEAF-INDEX)
      (let (
          (binding (unwrap!
            (map-get? zkverify-bindings
              { proof-type: proof-type, circuit-version: circuit-version }
            )
            ERR-BINDING-NOT-SET
          ))
          (context-hash (var-get zkverify-context-hash))
        )
      (asserts! (not (is-eq context-hash ZERO-HASH)) ERR-BINDING-NOT-SET)
      (asserts! (> (len context-hash) u0) ERR-BINDING-NOT-SET)
      (let (
          (leaf (statement-leaf
            context-hash
            (get zkv-vkey-hash binding)
            (get version-hash binding)
            public-inputs-hash
          ))
          (stats (var-get verification-stats))
        )
        ;; The proof was verified by zkVerify; this establishes that OUR
        ;; statement is one of the statements it verified.
        (asserts!
          (is-eq (compute-merkle-root leaf merkle-path leaf-index (get leaf-count agg)) (get root agg))
          ERR-PROOF-NOT-AGGREGATED
        )
        ;; append-only acceptance record: statement-level replay protection
        (asserts!
          (map-insert verified-proofs leaf
            { proof-type: proof-type, verified-at: stacks-block-height }
          )
          ERR-PROOF-ALREADY-VERIFIED
        )
        (var-set verification-stats
          (merge stats {
            total-verified: (+ (get total-verified stats) u1),
            shield: (if (is-eq proof-type PROOF-TYPE-SHIELD)
              (+ (get shield stats) u1) (get shield stats)),
            transfer: (if (is-eq proof-type PROOF-TYPE-TRANSFER)
              (+ (get transfer stats) u1) (get transfer stats)),
            withdrawal: (if (is-eq proof-type PROOF-TYPE-WITHDRAWAL)
              (+ (get withdrawal stats) u1) (get withdrawal stats)),
            other: (if (or
                (is-eq proof-type PROOF-TYPE-SPLIT)
                (is-eq proof-type PROOF-TYPE-MERGE))
              (+ (get other stats) u1) (get other stats)),
          })
        )
        (print {
          event: "proof-verified",
          proof-id: leaf,
          proof-type: proof-type,
          circuit-version: circuit-version,
          domain-id: domain-id,
          aggregation-id: aggregation-id,
          height: stacks-block-height,
        })
        (ok leaf)
      )
      )
    )
  )
)

;; =============================================================================
;; PUBLIC -- Aggregation root publication (relayers)
;; =============================================================================

;; Publishes one zkVerify aggregation root. Append-only: a root can never be
;; changed once published, so an inclusion path that verifies remains valid
;; permanently and a relayer cannot retract a user's ability to transact.
;;
;; This is protocol-level plumbing. It approves nothing: the relayer cannot
;; choose which statements are inside the tree, cannot make an invalid proof
;; valid, and cannot single out a user.
(define-public (submit-aggregation
    (domain-id uint)
    (aggregation-id uint)
    (root (buff 32))
    (leaf-count uint)
  )
  (begin
    (asserts! (is-relayer contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq root ZERO-HASH)) ERR-INVALID-AGGREGATION)
    (asserts! (> leaf-count u0) ERR-INVALID-AGGREGATION)
    (asserts!
      (map-insert aggregations
        { domain-id: domain-id, aggregation-id: aggregation-id }
        {
          root: root,
          leaf-count: leaf-count,
          posted-at: stacks-block-height,
          posted-by: contract-caller,
        }
      )
      ERR-AGGREGATION-EXISTS
    )
    (var-set aggregation-count (+ (var-get aggregation-count) u1))
    (print {
      event: "aggregation-posted",
      domain-id: domain-id,
      aggregation-id: aggregation-id,
      root: root,
      leaf-count: leaf-count,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; =============================================================================
;; PUBLIC -- Relayer management (verifier admin or owner)
;; =============================================================================

;; =============================================================================
;; PUBLIC -- zkVerify statement binding (verifier admin or owner)
;; =============================================================================

;; Sets keccak256(verifier_ctx) for the UltraHonk pallet. Observed from the
;; live network; never guessed. Re-settable because zkVerify may revise the
;; pallet context, and a wrong value must be correctable without redeploying.
(define-public (set-zkverify-context-hash (context-hash (buff 32)))
  (begin
    (asserts! (is-verifier-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq context-hash ZERO-HASH)) ERR-INVALID-BINDING)
    (var-set zkverify-context-hash context-hash)
    (print {
      event: "zkverify-context-set",
      context-hash: context-hash,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Records the zkVerify-side binding for one circuit: the vk hash zkVerify
;; assigned at registration (from its VkRegistered event) and the proof
;; version hash. Until this is set, verify-proof rejects the circuit outright
;; -- failing closed rather than computing a leaf nobody agrees with.
(define-public (set-zkverify-binding
    (proof-type uint)
    (circuit-version uint)
    (zkv-vkey-hash (buff 32))
    (version-hash (buff 32))
  )
  (begin
    (asserts! (is-verifier-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (is-valid-proof-type proof-type) ERR-UNKNOWN-PROOF-TYPE)
    (asserts! (not (is-eq zkv-vkey-hash ZERO-HASH)) ERR-INVALID-BINDING)
    (asserts! (not (is-eq version-hash ZERO-HASH)) ERR-INVALID-BINDING)
    (asserts!
      (is-some (map-get? verification-keys
        { proof-type: proof-type, circuit-version: circuit-version }
      ))
      ERR-VKEY-NOT-FOUND
    )
    (map-set zkverify-bindings
      { proof-type: proof-type, circuit-version: circuit-version }
      {
        zkv-vkey-hash: zkv-vkey-hash,
        version-hash: version-hash,
        set-at: stacks-block-height,
      }
    )
    (print {
      event: "zkverify-binding-set",
      proof-type: proof-type,
      circuit-version: circuit-version,
      zkv-vkey-hash: zkv-vkey-hash,
      version-hash: version-hash,
      height: stacks-block-height,
    })
    (ok true)
  )
)

(define-public (add-relayer (who principal))
  (begin
    (asserts! (is-verifier-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts!
      (map-insert aggregation-relayers who
        { enabled: true, added-at: stacks-block-height }
      )
      ERR-RELAYER-EXISTS
    )
    (var-set relayer-count (+ (var-get relayer-count) u1))
    (print { event: "relayer-added", relayer: who, height: stacks-block-height })
    (ok true)
  )
)

(define-public (remove-relayer (who principal))
  (begin
    (asserts! (is-verifier-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (is-some (map-get? aggregation-relayers who)) ERR-RELAYER-NOT-FOUND)
    (map-delete aggregation-relayers who)
    (var-set relayer-count (- (var-get relayer-count) u1))
    (print { event: "relayer-removed", relayer: who, height: stacks-block-height })
    (ok true)
  )
)

;; =============================================================================
;; PUBLIC -- Verification key management
;; =============================================================================

;; Registers the immutable vkey record for (proof type, circuit version).
;; Verifier admin or owner. Registration is allowed in any protocol state so
;; that new circuits can be staged before an upgrade window opens.
;;
;; `vkey-hash` MUST be the hash of the verification key registered with
;; zkVerify for this circuit. It is the anchor binding a zkVerify statement to
;; this protocol.
(define-public (register-verification-key
    (proof-type uint)
    (circuit-version uint)
    (vkey-hash (buff 32))
    (proof-length uint)
  )
  (begin
    (asserts! (is-verifier-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (is-valid-proof-type proof-type) ERR-UNKNOWN-PROOF-TYPE)
    (asserts! (not (is-eq vkey-hash ZERO-HASH)) ERR-INVALID-VKEY)
    (asserts!
      (and (> proof-length u0) (<= proof-length MAX-PROOF-LENGTH))
      ERR-INVALID-PROOF-LENGTH
    )
    (asserts!
      (map-insert verification-keys
        { proof-type: proof-type, circuit-version: circuit-version }
        {
          vkey-hash: vkey-hash,
          proof-length: proof-length,
          enabled: true,
          registered-at: stacks-block-height,
        }
      )
      ERR-VKEY-EXISTS
    )
    (print {
      event: "vkey-registered",
      proof-type: proof-type,
      circuit-version: circuit-version,
      vkey-hash: vkey-hash,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Enables or disables a registered vkey. A disabled vkey halts operations
;; using that circuit; it can never be swapped for a different key.
(define-public (set-verification-key-status
    (proof-type uint)
    (circuit-version uint)
    (enabled bool)
  )
  (let (
      (key { proof-type: proof-type, circuit-version: circuit-version })
      (vkey (unwrap! (map-get? verification-keys
        { proof-type: proof-type, circuit-version: circuit-version }
      ) ERR-VKEY-NOT-FOUND))
    )
    (asserts! (is-vkey-controller contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq (get enabled vkey) enabled)) ERR-VKEY-STATUS-UNCHANGED)
    (map-set verification-keys key (merge vkey { enabled: enabled }))
    (print {
      event: "vkey-status-changed",
      proof-type: proof-type,
      circuit-version: circuit-version,
      enabled: enabled,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; =============================================================================
;; PUBLIC -- Emergency controls
;; =============================================================================

(define-public (freeze-verification)
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (var-set verification-frozen true)
    (print { event: "verification-frozen", height: stacks-block-height })
    (ok true)
  )
)

(define-public (unfreeze-verification)
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (var-set verification-frozen false)
    (print { event: "verification-unfrozen", height: stacks-block-height })
    (ok true)
  )
)
