;; =============================================================================
;; asset-registry.clar
;; =============================================================================
;; STX Shield -- SIP-10 Asset Registry (v1.0.0)
;;
;; The single source of truth for every SIP-10 asset the privacy layer supports.
;; It is a WHITELIST WITH CONFIG and nothing more: it approves assets and stores
;; their protocol parameters. It owns NO protocol state -- no commitments, notes,
;; Merkle trees, nullifiers, balances, fees collected, or proof verification.
;; Those live in their existing layers and are shared, unchanged, with STX.
;;
;; Per asset it stores:
;;   token principal, name, decimals, status, per-asset limits (min/max shield,
;;   min/max note), per-(fee-type) fee configuration, fee recipient, version.
;;
;; Authority model -- ZERO local authority state (mirrors protocol-fees.clar):
;;   privacy-registry.clar (FROZEN) is the single source of truth.
;;     - asset registration / metadata / limits / status:  PROTOCOL-ADMIN or owner
;;     - fee configuration / fee recipient:                 FEE-ADMIN or owner
;;   All checks use `contract-caller`.
;;
;; Immutability invariant: an asset-id <-> token-principal binding is a bijection
;; and is NEVER remapped once created. The SIP-10 circuits bind `asset_id` inside
;; the proof, so remapping would break the cryptographic asset guarantee -- it is
;; therefore structurally impossible here (no function rewrites `token`).
;;
;; Error space: u400-u449 (reserved for asset-registry across the protocol).
;; =============================================================================

(use-trait sip-010-trait .sip-010-trait.sip-010-trait)

;; -----------------------------------------------------------------------------
;; CONSTANTS
;; -----------------------------------------------------------------------------

(define-constant CONTRACT-VERSION u1)

;; Asset schema version this registry understands. Registration of any other
;; version is rejected, so a future schema change is an explicit, gated upgrade.
(define-constant SUPPORTED-ASSET-VERSION u1)

;; Decimals sanity ceiling (SIP-010 values in practice are 0..18).
(define-constant MAX-DECIMALS u18)

;; Asset lifecycle status.
(define-constant ASSET-ACTIVE u1)      ;; shieldable + spendable
(define-constant ASSET-DISABLED u2)    ;; NOT shieldable; still fully spendable
(define-constant ASSET-DEPRECATED u3)  ;; terminal; NOT shieldable; still spendable (never trap funds)

;; Fee types (one per user operation). Mirrors the SIP-10 pool operations.
(define-constant FEE-TYPE-SHIELD u1)
(define-constant FEE-TYPE-TRANSFER u2)
(define-constant FEE-TYPE-WITHDRAWAL u3)
(define-constant FEE-TYPE-SPLIT u4)
(define-constant FEE-TYPE-MERGE u5)

;; Mirrors of the frozen registry role ids (stable public API).
(define-constant REGISTRY-ROLE-PROTOCOL-ADMIN u1)
(define-constant REGISTRY-ROLE-FEE-ADMIN u4)

