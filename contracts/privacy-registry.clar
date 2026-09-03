;; =============================================================================
;; privacy-registry.clar
;; =============================================================================
;; STX Shield -- Privacy Registry (v1.0.0)
;;
;; The privacy-registry is the single source of truth for the STX Shield
;; protocol. It owns all authoritative protocol state:
;;
;;   - Commitments        (append-only, immutable once registered)
;;   - Nullifiers         (double-spend / replay protection)
;;   - Merkle roots       (current + historical, for ZK proof validation)
;;   - Protocol state     (ACTIVE / PAUSED / EMERGENCY / UPGRADING / DEPRECATED)
;;   - Protocol versions  (protocol, verifier, note, circuit, commitment, root)
;;   - Protocol limits    (shield/withdrawal bounds, capacity, fee ceiling)
;;   - Statistics         (transparency counters; never affect correctness)
;;   - Access control     (owner, role-based administrators, authorized callers)
;;
;; No other contract may maintain authoritative copies of this state.
;;
;; Write model:
;;   - Protected writes (commitments, nullifiers, roots, statistics) are only
;;     accepted from principals on the authorized-callers allowlist. These are
;;     the protocol's own contracts (privacy-pool, note-manager, ...), added
;;     by the owner at integration time. `contract-caller` is used for every
;;     authorization check so that intermediary contracts can never piggyback
;;     on a user's tx-sender.
;;   - Administrative writes (state, versions, limits, roles) require the
;;     owner or a matching administrator role.
;;   - Users can never mutate protected protocol state directly.
;;
;; Privacy model:
;;   - The registry stores only opaque 32-byte hashes (commitments, nullifiers,
;;     Merkle roots). It never stores amounts per note, note ownership, or any
;;     linkage between commitments and nullifiers. Unlinkability is preserved
;;     by construction: a nullifier reveals nothing about which commitment it
;;     consumes.
;;
;; Error space: u100-u149 (reserved for the registry across the protocol).
;; =============================================================================

;; -----------------------------------------------------------------------------
;; CONSTANTS -- Protocol states
;; -----------------------------------------------------------------------------

;; Normal operation: all protected operations are accepted.
(define-constant PROTOCOL-ACTIVE u1)
;; Maintenance pause: protected operations rejected; recoverable by admins.
(define-constant PROTOCOL-PAUSED u2)
;; Incident response: protected operations rejected; only the owner can exit.
(define-constant PROTOCOL-EMERGENCY u3)
;; Upgrade window: the only state in which protocol versions may change.
(define-constant PROTOCOL-UPGRADING u4)
;; Terminal state: the registry accepts no further writes, reads stay available.
(define-constant PROTOCOL-DEPRECATED u5)

;; -----------------------------------------------------------------------------
;; CONSTANTS -- Genesis versions
;; -----------------------------------------------------------------------------
;; Versions are monotonically increasing uints. These constants seed storage at
;; deployment; live values are read from the protocol-versions data var.

(define-constant PROTOCOL-VERSION u1)
(define-constant VERIFIER-VERSION u1)
(define-constant NOTE-VERSION u1)
(define-constant CIRCUIT-VERSION u2)
(define-constant COMMITMENT-VERSION u1)
(define-constant ROOT-VERSION u1)

;; -----------------------------------------------------------------------------
;; CONSTANTS -- Administrator roles
;; -----------------------------------------------------------------------------

(define-constant ROLE-PROTOCOL-ADMIN u1)
(define-constant ROLE-EMERGENCY-ADMIN u2)
(define-constant ROLE-VERIFIER-ADMIN u3)
(define-constant ROLE-FEE-ADMIN u4)

;; -----------------------------------------------------------------------------
;; CONSTANTS -- Protocol limits (defaults and hard ceilings)
;; -----------------------------------------------------------------------------

;; 1 STX expressed in micro-STX.
(define-constant ONE-STX u1000000)

;; Default shield bounds: 1 STX .. 1,000,000 STX.
(define-constant DEFAULT-MIN-SHIELD-AMOUNT ONE-STX)
(define-constant DEFAULT-MAX-SHIELD-AMOUNT u1000000000000)

;; Default withdrawal bounds: 1 STX .. 1,000,000 STX.
(define-constant DEFAULT-MIN-WITHDRAWAL-AMOUNT ONE-STX)
(define-constant DEFAULT-MAX-WITHDRAWAL-AMOUNT u1000000000000)

;; Hard capacity of the note commitment Merkle tree (depth 20 => 2^20 leaves).
;; The configurable max-commitments / max-notes limits may never exceed this;
;; the Noir circuits are compiled against this depth.
(define-constant MERKLE-TREE-CAPACITY u1048576)

(define-constant DEFAULT-MAX-COMMITMENTS MERKLE-TREE-CAPACITY)
(define-constant DEFAULT-MAX-NOTES MERKLE-TREE-CAPACITY)

;; Fees are expressed in basis points (1 bps = 0.01%).
(define-constant BPS-DENOMINATOR u10000)
;; Hard ceiling for the configurable protocol fee: 10%.
(define-constant MAX-FEE-BPS-CEILING u1000)
;; Default protocol fee ceiling: 1%.
(define-constant DEFAULT-MAX-FEE-BPS u100)

;; Hard ceiling for amount limits and for the aggregate shielded balance:
;; the maximum STX that will ever exist (1,818,000,000 STX, in micro-STX).
;; No configurable amount limit and no accounted total can legitimately
;; exceed this, which also rules out uint128 overflow in balance arithmetic.
(define-constant STX-SUPPLY-CEILING u1818000000000000)

;; -----------------------------------------------------------------------------
;; CONSTANTS -- Sentinels
;; -----------------------------------------------------------------------------

;; The all-zero hash is never a valid commitment, nullifier, or root: it is the
;; padding value of the empty Merkle tree leaves and must be rejected on input.
(define-constant ZERO-HASH 0x0000000000000000000000000000000000000000000000000000000000000000)

