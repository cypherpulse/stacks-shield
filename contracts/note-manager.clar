;; =============================================================================
;; note-manager.clar
;; =============================================================================
;; STX Shield -- Note Manager (v1.0.0)
;;
;; The note-manager is the protocol's shielded-note lifecycle layer. It manages
;; exactly one thing: the state machine of every shielded note.
;;
;;   - Note registration     (opaque note ids, owner commitments, metadata)
;;   - Note lifecycle        (ACTIVE / SPENT / WITHDRAWN / FROZEN / DEPRECATED)
;;   - Note version tracking (per-note, against the registry's note version)
;;   - Note statistics       (per-state counters with a closed-form invariant)
;;
;; It deliberately does NOT manage: commitments, nullifiers, Merkle roots,
;; proofs, fees, STX movement, or protocol ownership. Those belong to
;; privacy-registry, zk-verifier, protocol-fees, and privacy-pool.
;;
;; Authority model -- ZERO local authority state:
;;   privacy-registry.clar v1.0.0 (SECURITY FROZEN) is the single source of
;;   truth for access control and protocol state. This contract stores no
;;   owner, no roles, and no caller allowlist. Every authorization decision is
;;   delegated to the registry at call time:
;;     - protocol writes  (register / spend / withdraw): the caller must be on
;;       the registry's authorized-callers allowlist (privacy-pool, ...);
;;     - incident writes  (freeze / reactivate): registry owner or a registry
;;       emergency administrator;
;;     - permanent writes (deprecate): registry owner only.
;;   All checks use `contract-caller`, never tx-sender.
;;
;; Protocol-state gating:
;;   - register / spend / withdraw require the registry to be ACTIVE and
;;     propagate the registry's precise pause error (u102..u105).
;;   - freeze / reactivate / deprecate work in ANY registry state: they are
;;     incident-response tools and must function precisely when the protocol
;;     is paused or in emergency.
;;
;; Registry integration on registration:
;;   register-note calls the registry's record-note-created, which atomically
;;   enforces the global note capacity limit and maintains the registry's
;;   authoritative total-notes statistic. This contract must therefore be an
;;   authorized caller in the registry (owner adds it at integration time).
;;
;; Privacy model:
;;   A note record contains only opaque 32-byte values: the note id (the note
;;   commitment computed off-chain), an owner commitment (a hash binding the
;;   ownership secret -- NEVER a principal), and an opaque metadata hash. No
;;   amounts, no principals, no note-to-note linkage. Spending reveals only
;;   that some note changed state, never which user acted.
;;
;; Error space: u150-u199 (reserved for note errors across the protocol).
;; Registry errors (u100-u149) pass through unchanged, so every failure is
;; attributable to its layer of origin.
;; =============================================================================

;; -----------------------------------------------------------------------------
;; CONSTANTS -- Note states
;; -----------------------------------------------------------------------------

;; Spendable: the only state from which value can move.
(define-constant NOTE-STATE-ACTIVE u1)
;; Terminal: consumed by a private transfer.
(define-constant NOTE-STATE-SPENT u2)
;; Terminal: consumed by a withdrawal to a transparent address.
(define-constant NOTE-STATE-WITHDRAWN u3)
;; Administrative hold: cannot be spent or withdrawn until reactivated.
(define-constant NOTE-STATE-FROZEN u4)
;; Terminal: permanently retired by the protocol owner (from FROZEN only).
(define-constant NOTE-STATE-DEPRECATED u5)

;; -----------------------------------------------------------------------------
;; CONSTANTS -- Contract identity and registry interface
;; -----------------------------------------------------------------------------

;; Version of this contract's own logic (not the note format version, which
;; the registry owns and this contract enforces per note).
(define-constant CONTRACT-VERSION u1)

;; Mirror of the registry's emergency-administrator role id. The registry is
;; SECURITY FROZEN at v1.0.0, so its role ids are a stable public API.
(define-constant REGISTRY-ROLE-EMERGENCY-ADMIN u2)

;; The all-zero hash is never a valid note id or owner commitment: it is the
;; Merkle padding value and must be rejected on input.
(define-constant ZERO-HASH 0x0000000000000000000000000000000000000000000000000000000000000000)

;; -----------------------------------------------------------------------------
;; ERRORS -- Reserved note space u150-u199
;; -----------------------------------------------------------------------------