;; Burn address: never a valid token or fee recipient.
(define-constant BURN-ADDRESS 'SP000000000000000000002Q6VF78)

;; Default fee config assigned at registration: free (like protocol-fees launch).
(define-constant ZERO-FEE { bps: u0, flat: u0, enabled: true })

;; -----------------------------------------------------------------------------
;; ERRORS -- Reserved asset-registry space u400-u449
;; -----------------------------------------------------------------------------

(define-constant ERR-UNAUTHORIZED (err u400))         ;; caller lacks registry owner/role authority
(define-constant ERR-PRINCIPAL-EXISTS (err u401))     ;; token principal already registered
(define-constant ERR-UNKNOWN-ASSET (err u402))        ;; no asset for this id
(define-constant ERR-INVALID-DECIMALS (err u403))     ;; decimals above the sanity ceiling
(define-constant ERR-DECIMALS-MISMATCH (err u404))    ;; token.get-decimals != declared decimals
(define-constant ERR-INVALID-LIMITS (err u405))       ;; limit set fails the ordering rules
(define-constant ERR-INVALID-RECIPIENT (err u406))    ;; burn address as fee recipient
(define-constant ERR-UNSUPPORTED-VERSION (err u407))  ;; asset schema version not supported
(define-constant ERR-INVALID-TOKEN (err u408))        ;; token is this contract, or get-decimals failed
(define-constant ERR-FEE-ABOVE-CEILING (err u409))    ;; bps above the registry max, or flat above max-shield
(define-constant ERR-UNKNOWN-FEE-TYPE (err u410))     ;; fee type outside the defined set
(define-constant ERR-INVALID-NAME (err u411))         ;; empty asset name
(define-constant ERR-STATUS-UNCHANGED (err u412))     ;; status set is a no-op
(define-constant ERR-ASSET-DEPRECATED (err u413))     ;; cannot modify a deprecated asset

;; -----------------------------------------------------------------------------
;; STORAGE
;; -----------------------------------------------------------------------------

;; asset-id -> full metadata. `token` is immutable once written.
(define-map assets
  uint
  {
    token: principal,
    name: (string-ascii 32),
    decimals: uint,
    status: uint,
    min-shield: uint,
    max-shield: uint,
    min-note: uint,      ;; dust floor for any note / operation output
    max-note: uint,      ;; per-note cap; u0 = no cap
    fee-recipient: principal,
    version: uint,
  }
)

;; token principal -> asset-id. Enforces one-asset-per-token and powers reverse
;; lookups (the pool derives asset_id from the token, then resolves config).
(define-map principal-to-id principal uint)

;; (asset-id, fee-type) -> fee configuration. Read by sip10-protocol-fees.
(define-map asset-fee-configs
  { asset-id: uint, fee-type: uint }
  { bps: uint, flat: uint, enabled: bool }
)

;; Monotonic id allocator. Ids are never reused (append-only), preserving the
;; asset_id <-> token bijection for the circuits.
(define-data-var next-asset-id uint u1)
(define-data-var asset-count uint u0)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Authority (delegated to the frozen registry)
;; -----------------------------------------------------------------------------

(define-private (is-registry-owner (who principal))
  (is-eq who (contract-call? .privacy-registry get-owner))
)

(define-private (is-protocol-admin (who principal))
  (or
    (is-registry-owner who)
    (contract-call? .privacy-registry has-role who REGISTRY-ROLE-PROTOCOL-ADMIN)
  )
)

(define-private (is-fee-admin (who principal))
  (or
    (is-registry-owner who)
    (contract-call? .privacy-registry has-role who REGISTRY-ROLE-FEE-ADMIN)
  )
)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Validation
;; -----------------------------------------------------------------------------

(define-private (is-valid-fee-type (fee-type uint))
  (or
    (is-eq fee-type FEE-TYPE-SHIELD)
    (is-eq fee-type FEE-TYPE-TRANSFER)
    (is-eq fee-type FEE-TYPE-WITHDRAWAL)
    (is-eq fee-type FEE-TYPE-SPLIT)
    (is-eq fee-type FEE-TYPE-MERGE)
  )
)

;; Limit ordering: positive floors, max >= min, note cap either unbounded (0) or
;; at least the note floor. Shield bounds also bound notes (min-note <= max-shield).
(define-private (valid-limits (min-shield uint) (max-shield uint) (min-note uint) (max-note uint))
  (and
    (> min-shield u0)
    (>= max-shield min-shield)
    (> min-note u0)
    (<= min-note max-shield)
    (or (is-eq max-note u0) (>= max-note min-note))
  )
)

;; -----------------------------------------------------------------------------
;; READ-ONLY
;; -----------------------------------------------------------------------------

(define-read-only (get-asset (asset-id uint))
  (map-get? assets asset-id)
)

(define-read-only (get-asset-id-by-principal (token principal))
  (map-get? principal-to-id token)
)

(define-read-only (is-asset-known (asset-id uint))
  (is-some (map-get? assets asset-id))
)

(define-read-only (get-asset-status (asset-id uint))
  (match (map-get? assets asset-id) a (some (get status a)) none)
)

;; May a NEW shield be created for this asset? Only in the ACTIVE state.
(define-read-only (can-shield (asset-id uint))
  (match (map-get? assets asset-id) a (is-eq (get status a) ASSET-ACTIVE) false)
)

;; May existing notes of this asset be spent (withdraw/transfer/split/merge)?
;; Any known asset, in ANY status -- funds are never trapped by governance.
(define-read-only (can-spend (asset-id uint))
  (is-some (map-get? assets asset-id))
)

(define-read-only (get-asset-fee-config (asset-id uint) (fee-type uint))
  (map-get? asset-fee-configs { asset-id: asset-id, fee-type: fee-type })
)

(define-read-only (get-asset-fee-recipient (asset-id uint))
  (match (map-get? assets asset-id) a (some (get fee-recipient a)) none)
)

(define-read-only (get-asset-count)
  (var-get asset-count)
)

(define-read-only (get-registry-version)
  CONTRACT-VERSION
)

;; -----------------------------------------------------------------------------
;; PUBLIC -- Registration (PROTOCOL-ADMIN or owner)
;; -----------------------------------------------------------------------------

;; Registers a SIP-10 asset and returns its new asset-id. The token is supplied
;; as a trait so the compiler proves conformance, the principal is taken from it
;; (never trusted from a raw argument), and its live `get-decimals` must match the
;; declared value -- a defence against malformed or mismatched token metadata.
;; Fee configs for all types start free (0 bps / 0 flat, enabled).
(define-public (register-asset
    (token <sip-010-trait>)
    (name (string-ascii 32))
    (decimals uint)
    (min-shield uint)
    (max-shield uint)
    (min-note uint)
    (max-note uint)
    (fee-recipient principal)
    (version uint)
  )
  (let (
      (token-principal (contract-of token))
      (id (var-get next-asset-id))
    )
    (asserts! (is-protocol-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (is-eq version SUPPORTED-ASSET-VERSION) ERR-UNSUPPORTED-VERSION)
    (asserts! (> (len name) u0) ERR-INVALID-NAME)
    (asserts! (<= decimals MAX-DECIMALS) ERR-INVALID-DECIMALS)
    (asserts! (not (is-eq token-principal (as-contract tx-sender))) ERR-INVALID-TOKEN)
    (asserts! (is-none (map-get? principal-to-id token-principal)) ERR-PRINCIPAL-EXISTS)
    (asserts! (valid-limits min-shield max-shield min-note max-note) ERR-INVALID-LIMITS)
    (asserts! (not (is-eq fee-recipient BURN-ADDRESS)) ERR-INVALID-RECIPIENT)
    ;; The token must actually be this SIP-010 and report the declared decimals.
    (asserts!
      (is-eq (unwrap! (contract-call? token get-decimals) ERR-INVALID-TOKEN) decimals)
      ERR-DECIMALS-MISMATCH
    )
    (map-set assets id {
      token: token-principal,
      name: name,
      decimals: decimals,
      status: ASSET-ACTIVE,
      min-shield: min-shield,
      max-shield: max-shield,
      min-note: min-note,
      max-note: max-note,
      fee-recipient: fee-recipient,
      version: version,
    })
    (map-set principal-to-id token-principal id)
    (map-set asset-fee-configs { asset-id: id, fee-type: FEE-TYPE-SHIELD } ZERO-FEE)
    (map-set asset-fee-configs { asset-id: id, fee-type: FEE-TYPE-TRANSFER } ZERO-FEE)
    (map-set asset-fee-configs { asset-id: id, fee-type: FEE-TYPE-WITHDRAWAL } ZERO-FEE)
    (map-set asset-fee-configs { asset-id: id, fee-type: FEE-TYPE-SPLIT } ZERO-FEE)
    (map-set asset-fee-configs { asset-id: id, fee-type: FEE-TYPE-MERGE } ZERO-FEE)
    (var-set next-asset-id (+ id u1))
    (var-set asset-count (+ (var-get asset-count) u1))
    (print {
      event: "asset-registered",
      asset-id: id,
      token: token-principal,
      name: name,
      decimals: decimals,
      height: stacks-block-height,
    })
    (ok id)
  )
)

;; -----------------------------------------------------------------------------
;; PUBLIC -- Status & limits (PROTOCOL-ADMIN or owner)
;; -----------------------------------------------------------------------------

;; Enable (ACTIVE) or disable (DISABLED) shielding for an asset. Disabling never
;; affects spendability. A deprecated asset is terminal and cannot be re-enabled.
(define-public (set-asset-enabled (asset-id uint) (enabled bool))
  (let ((asset (unwrap! (map-get? assets asset-id) ERR-UNKNOWN-ASSET))
        (new-status (if enabled ASSET-ACTIVE ASSET-DISABLED)))
    (asserts! (is-protocol-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq (get status asset) ASSET-DEPRECATED)) ERR-ASSET-DEPRECATED)
    (asserts! (not (is-eq (get status asset) new-status)) ERR-STATUS-UNCHANGED)
    (map-set assets asset-id (merge asset { status: new-status }))
    (print {
      event: "asset-status-changed",
      asset-id: asset-id,
      status: new-status,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Permanently deprecate an asset: no new shields ever, existing notes still fully
;; spendable. Terminal -- there is no path back to ACTIVE.
(define-public (deprecate-asset (asset-id uint))
  (let ((asset (unwrap! (map-get? assets asset-id) ERR-UNKNOWN-ASSET)))
    (asserts! (is-protocol-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq (get status asset) ASSET-DEPRECATED)) ERR-STATUS-UNCHANGED)
    (map-set assets asset-id (merge asset { status: ASSET-DEPRECATED }))
    (print { event: "asset-deprecated", asset-id: asset-id, height: stacks-block-height })
    (ok true)
  )
)

;; Update an asset's amount limits. Token principal and decimals are immutable.
(define-public (set-asset-limits
    (asset-id uint)
    (min-shield uint)
    (max-shield uint)
    (min-note uint)
    (max-note uint)
  )
  (let ((asset (unwrap! (map-get? assets asset-id) ERR-UNKNOWN-ASSET)))
    (asserts! (is-protocol-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq (get status asset) ASSET-DEPRECATED)) ERR-ASSET-DEPRECATED)
    (asserts! (valid-limits min-shield max-shield min-note max-note) ERR-INVALID-LIMITS)
    (map-set assets asset-id (merge asset {
      min-shield: min-shield,
      max-shield: max-shield,
      min-note: min-note,
      max-note: max-note,
    }))
    (print {
      event: "asset-limits-updated",
      asset-id: asset-id,
      min-shield: min-shield,
      max-shield: max-shield,
      min-note: min-note,
      max-note: max-note,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; -----------------------------------------------------------------------------
;; PUBLIC -- Fee configuration (FEE-ADMIN or owner)
;; -----------------------------------------------------------------------------

;; Set the per-(asset, fee-type) fee. The bps component is double-capped: it can
;; never exceed the frozen registry's live max-fee-bps (the same governance
;; ceiling STX fees obey). The flat component (asset base units) can never exceed
;; the asset's own max-shield -- a fee can never exceed a maximal deposit.
(define-public (set-asset-fee-config
    (asset-id uint)
    (fee-type uint)
    (bps uint)
    (flat uint)
    (enabled bool)
  )
  (let ((asset (unwrap! (map-get? assets asset-id) ERR-UNKNOWN-ASSET)))
    (asserts! (is-fee-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq (get status asset) ASSET-DEPRECATED)) ERR-ASSET-DEPRECATED)
    (asserts! (is-valid-fee-type fee-type) ERR-UNKNOWN-FEE-TYPE)
    (asserts! (<= bps (contract-call? .privacy-registry get-max-fee-bps)) ERR-FEE-ABOVE-CEILING)
    (asserts! (<= flat (get max-shield asset)) ERR-FEE-ABOVE-CEILING)
    (map-set asset-fee-configs
      { asset-id: asset-id, fee-type: fee-type }
      { bps: bps, flat: flat, enabled: enabled }
    )
    (print {
      event: "asset-fee-updated",
      asset-id: asset-id,
      fee-type: fee-type,
      bps: bps,
      flat: flat,
      enabled: enabled,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; Update the destination the collected token fees for this asset are paid to.
(define-public (set-asset-fee-recipient (asset-id uint) (fee-recipient principal))
  (let ((asset (unwrap! (map-get? assets asset-id) ERR-UNKNOWN-ASSET)))
    (asserts! (is-fee-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (is-eq (get status asset) ASSET-DEPRECATED)) ERR-ASSET-DEPRECATED)
    (asserts! (not (is-eq fee-recipient BURN-ADDRESS)) ERR-INVALID-RECIPIENT)
    (map-set assets asset-id (merge asset { fee-recipient: fee-recipient }))
    (print {
      event: "asset-fee-recipient-updated",
      asset-id: asset-id,
      fee-recipient: fee-recipient,
      height: stacks-block-height,
    })
    (ok true)
  )
)
