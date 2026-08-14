;; =============================================================================
;; sip10-zk-verifier.clar
;; =============================================================================
;; STX Shield -- SIP-10 zk-verifier (v1.0.0)
;;
;; A dedicated VERIFICATION NAMESPACE for the SIP-10 proving family. It is a
;; faithful mirror of the frozen `zk-verifier.clar`: the same zkVerify
;; integration model, the same aggregation/inclusion verification, the same
;; immutable vkey registry, the same per-statement replay protection, the same
;; delegated authority model, and the same event and administrative patterns.
;; The frozen STX verifier is NOT touched and NOT reused for SIP-10 proofs.
;;
;; WHY A SEPARATE CONTRACT (structural, not stylistic):
;;   The frozen verify-proof asserts circuit-version == the registry's single
;;   current version, and vkeys are immutable and keyed by (proof-type,
;;   circuit-version). STX already occupies every (u1..u5, 1) slot immutably, so
;;   the frozen verifier cannot additively host a second circuit family. This
;;   contract gives SIP-10 its own vkey registry and its own circuit-version
;;   namespace, leaving STX completely frozen.
;;
;; INTENTIONAL DIFFERENCES FROM zk-verifier.clar (only these):
;;   1. Circuit-version namespace is LOCAL to this contract (`sip10-circuit-version`,
;;      admin-bumpable and monotonic), not the STX registry's circuit version.
;;      This is what makes it an independent namespace; STX and SIP-10 vkeys can
;;      never collide because they live in different contracts.
;;   2. verify-proof authorizes ONLY the configured SIP-10 pool (a single
;;      `authorized-pool`, owner-set), not the registry's whole allowlist. It
;;      fails closed until the pool is set. (The STX verifier accepts any
;;      registry-authorized caller, which would include the STX pool -- not
;;      wanted here.)
;;   3. A `set-circuit-version` admin function is added for SIP-10 circuit
;;      upgrades -- the local equivalent of the registry's version bump the STX
;;      verifier delegates to.
;; Everything else is byte-for-byte the STX verifier's behavior.
;;
;; SHARED INFRASTRUCTURE: relayers publish the zkVerify aggregation roots here
;; exactly as they do to the STX verifier (SIP-10 statement leaves live in the
;; same zkVerify domain/aggregations; the same root is posted to both verifiers).
;; The verifier-context / vkey / version-hash bindings are SIP-10-specific.
;;
;; Error space: u550-u599 (reserved for the SIP-10 verifier across the protocol).
;; =============================================================================

;; -----------------------------------------------------------------------------
;; CONSTANTS -- Proof types (reused; same operation set as STX)
;; -----------------------------------------------------------------------------

(define-constant PROOF-TYPE-SHIELD u1)
(define-constant PROOF-TYPE-TRANSFER u2)
(define-constant PROOF-TYPE-WITHDRAWAL u3)
(define-constant PROOF-TYPE-SPLIT u4)
(define-constant PROOF-TYPE-MERGE u5)

;; -----------------------------------------------------------------------------
;; CONSTANTS -- Identity and limits
;; -----------------------------------------------------------------------------

(define-constant CONTRACT-VERSION u1)

;; Hard cap on registered proof sizes; UltraHonk proofs are ~14-16 KiB.
(define-constant MAX-PROOF-LENGTH u16384)

;; Merkle inclusion bounds (generous ceiling on aggregation path length).
(define-constant MAX-MERKLE-DEPTH u32)

;; Mirrors of the frozen registry's role ids (stable public API).
(define-constant REGISTRY-ROLE-EMERGENCY-ADMIN u2)
(define-constant REGISTRY-ROLE-VERIFIER-ADMIN u3)

;; The all-zero hash is never a valid vkey hash, leaf, root, or inputs hash.
(define-constant ZERO-HASH 0x0000000000000000000000000000000000000000000000000000000000000000)

;; -----------------------------------------------------------------------------
;; ERRORS -- Reserved SIP-10 verifier space u550-u599
;; -----------------------------------------------------------------------------