(define-constant ERR-UNAUTHORIZED (err u150))            ;; caller lacks registry owner/role authority
(define-constant ERR-UNAUTHORIZED-CALLER (err u151))     ;; contract-caller not on the registry allowlist
(define-constant ERR-INVALID-NOTE-ID (err u152))         ;; zero note id
(define-constant ERR-INVALID-OWNER-COMMITMENT (err u153));; zero owner commitment
(define-constant ERR-DUPLICATE-NOTE (err u154))          ;; note id already registered
(define-constant ERR-NOTE-NOT-FOUND (err u155))          ;; note id never registered
(define-constant ERR-INVALID-NOTE-STATE (err u156))      ;; operation illegal for the note's state
(define-constant ERR-INVALID-STATE-TRANSITION (err u157));; transition not in the allowed table
(define-constant ERR-VERSION-MISMATCH (err u158))        ;; supplied version != current registry note version
(define-constant ERR-NOTE-FROZEN (err u159))             ;; spend/withdraw attempted on a frozen note

;; -----------------------------------------------------------------------------
;; STORAGE -- Notes
;; -----------------------------------------------------------------------------

;; The note ledger. Append-only keys: a note id is registered at most once,
;; ever, and records are never deleted -- historical state is preserved
;; forever. Only `state` and `updated-at` ever change after registration.
(define-map notes
  (buff 32)  ;; note id (the off-chain note commitment)
  {
    state: uint,                  ;; one of the NOTE-STATE-* constants
    owner-commitment: (buff 32),  ;; hash binding the ownership secret
    version: uint,                ;; registry note version at registration
    metadata: (buff 32),          ;; opaque hash (e.g. of the encrypted payload)
    registered-at: uint,          ;; stacks block height of registration
    updated-at: uint,             ;; stacks block height of last state change
  }
)

;; -----------------------------------------------------------------------------
;; STORAGE -- Statistics
;; -----------------------------------------------------------------------------

;; Per-state counters. Closed-form invariant, checked by
;; is-statistics-consistent and preserved by construction (every transition
;; moves exactly one note between exactly two buckets):
;;
;;   total-registered == total-active + total-spent + total-withdrawn
;;                       + total-frozen + total-deprecated
(define-data-var note-statistics
  {
    total-registered: uint,
    total-active: uint,
    total-spent: uint,
    total-withdrawn: uint,
    total-frozen: uint,
    total-deprecated: uint,
  }
  {
    total-registered: u0,
    total-active: u0,
    total-spent: u0,
    total-withdrawn: u0,
    total-frozen: u0,
    total-deprecated: u0,
  }
)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Authority (fully delegated to the frozen registry)
;; -----------------------------------------------------------------------------

;; True when `who` is on the registry's authorized-callers allowlist
;; (privacy-pool and other protocol contracts).
(define-private (is-authorized-protocol-caller (who principal))
  (contract-call? .privacy-registry is-authorized-caller who)
)

;; True when `who` is the current registry owner.
(define-private (is-registry-owner (who principal))
  (is-eq who (contract-call? .privacy-registry get-owner))
)

;; True when `who` may perform incident-response note operations:
;; the registry owner or a registry emergency administrator.
(define-private (is-note-admin (who principal))
  (or
    (is-registry-owner who)
    (contract-call? .privacy-registry has-role who REGISTRY-ROLE-EMERGENCY-ADMIN)
  )
)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Note state machine
;; -----------------------------------------------------------------------------