;; Burn address: never a valid administrator, caller, or owner.
(define-constant BURN-ADDRESS 'SP000000000000000000002Q6VF78)

;; -----------------------------------------------------------------------------
;; ERRORS -- Reserved registry space u100-u149
;; -----------------------------------------------------------------------------

;; Authorization (u100-u101)
(define-constant ERR-UNAUTHORIZED (err u100))            ;; caller lacks owner/role authority
(define-constant ERR-UNAUTHORIZED-CALLER (err u101))     ;; contract-caller not an authorized protocol contract

;; Protocol state (u102-u107)
(define-constant ERR-PROTOCOL-PAUSED (err u102))         ;; protected op while PAUSED
(define-constant ERR-PROTOCOL-EMERGENCY (err u103))      ;; protected op while EMERGENCY_PAUSED
(define-constant ERR-PROTOCOL-UPGRADING (err u104))      ;; protected op while UPGRADING
(define-constant ERR-PROTOCOL-DEPRECATED (err u105))     ;; protected op after DEPRECATED
(define-constant ERR-INVALID-PROTOCOL-STATE (err u106))  ;; operation not allowed in current state
(define-constant ERR-INVALID-STATE-TRANSITION (err u107));; transition not in the allowed table

;; Commitments (u110-u112)
(define-constant ERR-INVALID-COMMITMENT (err u110))      ;; zero / malformed commitment
(define-constant ERR-DUPLICATE-COMMITMENT (err u111))    ;; commitment already registered
(define-constant ERR-COMMITMENT-LIMIT-EXCEEDED (err u112)) ;; tree capacity limit reached

;; Nullifiers (u115-u117)
(define-constant ERR-INVALID-NULLIFIER (err u115))       ;; zero / malformed nullifier
(define-constant ERR-DUPLICATE-NULLIFIER (err u116))     ;; double spend / replay detected
(define-constant ERR-NULLIFIER-INVARIANT-VIOLATION (err u117)) ;; nullifiers would exceed commitments

;; Merkle roots (u120-u122)
(define-constant ERR-INVALID-ROOT (err u120))            ;; zero root, or root deactivated
(define-constant ERR-DUPLICATE-ROOT (err u121))          ;; root already registered
(define-constant ERR-ROOT-NOT-FOUND (err u122))          ;; root was never registered

;; Versions (u125-u126)
(define-constant ERR-INVALID-VERSION (err u125))         ;; non-monotonic or unchanged version set
(define-constant ERR-VERSION-MISMATCH (err u126))        ;; supplied version != current protocol version

;; Limits and amounts (u130-u134)
(define-constant ERR-INVALID-LIMITS (err u130))          ;; inconsistent limit configuration
(define-constant ERR-AMOUNT-BELOW-MINIMUM (err u131))
(define-constant ERR-AMOUNT-ABOVE-MAXIMUM (err u132))
(define-constant ERR-NOTE-LIMIT-EXCEEDED (err u133))
(define-constant ERR-INSUFFICIENT-SHIELDED-BALANCE (err u134))
(define-constant ERR-SHIELDED-SUPPLY-OVERFLOW (err u135))  ;; shielded total would exceed STX supply

;; Administration (u140-u148)
(define-constant ERR-INVALID-ADMINISTRATOR (err u140))   ;; burn address / owner as admin target
(define-constant ERR-INVALID-ROLE (err u141))            ;; role id outside the defined set
(define-constant ERR-ROLE-ALREADY-GRANTED (err u142))
(define-constant ERR-ROLE-NOT-GRANTED (err u143))
(define-constant ERR-CALLER-ALREADY-AUTHORIZED (err u144))
(define-constant ERR-CALLER-NOT-AUTHORIZED (err u145))
(define-constant ERR-INVALID-OWNER (err u146))           ;; burn address / current owner as new owner
(define-constant ERR-NO-PENDING-OWNER (err u147))
(define-constant ERR-NOT-PENDING-OWNER (err u148))

;; -----------------------------------------------------------------------------
;; STORAGE -- Access control
;; -----------------------------------------------------------------------------

;; Protocol owner. Holds every administrative capability and is the only
;; principal able to manage roles, authorized callers, and ownership itself.
(define-data-var owner principal tx-sender)

;; Two-step ownership transfer target. Prevents losing the protocol to a typo:
;; the new owner must actively accept before any authority moves.
(define-data-var pending-owner (optional principal) none)

;; Role grants: (account, role) -> granted. A principal may hold several roles.
(define-map administrators
  { account: principal, role: uint }
  bool
)

;; Protocol contracts allowed to perform protected writes (privacy-pool,
;; note-manager, ...). Checked against contract-caller.
(define-map authorized-callers
  principal
  bool
)

;; -----------------------------------------------------------------------------
;; STORAGE -- Protocol state, versions, limits, statistics
;; -----------------------------------------------------------------------------

;; Current protocol lifecycle state (one of the PROTOCOL-* constants).
(define-data-var protocol-state uint PROTOCOL-ACTIVE)

;; Current version of every protocol component. Updated only while UPGRADING.
(define-data-var protocol-versions
  {
    protocol: uint,
    verifier: uint,
    note: uint,
    circuit: uint,
    commitment: uint,
    root: uint,
  }
  {
    protocol: PROTOCOL-VERSION,
    verifier: VERIFIER-VERSION,
    note: NOTE-VERSION,
    circuit: CIRCUIT-VERSION,
    commitment: COMMITMENT-VERSION,
    root: ROOT-VERSION,
  }
)

;; Configurable protocol limits. Kept in one tuple so updates are atomic and
;; reads by integrating contracts are a single fetch.
(define-data-var protocol-limits
  {
    min-shield: uint,
    max-shield: uint,
    min-withdrawal: uint,
    max-withdrawal: uint,
    max-commitments: uint,
    max-notes: uint,
    max-fee-bps: uint,
  }
  {
    min-shield: DEFAULT-MIN-SHIELD-AMOUNT,
    max-shield: DEFAULT-MAX-SHIELD-AMOUNT,
    min-withdrawal: DEFAULT-MIN-WITHDRAWAL-AMOUNT,
    max-withdrawal: DEFAULT-MAX-WITHDRAWAL-AMOUNT,
    max-commitments: DEFAULT-MAX-COMMITMENTS,
    max-notes: DEFAULT-MAX-NOTES,
    max-fee-bps: DEFAULT-MAX-FEE-BPS,
  }
)

;; Transparency counters. They gate capacity limits (commitments, notes) and
;; sanity-check flows (shielded balance), but individual notes/amounts are
;; never attributable to any user.
(define-data-var protocol-statistics
  {
    total-commitments: uint,
    total-nullifiers: uint,
    total-notes: uint,
    total-transfers: uint,
    total-withdrawals: uint,
    total-shielded-stx: uint,
  }
  {
    total-commitments: u0,
    total-nullifiers: u0,
    total-notes: u0,
    total-transfers: u0,
    total-withdrawals: u0,
    total-shielded-stx: u0,
  }
)

;; -----------------------------------------------------------------------------
;; STORAGE -- Commitments, nullifiers, Merkle roots
;; -----------------------------------------------------------------------------

;; Note commitments. Append-only: entries are written with map-insert and no
;; code path ever updates or deletes them (invariant: commitments are
;; immutable). `registered` is the registration status flag; an absent key
;; means the commitment was never registered.
(define-map commitments
  (buff 32)
  {
    registered: bool,
    registered-at: uint,   ;; stacks block height of registration
    version: uint,         ;; commitment format version at registration
  }
)

;; Spent-note nullifiers. Append-only, one registration ever per nullifier:
;; this is the protocol's double-spend and replay protection. No linkage to
;; the consumed commitment is stored.
(define-map nullifiers
  (buff 32)
  {
    registered: bool,
    consumed-at: uint,     ;; stacks block height the note was consumed
  }
)

;; Every Merkle root the tree has ever had. Historical roots stay available so
;; proofs built against a recent-but-not-latest root remain verifiable.
;; `active` allows incident response to invalidate a poisoned root without
;; deleting history.
(define-map merkle-roots
  (buff 32)
  {
    version: uint,
    registered-at: uint,
    active: bool,
  }
)

;; Latest Merkle root. Starts at ZERO-HASH: the pool must post the empty-tree
;; root (a Poseidon construction the registry cannot compute) at bootstrap.
;; ZERO-HASH itself is never a known root.
(define-data-var current-root
  { root: (buff 32), version: uint, updated-at: uint }
  { root: ZERO-HASH, version: ROOT-VERSION, updated-at: u0 }
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Access control
;; -----------------------------------------------------------------------------

;; Current protocol owner.
(define-read-only (get-owner)
  (var-get owner)
)

;; Pending ownership-transfer target, if any.
(define-read-only (get-pending-owner)
  (var-get pending-owner)
)

;; True when `account` holds `role`. The owner is NOT implicitly reported here;
;; use the authorization semantics of each function (owner always authorized).
(define-read-only (has-role (account principal) (role uint))
  (default-to false (map-get? administrators { account: account, role: role }))
)

;; True when `caller` is an authorized protocol contract.
(define-read-only (is-authorized-caller (caller principal))
  (default-to false (map-get? authorized-callers caller))
)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Authorization helpers
;; -----------------------------------------------------------------------------

(define-private (is-owner (who principal))
  (is-eq who (var-get owner))
)

;; Owner or holder of `role`.
(define-private (is-admin (who principal) (role uint))
  (or (is-owner who) (has-role who role))
)

(define-private (is-protocol-caller (who principal))
  (is-authorized-caller who)
)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Protocol state helpers
;; -----------------------------------------------------------------------------

;; Gate for every protected operation. Maps each non-active state to its
;; dedicated error so integrators can distinguish pause reasons.
(define-private (check-active)
  (let ((state (var-get protocol-state)))
    (if (is-eq state PROTOCOL-ACTIVE)
      (ok true)
      (if (is-eq state PROTOCOL-PAUSED)
        ERR-PROTOCOL-PAUSED
        (if (is-eq state PROTOCOL-EMERGENCY)
          ERR-PROTOCOL-EMERGENCY
          (if (is-eq state PROTOCOL-UPGRADING)
            ERR-PROTOCOL-UPGRADING
            ERR-PROTOCOL-DEPRECATED
          )
        )
      )
    )
  )
)

;; The complete transition table of the protocol state machine. Any transition
;; not listed here is forbidden. DEPRECATED is terminal by construction: it
;; never appears as a `from` state.
(define-private (is-valid-transition (from uint) (to uint))
  (or
    ;; maintenance pause and resume
    (and (is-eq from PROTOCOL-ACTIVE) (is-eq to PROTOCOL-PAUSED))
    (and (is-eq from PROTOCOL-PAUSED) (is-eq to PROTOCOL-ACTIVE))
    ;; upgrade window: enter from pause, exit to active
    (and (is-eq from PROTOCOL-PAUSED) (is-eq to PROTOCOL-UPGRADING))
    (and (is-eq from PROTOCOL-UPGRADING) (is-eq to PROTOCOL-ACTIVE))
    ;; emergency brake from any operational state
    (and
      (is-eq to PROTOCOL-EMERGENCY)
      (or
        (is-eq from PROTOCOL-ACTIVE)
        (is-eq from PROTOCOL-PAUSED)
        (is-eq from PROTOCOL-UPGRADING)
      )
    )
    ;; emergency recovery lands in PAUSED, never directly in ACTIVE
    (and (is-eq from PROTOCOL-EMERGENCY) (is-eq to PROTOCOL-PAUSED))
    ;; permanent retirement, only from a deliberate pause
    (and (is-eq from PROTOCOL-PAUSED) (is-eq to PROTOCOL-DEPRECATED))
  )
)

;; Validates the transition against the table, applies it, and emits an event.
;; Callers are responsible for authorization and any stricter from-state
;; requirements (so that e.g. unpause cannot double as complete-upgrade).
(define-private (apply-transition (new-state uint))
  (let ((current (var-get protocol-state)))
    (if (is-valid-transition current new-state)
      (begin
        (var-set protocol-state new-state)
        (print {
          event: "protocol-state-changed",
          from: current,
          to: new-state,
          caller: contract-caller,
          height: stacks-block-height,
        })
        (ok true)
      )
      ERR-INVALID-STATE-TRANSITION
    )
  )
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Protocol state
;; -----------------------------------------------------------------------------

;; Current lifecycle state (one of the PROTOCOL-* constants).
(define-read-only (get-protocol-state)
  (var-get protocol-state)
)

;; True when the protocol accepts protected operations.
(define-read-only (is-protocol-active)
  (is-eq (var-get protocol-state) PROTOCOL-ACTIVE)
)

;; Response-typed activity check so integrating contracts can (try!) it and
;; propagate the precise pause reason.
(define-read-only (check-protocol-active)
  (check-active)
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Versions
;; -----------------------------------------------------------------------------

;; All component versions as one tuple.
(define-read-only (get-versions)
  (var-get protocol-versions)
)

(define-read-only (get-protocol-version)
  (get protocol (var-get protocol-versions))
)

(define-read-only (get-verifier-version)
  (get verifier (var-get protocol-versions))
)

(define-read-only (get-note-version)
  (get note (var-get protocol-versions))
)

(define-read-only (get-circuit-version)
  (get circuit (var-get protocol-versions))
)

(define-read-only (get-commitment-version)
  (get commitment (var-get protocol-versions))
)

(define-read-only (get-root-version)
  (get root (var-get protocol-versions))
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Limits
;; -----------------------------------------------------------------------------

;; All protocol limits as one tuple.
(define-read-only (get-protocol-limits)
  (var-get protocol-limits)
)

(define-read-only (get-min-shield-amount)
  (get min-shield (var-get protocol-limits))
)

(define-read-only (get-max-shield-amount)
  (get max-shield (var-get protocol-limits))
)

(define-read-only (get-min-withdrawal-amount)
  (get min-withdrawal (var-get protocol-limits))
)

(define-read-only (get-max-withdrawal-amount)
  (get max-withdrawal (var-get protocol-limits))
)

(define-read-only (get-max-commitments)
  (get max-commitments (var-get protocol-limits))
)

(define-read-only (get-max-notes)
  (get max-notes (var-get protocol-limits))
)

(define-read-only (get-max-fee-bps)
  (get max-fee-bps (var-get protocol-limits))
)

;; Response-typed shield amount validation for integrating contracts.
(define-read-only (validate-shield-amount (amount uint))
  (let ((limits (var-get protocol-limits)))
    (if (< amount (get min-shield limits))
      ERR-AMOUNT-BELOW-MINIMUM
      (if (> amount (get max-shield limits))
        ERR-AMOUNT-ABOVE-MAXIMUM
        (ok true)
      )
    )
  )
)

;; Response-typed withdrawal amount validation for integrating contracts.
(define-read-only (validate-withdrawal-amount (amount uint))
  (let ((limits (var-get protocol-limits)))
    (if (< amount (get min-withdrawal limits))
      ERR-AMOUNT-BELOW-MINIMUM
      (if (> amount (get max-withdrawal limits))
        ERR-AMOUNT-ABOVE-MAXIMUM
        (ok true)
      )
    )
  )
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Statistics
;; -----------------------------------------------------------------------------

;; All statistics as one tuple.
(define-read-only (get-statistics)
  (var-get protocol-statistics)
)

(define-read-only (get-total-commitments)
  (get total-commitments (var-get protocol-statistics))
)

(define-read-only (get-total-nullifiers)
  (get total-nullifiers (var-get protocol-statistics))
)

(define-read-only (get-total-notes)
  (get total-notes (var-get protocol-statistics))
)

(define-read-only (get-total-transfers)
  (get total-transfers (var-get protocol-statistics))
)

(define-read-only (get-total-withdrawals)
  (get total-withdrawals (var-get protocol-statistics))
)

(define-read-only (get-total-shielded-stx)
  (get total-shielded-stx (var-get protocol-statistics))
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Commitments
;; -----------------------------------------------------------------------------

;; Full commitment record, or none when never registered.
(define-read-only (get-commitment (commitment (buff 32)))
  (map-get? commitments commitment)
)

;; True when the commitment has been registered.
(define-read-only (is-commitment-registered (commitment (buff 32)))
  (default-to false (get registered (map-get? commitments commitment)))
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Nullifiers
;; -----------------------------------------------------------------------------

;; Full nullifier record, or none when never registered.
(define-read-only (get-nullifier (nullifier (buff 32)))
  (map-get? nullifiers nullifier)
)

;; True when the nullifier has been consumed (i.e. the note is spent).
(define-read-only (is-nullifier-spent (nullifier (buff 32)))
  (default-to false (get registered (map-get? nullifiers nullifier)))
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Merkle roots
;; -----------------------------------------------------------------------------

;; Latest root with its version and update height. A ZERO-HASH root means the
;; tree has not been bootstrapped yet.
(define-read-only (get-current-root)
  (var-get current-root)
)

;; Full record of a historical root, or none when never registered.
(define-read-only (get-root-info (root (buff 32)))
  (map-get? merkle-roots root)
)

;; True when the root was registered and is still active. Historical roots
;; remain known unless explicitly deactivated during incident response.
(define-read-only (is-known-root (root (buff 32)))
  (default-to false (get active (map-get? merkle-roots root)))
)

;; Response-typed root validation distinguishing "never existed" from
;; "deactivated", for integrating contracts and clients.
(define-read-only (validate-root (root (buff 32)))
  (match (map-get? merkle-roots root)
    info (if (get active info)
      (ok true)
      ERR-INVALID-ROOT
    )
    ERR-ROOT-NOT-FOUND
  )
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Aggregates for integrators
;; -----------------------------------------------------------------------------

;; The immutable protocol constants, exposed on-chain so integrating contracts
;; (protocol-fees needs the BPS denominator and fee ceiling; privacy-pool needs
;; the tree capacity) and the SDK never hardcode their own copies.
(define-read-only (get-protocol-constants)
  {
    merkle-tree-capacity: MERKLE-TREE-CAPACITY,
    max-fee-bps-ceiling: MAX-FEE-BPS-CEILING,
    bps-denominator: BPS-DENOMINATOR,
    stx-supply-ceiling: STX-SUPPLY-CEILING,
    zero-hash: ZERO-HASH,
  }
)

;; Full protocol snapshot in a single read: state, ownership, current root,
;; versions, limits, and statistics. One RPC round-trip for the SDK, one
;; contract-call for integrating contracts.
(define-read-only (get-protocol-info)
  {
    state: (var-get protocol-state),
    owner: (var-get owner),
    current-root: (var-get current-root),
    versions: (var-get protocol-versions),
    limits: (var-get protocol-limits),
    statistics: (var-get protocol-statistics),
  }
)

;; =============================================================================
;; PUBLIC -- Commitments
;; =============================================================================

;; Registers a note commitment. Authorized protocol contracts only.
;;
;; `version` must equal the current commitment version: a pool built for an
;; older commitment format is rejected (invariant: version mismatches fail).
;;
;; Returns (ok leaf-index): the zero-based index the commitment occupies in
;; the note Merkle tree, for the caller to perform the tree insertion.
(define-public (register-commitment (commitment (buff 32)) (version uint))
  (let (
      (stats (var-get protocol-statistics))
      (index (get total-commitments stats))
    )
    (try! (check-active))
    (asserts! (is-protocol-caller contract-caller) ERR-UNAUTHORIZED-CALLER)
    (asserts! (not (is-eq commitment ZERO-HASH)) ERR-INVALID-COMMITMENT)
    (asserts! (is-eq version (get commitment (var-get protocol-versions)))
      ERR-VERSION-MISMATCH
    )
    (asserts! (< index (get max-commitments (var-get protocol-limits)))
      ERR-COMMITMENT-LIMIT-EXCEEDED
    )
    ;; map-insert both registers and enforces uniqueness atomically: a false
    ;; return means the commitment already exists and the whole call aborts.
    (asserts!
      (map-insert commitments commitment {
        registered: true,
        registered-at: stacks-block-height,
        version: version,
      })
      ERR-DUPLICATE-COMMITMENT
    )
    (var-set protocol-statistics
      (merge stats { total-commitments: (+ index u1) })
    )
    (print {
      event: "commitment-registered",
      commitment: commitment,
      index: index,
      version: version,
      height: stacks-block-height,
    })
    (ok index)
  )
)

;; =============================================================================
;; PUBLIC -- Nullifiers
;; =============================================================================

;; Registers a spent-note nullifier. Authorized protocol contracts only.
;;
;; A nullifier can be registered exactly once, ever: re-registration is a
;; double spend or a replayed transaction and fails with
;; ERR-DUPLICATE-NULLIFIER. As defense in depth, cumulative nullifiers may
;; never exceed cumulative commitments (every spendable note was once a
;; registered commitment).
(define-public (register-nullifier (nullifier (buff 32)))
  (let ((stats (var-get protocol-statistics)))
    (try! (check-active))
    (asserts! (is-protocol-caller contract-caller) ERR-UNAUTHORIZED-CALLER)
    (asserts! (not (is-eq nullifier ZERO-HASH)) ERR-INVALID-NULLIFIER)
    ;; Duplicate detection MUST precede the count invariant: a replayed spend
    ;; is always reported as a replay, even when the ledger is at capacity.
    (asserts! (is-none (map-get? nullifiers nullifier)) ERR-DUPLICATE-NULLIFIER)
    (asserts! (< (get total-nullifiers stats) (get total-commitments stats))
      ERR-NULLIFIER-INVARIANT-VIOLATION
    )
    (asserts!
      (map-insert nullifiers nullifier {
        registered: true,
        consumed-at: stacks-block-height,
      })
      ERR-DUPLICATE-NULLIFIER
    )
    (var-set protocol-statistics
      (merge stats { total-nullifiers: (+ (get total-nullifiers stats) u1) })
    )
    (print {
      event: "nullifier-registered",
      nullifier: nullifier,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; =============================================================================
;; PUBLIC -- Merkle roots
;; =============================================================================

;; Registers a new current root. Authorized protocol contracts or the owner
;; (the owner path exists for tree bootstrap before the pool is wired up).
;;
;; `version` must equal the current root version. The previous root remains
;; registered and active for historical proof validation. Duplicate roots are
;; rejected: an append-only tree never legitimately revisits a root, and
;; re-registration would corrupt the original registration height.
(define-public (update-root (new-root (buff 32)) (version uint))
  (begin
    (try! (check-active))
    (asserts!
      (or (is-protocol-caller contract-caller) (is-owner contract-caller))
      ERR-UNAUTHORIZED-CALLER
    )
    (asserts! (not (is-eq new-root ZERO-HASH)) ERR-INVALID-ROOT)
    (asserts! (is-eq version (get root (var-get protocol-versions)))
      ERR-VERSION-MISMATCH
    )
    (asserts!
      (map-insert merkle-roots new-root {
        version: version,
        registered-at: stacks-block-height,
        active: true,
      })
      ERR-DUPLICATE-ROOT
    )
    (var-set current-root {
      root: new-root,
      version: version,
      updated-at: stacks-block-height,
    })
    (print {
      event: "root-updated",
      root: new-root,
      version: version,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Activates or deactivates a registered root. Owner or emergency admin.
;;
;; Incident-response tool: deactivating a root immediately invalidates every
;; proof built against it, in any protocol state, without erasing history.
(define-public (set-root-status (root (buff 32)) (active bool))
  (begin
    ;; Authorization is always the first gate: no storage is probed on behalf
    ;; of an unauthorized caller.
    (asserts! (is-admin contract-caller ROLE-EMERGENCY-ADMIN) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq root ZERO-HASH)) ERR-INVALID-ROOT)
    (let ((info (unwrap! (map-get? merkle-roots root) ERR-ROOT-NOT-FOUND)))
      (asserts! (not (is-eq (get active info) active)) ERR-INVALID-ROOT)
      (map-set merkle-roots root (merge info { active: active }))
      (print {
        event: "root-status-changed",
        root: root,
        active: active,
        height: stacks-block-height,
      })
      (ok true)
    )
  )
)

;; =============================================================================
;; PUBLIC -- Protocol state transitions
;; =============================================================================
;; Each function pins its expected from-state explicitly (in addition to the
;; transition table) so that a lower-privilege function can never be used to
;; perform a higher-privilege transition that shares a target state.

;; ACTIVE -> PAUSED. Owner or protocol admin.
(define-public (pause-protocol)
  (begin
    (asserts! (is-admin contract-caller ROLE-PROTOCOL-ADMIN) ERR-UNAUTHORIZED)
    (asserts! (is-eq (var-get protocol-state) PROTOCOL-ACTIVE)
      ERR-INVALID-STATE-TRANSITION
    )
    (apply-transition PROTOCOL-PAUSED)
  )
)

;; PAUSED -> ACTIVE. Owner or protocol admin. The explicit from-state check
;; prevents this from doubling as complete-upgrade (UPGRADING -> ACTIVE).
(define-public (unpause-protocol)
  (begin
    (asserts! (is-admin contract-caller ROLE-PROTOCOL-ADMIN) ERR-UNAUTHORIZED)
    (asserts! (is-eq (var-get protocol-state) PROTOCOL-PAUSED)
      ERR-INVALID-STATE-TRANSITION
    )
    (apply-transition PROTOCOL-ACTIVE)
  )
)

;; {ACTIVE, PAUSED, UPGRADING} -> EMERGENCY. Owner or emergency admin.
(define-public (emergency-pause-protocol)
  (begin
    (asserts! (is-admin contract-caller ROLE-EMERGENCY-ADMIN) ERR-UNAUTHORIZED)
    (apply-transition PROTOCOL-EMERGENCY)
  )
)

;; EMERGENCY -> PAUSED. Owner only: leaving an emergency is the highest-stakes
;; recovery decision, and it deliberately lands in PAUSED so that resuming
;; operation requires a second explicit action.
(define-public (resolve-emergency)
  (begin
    (asserts! (is-owner contract-caller) ERR-UNAUTHORIZED)
    (asserts! (is-eq (var-get protocol-state) PROTOCOL-EMERGENCY)
      ERR-INVALID-STATE-TRANSITION
    )
    (apply-transition PROTOCOL-PAUSED)
  )
)

;; PAUSED -> UPGRADING. Owner only. Opens the only window in which protocol
;; versions may change.
(define-public (begin-upgrade)
  (begin
    (asserts! (is-owner contract-caller) ERR-UNAUTHORIZED)
    (asserts! (is-eq (var-get protocol-state) PROTOCOL-PAUSED)
      ERR-INVALID-STATE-TRANSITION
    )
    (apply-transition PROTOCOL-UPGRADING)
  )
)

;; UPGRADING -> ACTIVE. Owner only.
(define-public (complete-upgrade)
  (begin
    (asserts! (is-owner contract-caller) ERR-UNAUTHORIZED)
    (asserts! (is-eq (var-get protocol-state) PROTOCOL-UPGRADING)
      ERR-INVALID-STATE-TRANSITION
    )
    (apply-transition PROTOCOL-ACTIVE)
  )
)

;; PAUSED -> DEPRECATED. Owner only. Terminal: no transition leaves
;; DEPRECATED, and every protected or administrative mutation is rejected
;; from then on. Reads (commitments, nullifiers, roots) stay available forever.
(define-public (deprecate-protocol)
  (begin
    (asserts! (is-owner contract-caller) ERR-UNAUTHORIZED)
    (asserts! (is-eq (var-get protocol-state) PROTOCOL-PAUSED)
      ERR-INVALID-STATE-TRANSITION
    )
    (apply-transition PROTOCOL-DEPRECATED)
  )
)

;; =============================================================================
;; PUBLIC -- Version management
;; =============================================================================

;; Replaces the full version set. Owner or protocol admin, UPGRADING only.
;;
;; Every component version must be >= its current value (downgrades are
;; rejected) and at least one must actually increase.
(define-public (update-versions
    (new-versions {
      protocol: uint,
      verifier: uint,
      note: uint,
      circuit: uint,
      commitment: uint,
      root: uint,
    })
  )
  (let ((current (var-get protocol-versions)))
    (asserts! (is-admin contract-caller ROLE-PROTOCOL-ADMIN) ERR-UNAUTHORIZED)
    (asserts! (is-eq (var-get protocol-state) PROTOCOL-UPGRADING)
      ERR-INVALID-PROTOCOL-STATE
    )
    (asserts!
      (and
        (>= (get protocol new-versions) (get protocol current))
        (>= (get verifier new-versions) (get verifier current))
        (>= (get note new-versions) (get note current))
        (>= (get circuit new-versions) (get circuit current))
        (>= (get commitment new-versions) (get commitment current))
        (>= (get root new-versions) (get root current))
      )
      ERR-INVALID-VERSION
    )
    (asserts! (not (is-eq new-versions current)) ERR-INVALID-VERSION)
    (var-set protocol-versions new-versions)
    (print {
      event: "versions-updated",
      versions: new-versions,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Bumps the verifier and/or circuit version. Owner or verifier admin,
;; UPGRADING only. Scoped so the verifier admin can ship a new proving stack
;; without touching unrelated component versions.
(define-public (set-verifier-versions (verifier-version uint) (circuit-version uint))
  (let ((current (var-get protocol-versions)))
    (asserts! (is-admin contract-caller ROLE-VERIFIER-ADMIN) ERR-UNAUTHORIZED)
    (asserts! (is-eq (var-get protocol-state) PROTOCOL-UPGRADING)
      ERR-INVALID-PROTOCOL-STATE
    )
    (asserts!
      (and
        (>= verifier-version (get verifier current))
        (>= circuit-version (get circuit current))
      )
      ERR-INVALID-VERSION
    )
    (asserts!
      (or
        (> verifier-version (get verifier current))
        (> circuit-version (get circuit current))
      )
      ERR-INVALID-VERSION
    )
    (var-set protocol-versions
      (merge current { verifier: verifier-version, circuit: circuit-version })
    )
    (print {
      event: "verifier-versions-updated",
      verifier: verifier-version,
      circuit: circuit-version,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; =============================================================================
;; PUBLIC -- Protocol limits
;; =============================================================================

;; Replaces the full limit set. Owner or protocol admin, any state except
;; DEPRECATED (limits may need tuning while paused or during an upgrade).
;;
;; Consistency rules:
;;   - min bounds are positive and never exceed their max bounds
;;   - capacity limits stay within the Merkle tree capacity and can never be
;;     set below what is already registered
;;   - the fee ceiling can never exceed the hard 10% cap
(define-public (update-protocol-limits
    (new-limits {
      min-shield: uint,
      max-shield: uint,
      min-withdrawal: uint,
      max-withdrawal: uint,
      max-commitments: uint,
      max-notes: uint,
      max-fee-bps: uint,
    })
  )
  (let ((stats (var-get protocol-statistics)))
    (asserts! (is-admin contract-caller ROLE-PROTOCOL-ADMIN) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq (var-get protocol-state) PROTOCOL-DEPRECATED))
      ERR-PROTOCOL-DEPRECATED
    )
    ;; During an emergency the configuration is frozen for everyone but the
    ;; owner: a compromised admin key must not be able to stage malicious
    ;; limits while the incident is being handled.
    (asserts!
      (or
        (not (is-eq (var-get protocol-state) PROTOCOL-EMERGENCY))
        (is-owner contract-caller)
      )
      ERR-PROTOCOL-EMERGENCY
    )
    (asserts! (> (get min-shield new-limits) u0) ERR-INVALID-LIMITS)
    (asserts! (>= (get max-shield new-limits) (get min-shield new-limits))
      ERR-INVALID-LIMITS
    )
    (asserts! (<= (get max-shield new-limits) STX-SUPPLY-CEILING)
      ERR-INVALID-LIMITS
    )
    (asserts! (> (get min-withdrawal new-limits) u0) ERR-INVALID-LIMITS)
    (asserts!
      (>= (get max-withdrawal new-limits) (get min-withdrawal new-limits))
      ERR-INVALID-LIMITS
    )
    (asserts! (<= (get max-withdrawal new-limits) STX-SUPPLY-CEILING)
      ERR-INVALID-LIMITS
    )
    (asserts! (> (get max-commitments new-limits) u0) ERR-INVALID-LIMITS)
    (asserts! (<= (get max-commitments new-limits) MERKLE-TREE-CAPACITY)
      ERR-INVALID-LIMITS
    )
    (asserts! (>= (get max-commitments new-limits) (get total-commitments stats))
      ERR-INVALID-LIMITS
    )
    (asserts! (> (get max-notes new-limits) u0) ERR-INVALID-LIMITS)
    (asserts! (<= (get max-notes new-limits) MERKLE-TREE-CAPACITY)
      ERR-INVALID-LIMITS
    )
    (asserts! (>= (get max-notes new-limits) (get total-notes stats))
      ERR-INVALID-LIMITS
    )
    (asserts! (<= (get max-fee-bps new-limits) MAX-FEE-BPS-CEILING)
      ERR-INVALID-LIMITS
    )
    (var-set protocol-limits new-limits)
    (print {
      event: "limits-updated",
      limits: new-limits,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Updates only the fee ceiling. Owner or fee admin: scoped so fee governance
;; never requires full protocol-admin authority.
(define-public (set-max-fee-bps (new-max-fee-bps uint))
  (begin
    (asserts! (is-admin contract-caller ROLE-FEE-ADMIN) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq (var-get protocol-state) PROTOCOL-DEPRECATED))
      ERR-PROTOCOL-DEPRECATED
    )
    ;; Same emergency lockdown as update-protocol-limits.
    (asserts!
      (or
        (not (is-eq (var-get protocol-state) PROTOCOL-EMERGENCY))
        (is-owner contract-caller)
      )
      ERR-PROTOCOL-EMERGENCY
    )
    (asserts! (<= new-max-fee-bps MAX-FEE-BPS-CEILING) ERR-INVALID-LIMITS)
    (var-set protocol-limits
      (merge (var-get protocol-limits) { max-fee-bps: new-max-fee-bps })
    )
    (print {
      event: "max-fee-bps-updated",
      max-fee-bps: new-max-fee-bps,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; =============================================================================
;; PUBLIC -- Statistics
;; =============================================================================
;; Recorded exclusively by authorized protocol contracts while ACTIVE. Only
;; aggregate values are stored; no per-user or per-note data ever enters the
;; registry.

;; Records STX entering the shielded pool. Enforces shield limits.
(define-public (record-shield (amount uint))
  (let (
      (stats (var-get protocol-statistics))
      (limits (var-get protocol-limits))
    )
    (try! (check-active))
    (asserts! (is-protocol-caller contract-caller) ERR-UNAUTHORIZED-CALLER)
    (asserts! (>= amount (get min-shield limits)) ERR-AMOUNT-BELOW-MINIMUM)
    (asserts! (<= amount (get max-shield limits)) ERR-AMOUNT-ABOVE-MAXIMUM)
    ;; Invariant: the accounted shielded total can never exceed the STX that
    ;; exists. A violation means an integrating contract is corrupted, and the
    ;; deposit must fail loudly rather than corrupt protocol accounting.
    (asserts!
      (<= (+ (get total-shielded-stx stats) amount) STX-SUPPLY-CEILING)
      ERR-SHIELDED-SUPPLY-OVERFLOW
    )
    (var-set protocol-statistics
      (merge stats {
        total-shielded-stx: (+ (get total-shielded-stx stats) amount),
      })
    )
    (print {
      event: "shield-recorded",
      amount: amount,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Records STX leaving the shielded pool. Enforces withdrawal limits and that
;; the pool can never account for more outflow than inflow.
(define-public (record-withdrawal (amount uint))
  (let (
      (stats (var-get protocol-statistics))
      (limits (var-get protocol-limits))
    )
    (try! (check-active))
    (asserts! (is-protocol-caller contract-caller) ERR-UNAUTHORIZED-CALLER)
    (asserts! (>= amount (get min-withdrawal limits)) ERR-AMOUNT-BELOW-MINIMUM)
    (asserts! (<= amount (get max-withdrawal limits)) ERR-AMOUNT-ABOVE-MAXIMUM)
    (asserts! (<= amount (get total-shielded-stx stats))
      ERR-INSUFFICIENT-SHIELDED-BALANCE
    )
    (var-set protocol-statistics
      (merge stats {
        total-shielded-stx: (- (get total-shielded-stx stats) amount),
        total-withdrawals: (+ (get total-withdrawals stats) u1),
      })
    )
    (print {
      event: "withdrawal-recorded",
      amount: amount,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Records one completed private transfer. No amounts, parties, or notes are
;; recorded -- only the aggregate count.
(define-public (record-transfer)
  (let ((stats (var-get protocol-statistics)))
    (try! (check-active))
    (asserts! (is-protocol-caller contract-caller) ERR-UNAUTHORIZED-CALLER)
    (var-set protocol-statistics
      (merge stats { total-transfers: (+ (get total-transfers stats) u1) })
    )
    (print { event: "transfer-recorded", height: stacks-block-height })
    (ok true)
  )
)

;; Records the creation of one shielded note. Enforces the note capacity limit.
(define-public (record-note-created)
  (let (
      (stats (var-get protocol-statistics))
      (limits (var-get protocol-limits))
    )
    (try! (check-active))
    (asserts! (is-protocol-caller contract-caller) ERR-UNAUTHORIZED-CALLER)
    (asserts! (< (get total-notes stats) (get max-notes limits))
      ERR-NOTE-LIMIT-EXCEEDED
    )
    (var-set protocol-statistics
      (merge stats { total-notes: (+ (get total-notes stats) u1) })
    )
    (print { event: "note-created-recorded", height: stacks-block-height })
    (ok true)
  )
)

;; =============================================================================
;; PUBLIC -- Administration
;; =============================================================================

;; Grants `role` to `account`. Owner only. The owner never appears in the role
;; map: ownership already carries every capability, and keeping the owner out
;; of the map means revocations can never silently strip owner authority.
(define-public (grant-role (account principal) (role uint))
  (begin
    (asserts! (is-owner contract-caller) ERR-UNAUTHORIZED)
    (asserts!
      (or
        (is-eq role ROLE-PROTOCOL-ADMIN)
        (is-eq role ROLE-EMERGENCY-ADMIN)
        (is-eq role ROLE-VERIFIER-ADMIN)
        (is-eq role ROLE-FEE-ADMIN)
      )
      ERR-INVALID-ROLE
    )
    (asserts! (not (is-eq account BURN-ADDRESS)) ERR-INVALID-ADMINISTRATOR)
    (asserts! (not (is-eq account (var-get owner))) ERR-INVALID-ADMINISTRATOR)
    (asserts! (map-insert administrators { account: account, role: role } true)
      ERR-ROLE-ALREADY-GRANTED
    )
    (print {
      event: "role-granted",
      account: account,
      role: role,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Revokes `role` from `account`. Owner only.
(define-public (revoke-role (account principal) (role uint))
  (begin
    (asserts! (is-owner contract-caller) ERR-UNAUTHORIZED)
    (asserts!
      (or
        (is-eq role ROLE-PROTOCOL-ADMIN)
        (is-eq role ROLE-EMERGENCY-ADMIN)
        (is-eq role ROLE-VERIFIER-ADMIN)
        (is-eq role ROLE-FEE-ADMIN)
      )
      ERR-INVALID-ROLE
    )
    (asserts! (map-delete administrators { account: account, role: role })
      ERR-ROLE-NOT-GRANTED
    )
    (print {
      event: "role-revoked",
      account: account,
      role: role,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Authorizes a protocol contract for protected writes. Owner only.
(define-public (add-authorized-caller (caller principal))
  (begin
    (asserts! (is-owner contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq caller BURN-ADDRESS)) ERR-INVALID-ADMINISTRATOR)
    (asserts! (map-insert authorized-callers caller true)
      ERR-CALLER-ALREADY-AUTHORIZED
    )
    (print {
      event: "caller-authorized",
      caller: caller,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Removes a protocol contract from the allowlist. Owner only.
(define-public (remove-authorized-caller (caller principal))
  (begin
    (asserts! (is-owner contract-caller) ERR-UNAUTHORIZED)
    (asserts! (map-delete authorized-callers caller) ERR-CALLER-NOT-AUTHORIZED)
    (print {
      event: "caller-deauthorized",
      caller: caller,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Step 1 of ownership transfer: the current owner nominates a successor.
;; Authority does NOT move until the successor accepts.
(define-public (transfer-ownership (new-owner principal))
  (begin
    (asserts! (is-owner contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq new-owner BURN-ADDRESS)) ERR-INVALID-OWNER)
    (asserts! (not (is-eq new-owner (var-get owner))) ERR-INVALID-OWNER)
    (var-set pending-owner (some new-owner))
    (print {
      event: "ownership-transfer-initiated",
      current-owner: (var-get owner),
      pending-owner: new-owner,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Step 2 of ownership transfer: the nominated successor claims ownership.
(define-public (accept-ownership)
  (let ((pending (unwrap! (var-get pending-owner) ERR-NO-PENDING-OWNER)))
    (asserts! (is-eq contract-caller pending) ERR-NOT-PENDING-OWNER)
    (var-set owner pending)
    (var-set pending-owner none)
    (print {
      event: "ownership-transferred",
      new-owner: pending,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Aborts a pending ownership transfer. Owner only.
(define-public (cancel-ownership-transfer)
  (begin
    (asserts! (is-owner contract-caller) ERR-UNAUTHORIZED)
    (asserts! (is-some (var-get pending-owner)) ERR-NO-PENDING-OWNER)
    (var-set pending-owner none)
    (print {
      event: "ownership-transfer-cancelled",
      height: stacks-block-height,
    })
    (ok true)
  )
)