(define-constant ERR-UNAUTHORIZED (err u550))            ;; caller lacks registry owner/role authority
(define-constant ERR-UNAUTHORIZED-CALLER (err u551))     ;; contract-caller is not the authorized SIP-10 pool
(define-constant ERR-VERIFICATION-FROZEN (err u552))     ;; verification is frozen
(define-constant ERR-UNKNOWN-PROOF-TYPE (err u553))      ;; proof type outside the defined set
(define-constant ERR-VKEY-NOT-FOUND (err u554))          ;; no vkey for (type, circuit version)
(define-constant ERR-VKEY-DISABLED (err u555))           ;; vkey kill-switched
(define-constant ERR-VKEY-EXISTS (err u556))             ;; vkey already registered (immutable)
(define-constant ERR-INVALID-PROOF-LENGTH (err u557))    ;; registered proof length out of range
(define-constant ERR-INVALID-PUBLIC-INPUTS (err u558))   ;; zero public-inputs hash
(define-constant ERR-PROOF-ALREADY-VERIFIED (err u559))  ;; statement replay
(define-constant ERR-PROOF-NOT-AGGREGATED (err u560))    ;; Merkle inclusion check failed
(define-constant ERR-AGGREGATION-NOT-FOUND (err u561))   ;; no root for (domain, aggregation)
(define-constant ERR-AGGREGATION-EXISTS (err u562))      ;; aggregation root already published (immutable)
(define-constant ERR-INVALID-AGGREGATION (err u563))     ;; zero root, or empty tree
(define-constant ERR-INVALID-VKEY (err u564))            ;; zero vkey hash or bad proof length
(define-constant ERR-VERSION-MISMATCH (err u565))        ;; circuit version != this verifier's current
(define-constant ERR-INVALID-LEAF-INDEX (err u566))      ;; leaf index outside the tree
(define-constant ERR-VKEY-STATUS-UNCHANGED (err u567))   ;; enable/disable no-op
(define-constant ERR-RELAYER-EXISTS (err u568))          ;; relayer already registered
(define-constant ERR-RELAYER-NOT-FOUND (err u569))       ;; relayer not registered
(define-constant ERR-BINDING-NOT-SET (err u570))         ;; zkVerify binding unconfigured for this circuit
(define-constant ERR-INVALID-BINDING (err u571))         ;; zero context, vk, or version hash
(define-constant ERR-INVALID-VERSION (err u572))         ;; non-monotonic circuit-version set
(define-constant ERR-POOL-UNCHANGED (err u573))          ;; authorized-pool set is a no-op

;; -----------------------------------------------------------------------------
;; STORAGE -- Verification keys (independent SIP-10 registry)
;; -----------------------------------------------------------------------------

;; One immutable record per (proof type, circuit version). Corrected only by
;; advancing the circuit version, never by mutation. `vkey-hash` is the anchor
;; binding a zkVerify statement to the SIP-10 protocol.
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
;; STORAGE -- zkVerify aggregation roots (append-only, immutable)
;; -----------------------------------------------------------------------------

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

(define-data-var zkverify-context-hash (buff 32) 0x)

(define-map zkverify-bindings
  { proof-type: uint, circuit-version: uint }
  {
    zkv-vkey-hash: (buff 32),
    version-hash: (buff 32),
    set-at: uint,
  }
)

(define-map aggregation-relayers principal { enabled: bool, added-at: uint })

(define-data-var relayer-count uint u0)

;; -----------------------------------------------------------------------------
;; STORAGE -- Accepted statements (replay protection), stats, version, pool
;; -----------------------------------------------------------------------------

(define-map verified-proofs
  (buff 32)
  { proof-type: uint, verified-at: uint }
)

(define-data-var verification-stats
  { total-verified: uint, shield: uint, transfer: uint, withdrawal: uint, other: uint }
  { total-verified: u0, shield: u0, transfer: u0, withdrawal: u0, other: u0 }
)