;; The complete transition table. Any transition not listed is forbidden.
;; SPENT, WITHDRAWN, and DEPRECATED are terminal by construction: they never
;; appear as a `from` state.
(define-private (is-valid-note-transition (from uint) (to uint))
  (or
    ;; value consumption (only spendable state is ACTIVE)
    (and (is-eq from NOTE-STATE-ACTIVE) (is-eq to NOTE-STATE-SPENT))
    (and (is-eq from NOTE-STATE-ACTIVE) (is-eq to NOTE-STATE-WITHDRAWN))
    ;; administrative hold and release
    (and (is-eq from NOTE-STATE-ACTIVE) (is-eq to NOTE-STATE-FROZEN))
    (and (is-eq from NOTE-STATE-FROZEN) (is-eq to NOTE-STATE-ACTIVE))
    ;; permanent retirement, only from a deliberate hold
    (and (is-eq from NOTE-STATE-FROZEN) (is-eq to NOTE-STATE-DEPRECATED))
  )
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Notes
;; -----------------------------------------------------------------------------

;; Full note record, or none when never registered.
(define-read-only (get-note (note-id (buff 32)))
  (map-get? notes note-id)
)

;; True when the note id has been registered (in any state).
(define-read-only (note-exists (note-id (buff 32)))
  (is-some (map-get? notes note-id))
)

;; The note's current state, or none when never registered.
(define-read-only (get-note-state (note-id (buff 32)))
  (get state (map-get? notes note-id))
)

;; The registry note version the note was registered under, or none.
(define-read-only (get-note-version (note-id (buff 32)))
  (get version (map-get? notes note-id))
)

;; The note's owner commitment, or none. This is an opaque hash -- it never
;; identifies a principal.
(define-read-only (get-note-owner-commitment (note-id (buff 32)))
  (get owner-commitment (map-get? notes note-id))
)

;; The note's opaque metadata hash, or none.
(define-read-only (get-note-metadata (note-id (buff 32)))
  (get metadata (map-get? notes note-id))
)

(define-read-only (is-note-active (note-id (buff 32)))
  (is-eq (default-to u0 (get state (map-get? notes note-id))) NOTE-STATE-ACTIVE)
)

(define-read-only (is-note-spent (note-id (buff 32)))
  (is-eq (default-to u0 (get state (map-get? notes note-id))) NOTE-STATE-SPENT)
)

(define-read-only (is-note-withdrawn (note-id (buff 32)))
  (is-eq (default-to u0 (get state (map-get? notes note-id))) NOTE-STATE-WITHDRAWN)
)

(define-read-only (is-note-frozen (note-id (buff 32)))
  (is-eq (default-to u0 (get state (map-get? notes note-id))) NOTE-STATE-FROZEN)
)

(define-read-only (is-note-deprecated (note-id (buff 32)))
  (is-eq (default-to u0 (get state (map-get? notes note-id))) NOTE-STATE-DEPRECATED)
)

;; Response-typed spendability check for integrating contracts: privacy-pool
;; (try!)s this before consuming a note, and receives the precise reason when
;; the note cannot move.
(define-read-only (validate-note-active (note-id (buff 32)))
  (match (map-get? notes note-id)
    note (if (is-eq (get state note) NOTE-STATE-ACTIVE)
      (ok true)
      (if (is-eq (get state note) NOTE-STATE-FROZEN)
        ERR-NOTE-FROZEN
        ERR-INVALID-NOTE-STATE
      )
    )
    ERR-NOTE-NOT-FOUND
  )
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Statistics and contract info
;; -----------------------------------------------------------------------------

;; All note statistics as one tuple.
(define-read-only (get-note-statistics)
  (var-get note-statistics)
)

;; True when the per-state counters sum exactly to the registration counter.
;; Monitoring hook: this must never return false on a healthy deployment.
(define-read-only (is-statistics-consistent)
  (let ((stats (var-get note-statistics)))
    (is-eq (get total-registered stats)
      (+
        (get total-active stats)
        (get total-spent stats)
        (get total-withdrawn stats)
        (get total-frozen stats)
        (get total-deprecated stats)
      )
    )
  )
)

;; This contract's own logic version.
(define-read-only (get-note-manager-version)
  CONTRACT-VERSION
)

;; The registry's current note format version -- the version register-note
;; enforces right now.
(define-read-only (get-current-note-version)
  (contract-call? .privacy-registry get-note-version)
)

;; One-read snapshot for the SDK: contract version, the live registry context
;; this contract operates under, and the full statistics.
(define-read-only (get-note-manager-info)
  {
    contract-version: CONTRACT-VERSION,
    note-version: (contract-call? .privacy-registry get-note-version),
    protocol-state: (contract-call? .privacy-registry get-protocol-state),
    statistics: (var-get note-statistics),
  }
)

;; =============================================================================
;; PUBLIC -- Note registration
;; =============================================================================

;; Registers a new shielded note in ACTIVE state. Authorized protocol
;; contracts only (privacy-pool).
;;
;; `version` must equal the registry's current note version: a caller built
;; for an older note format is rejected. The registry's record-note-created
;; is called atomically, which enforces the global note capacity limit and
;; keeps the registry's total-notes statistic authoritative; if any part
;; fails, the entire transaction (including the registry write) rolls back.
;;
;; `owner-commitment` and `metadata` are opaque 32-byte values fixed forever
;; at registration -- note records are immutable except for their state.
(define-public (register-note
    (note-id (buff 32))
    (owner-commitment (buff 32))
    (metadata (buff 32))
    (version uint)
  )
  (let ((stats (var-get note-statistics)))
    ;; protocol must be ACTIVE; propagates the precise registry pause error
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (is-authorized-protocol-caller contract-caller)
      ERR-UNAUTHORIZED-CALLER
    )
    (asserts! (not (is-eq note-id ZERO-HASH)) ERR-INVALID-NOTE-ID)
    (asserts! (not (is-eq owner-commitment ZERO-HASH))
      ERR-INVALID-OWNER-COMMITMENT
    )
    (asserts!
      (is-eq version (contract-call? .privacy-registry get-note-version))
      ERR-VERSION-MISMATCH
    )
    (asserts! (is-none (map-get? notes note-id)) ERR-DUPLICATE-NOTE)
    ;; registry: global capacity limit + authoritative total-notes counter
    (try! (contract-call? .privacy-registry record-note-created))
    ;; map-insert both registers and enforces uniqueness atomically
    (asserts!
      (map-insert notes note-id {
        state: NOTE-STATE-ACTIVE,
        owner-commitment: owner-commitment,
        version: version,
        metadata: metadata,
        registered-at: stacks-block-height,
        updated-at: stacks-block-height,
      })
      ERR-DUPLICATE-NOTE
    )
    (var-set note-statistics
      (merge stats {
        total-registered: (+ (get total-registered stats) u1),
        total-active: (+ (get total-active stats) u1),
      })
    )
    (print {
      event: "note-registered",
      note-id: note-id,
      owner-commitment: owner-commitment,
      version: version,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; =============================================================================
;; PUBLIC -- Value-consuming transitions (authorized protocol contracts)
;; =============================================================================

;; ACTIVE -> SPENT. Called by privacy-pool when a private transfer consumes
;; the note (alongside the pool's nullifier registration in the registry,
;; atomically within the pool's transaction).
;;
;; Error precision: a frozen note reports ERR-NOTE-FROZEN; any other
;; non-active state reports ERR-INVALID-NOTE-STATE (a second spend of the
;; same note -- a replay -- lands here, deterministically).
(define-public (spend-note (note-id (buff 32)))
  (let ((stats (var-get note-statistics)))
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (is-authorized-protocol-caller contract-caller)
      ERR-UNAUTHORIZED-CALLER
    )
    (asserts! (not (is-eq note-id ZERO-HASH)) ERR-INVALID-NOTE-ID)
    (let ((note (unwrap! (map-get? notes note-id) ERR-NOTE-NOT-FOUND)))
      (asserts! (not (is-eq (get state note) NOTE-STATE-FROZEN)) ERR-NOTE-FROZEN)
      (asserts! (is-eq (get state note) NOTE-STATE-ACTIVE) ERR-INVALID-NOTE-STATE)
      ;; defense in depth: the table must agree with the explicit checks above
      (asserts! (is-valid-note-transition (get state note) NOTE-STATE-SPENT)
        ERR-INVALID-STATE-TRANSITION
      )
      (map-set notes note-id
        (merge note { state: NOTE-STATE-SPENT, updated-at: stacks-block-height })
      )
      (var-set note-statistics
        (merge stats {
          total-active: (- (get total-active stats) u1),
          total-spent: (+ (get total-spent stats) u1),
        })
      )
      (print { event: "note-spent", note-id: note-id, height: stacks-block-height })
      (ok true)
    )
  )
)

;; ACTIVE -> WITHDRAWN. Called by privacy-pool when a withdrawal consumes the
;; note. Same gating and error precision as spend-note.
(define-public (withdraw-note (note-id (buff 32)))
  (let ((stats (var-get note-statistics)))
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (is-authorized-protocol-caller contract-caller)
      ERR-UNAUTHORIZED-CALLER
    )
    (asserts! (not (is-eq note-id ZERO-HASH)) ERR-INVALID-NOTE-ID)
    (let ((note (unwrap! (map-get? notes note-id) ERR-NOTE-NOT-FOUND)))
      (asserts! (not (is-eq (get state note) NOTE-STATE-FROZEN)) ERR-NOTE-FROZEN)
      (asserts! (is-eq (get state note) NOTE-STATE-ACTIVE) ERR-INVALID-NOTE-STATE)
      (asserts! (is-valid-note-transition (get state note) NOTE-STATE-WITHDRAWN)
        ERR-INVALID-STATE-TRANSITION
      )
      (map-set notes note-id
        (merge note { state: NOTE-STATE-WITHDRAWN, updated-at: stacks-block-height })
      )
      (var-set note-statistics
        (merge stats {
          total-active: (- (get total-active stats) u1),
          total-withdrawn: (+ (get total-withdrawn stats) u1),
        })
      )
      (print { event: "note-withdrawn", note-id: note-id, height: stacks-block-height })
      (ok true)
    )
  )
)

;; =============================================================================
;; PUBLIC -- Incident-response transitions (registry owner / emergency admin)
;; =============================================================================
;; These work in ANY registry protocol state: freezing a suspicious note must
;; be possible precisely while the protocol is paused or in emergency.

;; ACTIVE -> FROZEN. Registry owner or emergency administrator.
;; A frozen note cannot be spent or withdrawn until explicitly reactivated.
(define-public (freeze-note (note-id (buff 32)))
  (let ((stats (var-get note-statistics)))
    (asserts! (is-note-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq note-id ZERO-HASH)) ERR-INVALID-NOTE-ID)
    (let ((note (unwrap! (map-get? notes note-id) ERR-NOTE-NOT-FOUND)))
      (asserts! (is-valid-note-transition (get state note) NOTE-STATE-FROZEN)
        ERR-INVALID-STATE-TRANSITION
      )
      (map-set notes note-id
        (merge note { state: NOTE-STATE-FROZEN, updated-at: stacks-block-height })
      )
      (var-set note-statistics
        (merge stats {
          total-active: (- (get total-active stats) u1),
          total-frozen: (+ (get total-frozen stats) u1),
        })
      )
      (print { event: "note-frozen", note-id: note-id, height: stacks-block-height })
      (ok true)
    )
  )
)

;; FROZEN -> ACTIVE. Registry owner or emergency administrator.
(define-public (reactivate-note (note-id (buff 32)))
  (let ((stats (var-get note-statistics)))
    (asserts! (is-note-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq note-id ZERO-HASH)) ERR-INVALID-NOTE-ID)
    (let ((note (unwrap! (map-get? notes note-id) ERR-NOTE-NOT-FOUND)))
      (asserts! (is-valid-note-transition (get state note) NOTE-STATE-ACTIVE)
        ERR-INVALID-STATE-TRANSITION
      )
      (map-set notes note-id
        (merge note { state: NOTE-STATE-ACTIVE, updated-at: stacks-block-height })
      )
      (var-set note-statistics
        (merge stats {
          total-frozen: (- (get total-frozen stats) u1),
          total-active: (+ (get total-active stats) u1),
        })
      )
      (print { event: "note-reactivated", note-id: note-id, height: stacks-block-height })
      (ok true)
    )
  )
)

;; FROZEN -> DEPRECATED. Registry owner ONLY: permanent retirement of a note
;; is the highest-stakes note decision, and it requires a prior deliberate
;; freeze (mirroring the registry's pause-before-deprecate rule). Terminal.
(define-public (deprecate-note (note-id (buff 32)))
  (let ((stats (var-get note-statistics)))
    (asserts! (is-registry-owner contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq note-id ZERO-HASH)) ERR-INVALID-NOTE-ID)
    (let ((note (unwrap! (map-get? notes note-id) ERR-NOTE-NOT-FOUND)))
      (asserts! (is-valid-note-transition (get state note) NOTE-STATE-DEPRECATED)
        ERR-INVALID-STATE-TRANSITION
      )
      (map-set notes note-id
        (merge note { state: NOTE-STATE-DEPRECATED, updated-at: stacks-block-height })
      )
      (var-set note-statistics
        (merge stats {
          total-frozen: (- (get total-frozen stats) u1),
          total-deprecated: (+ (get total-deprecated stats) u1),
        })
      )
      (print { event: "note-deprecated", note-id: note-id, height: stacks-block-height })
      (ok true)
    )
  )
)