(define-data-var verification-frozen bool false)

;; DIFFERENCE 1: the SIP-10 circuit-version namespace lives here, not in the
;; registry. Monotonic; a wrong circuit is superseded by a higher version.
(define-data-var sip10-circuit-version uint u1)

;; DIFFERENCE 2: the single contract permitted to call verify-proof. Owner-set;
;; verify-proof fails closed until it is configured.
(define-data-var authorized-pool (optional principal) none)

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

(define-private (is-vkey-controller (who principal))
  (or (is-verifier-admin who) (is-emergency-admin who))
)

;; DIFFERENCE 2: only the configured SIP-10 pool may present proofs. Fails
;; closed while `authorized-pool` is none.
(define-private (is-authorized-sip10-pool (who principal))
  (is-eq (some who) (var-get authorized-pool))
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
;; PRIVATE -- zkVerify statement leaf and Merkle inclusion (identical to STX)
;; -----------------------------------------------------------------------------

;;   leaf = keccak256( keccak256(verifier_ctx)
;;                     || zkverify_vk_hash || version_hash
;;                     || keccak256(public_inputs) )
(define-private (statement-leaf
    (context-hash (buff 32))
    (zkv-vkey-hash (buff 32))
    (version-hash (buff 32))
    (public-inputs-hash (buff 32))
  )
  (keccak256 (concat (concat context-hash zkv-vkey-hash)
                     (concat version-hash public-inputs-hash)))
)

;; One level of Substrate `binary-merkle-tree` proof verification (identical to STX).
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

(define-read-only (get-verification-key (proof-type uint) (circuit-version uint))
  (map-get? verification-keys { proof-type: proof-type, circuit-version: circuit-version })
)

(define-read-only (get-aggregation (domain-id uint) (aggregation-id uint))
  (map-get? aggregations { domain-id: domain-id, aggregation-id: aggregation-id })
)

(define-read-only (get-zkverify-context-hash)
  (var-get zkverify-context-hash)
)

(define-read-only (get-zkverify-binding (proof-type uint) (circuit-version uint))
  (map-get? zkverify-bindings { proof-type: proof-type, circuit-version: circuit-version })
)

(define-read-only (is-binding-ready (proof-type uint) (circuit-version uint))
  (and
    (not (is-eq (var-get zkverify-context-hash) ZERO-HASH))
    (> (len (var-get zkverify-context-hash)) u0)
    (is-some (map-get? zkverify-bindings { proof-type: proof-type, circuit-version: circuit-version }))
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

;; The current SIP-10 circuit version this verifier accepts (independent namespace).
(define-read-only (get-circuit-version)
  (var-get sip10-circuit-version)
)

(define-read-only (get-authorized-pool)
  (var-get authorized-pool)
)

(define-read-only (get-statement-leaf
    (proof-type uint)
    (circuit-version uint)
    (public-inputs-hash (buff 32))
  )
  (match (map-get? zkverify-bindings { proof-type: proof-type, circuit-version: circuit-version })
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

(define-read-only (is-proof-verified (proof-id (buff 32)))
  (is-some (map-get? verified-proofs proof-id))
)

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

(define-read-only (get-verifier-info)
  {
    contract-version: CONTRACT-VERSION,
    verification-frozen: (var-get verification-frozen),
    aggregation-count: (var-get aggregation-count),
    relayer-count: (var-get relayer-count),
    circuit-version: (var-get sip10-circuit-version),
    authorized-pool: (var-get authorized-pool),
    statistics: (var-get verification-stats),
  }
)

;; =============================================================================
;; PUBLIC -- Proof verification (SIP-10 pool ONLY)
;; =============================================================================

;; Accepts one zkVerify-verified SIP-10 statement and registers it. Same six
;; questions as the STX verifier, with the two documented differences: the
;; caller must be the configured SIP-10 pool, and the circuit version is checked
;; against this verifier's own namespace.
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
    ;; DIFFERENCE 2: only the SIP-10 pool.
    (asserts! (is-authorized-sip10-pool contract-caller) ERR-UNAUTHORIZED-CALLER)
    (asserts! (is-valid-proof-type proof-type) ERR-UNKNOWN-PROOF-TYPE)
    ;; DIFFERENCE 1: SIP-10's own circuit-version namespace.
    (asserts! (is-eq circuit-version (var-get sip10-circuit-version)) ERR-VERSION-MISMATCH)
    (asserts! (not (is-eq public-inputs-hash ZERO-HASH)) ERR-INVALID-PUBLIC-INPUTS)
    (let (
        (vkey (unwrap!
          (map-get? verification-keys { proof-type: proof-type, circuit-version: circuit-version })
          ERR-VKEY-NOT-FOUND
        ))
        (agg (unwrap!
          (map-get? aggregations { domain-id: domain-id, aggregation-id: aggregation-id })
          ERR-AGGREGATION-NOT-FOUND
        ))
      )
      (asserts! (get enabled vkey) ERR-VKEY-DISABLED)
      (asserts! (< leaf-index (get leaf-count agg)) ERR-INVALID-LEAF-INDEX)
      (let (
          (binding (unwrap!
            (map-get? zkverify-bindings { proof-type: proof-type, circuit-version: circuit-version })
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
        (asserts!
          (is-eq (compute-merkle-root leaf merkle-path leaf-index (get leaf-count agg)) (get root agg))
          ERR-PROOF-NOT-AGGREGATED
        )
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
;; PUBLIC -- zkVerify statement binding (verifier admin or owner)
;; =============================================================================

(define-public (set-zkverify-context-hash (context-hash (buff 32)))
  (begin
    (asserts! (is-verifier-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq context-hash ZERO-HASH)) ERR-INVALID-BINDING)
    (var-set zkverify-context-hash context-hash)
    (print { event: "zkverify-context-set", context-hash: context-hash, height: stacks-block-height })
    (ok true)
  )
)

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
      (is-some (map-get? verification-keys { proof-type: proof-type, circuit-version: circuit-version }))
      ERR-VKEY-NOT-FOUND
    )
    (map-set zkverify-bindings
      { proof-type: proof-type, circuit-version: circuit-version }
      { zkv-vkey-hash: zkv-vkey-hash, version-hash: version-hash, set-at: stacks-block-height }
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

;; =============================================================================
;; PUBLIC -- Relayer management (verifier admin or owner)
;; =============================================================================

(define-public (add-relayer (who principal))
  (begin
    (asserts! (is-verifier-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts!
      (map-insert aggregation-relayers who { enabled: true, added-at: stacks-block-height })
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
;; PUBLIC -- SIP-10 circuit-version namespace (DIFFERENCE 3) & pool binding
;; =============================================================================

;; Advances the SIP-10 circuit version for a circuit upgrade. Monotonic, mirroring
;; the registry's version bump the STX verifier delegates to. New vkeys/bindings
;; are registered at the new version before it is activated here.
(define-public (set-circuit-version (new-version uint))
  (begin
    (asserts! (is-verifier-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (> new-version (var-get sip10-circuit-version)) ERR-INVALID-VERSION)
    (var-set sip10-circuit-version new-version)
    (print { event: "sip10-circuit-version-set", version: new-version, height: stacks-block-height })
    (ok true)
  )
)

;; Sets the single SIP-10 pool authorized to present proofs. Owner-only (highest
;; stakes: it is the sole spender of verified statements). verify-proof fails
;; closed until this is set.
(define-public (set-authorized-pool (pool principal))
  (begin
    (asserts! (is-registry-owner contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq (some pool) (var-get authorized-pool))) ERR-POOL-UNCHANGED)
    (var-set authorized-pool (some pool))
    (print { event: "authorized-pool-set", pool: pool, height: stacks-block-height })
    (ok true)
  )
)

;; =============================================================================
;; PUBLIC -- Emergency controls (registry emergency admin or owner)
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
