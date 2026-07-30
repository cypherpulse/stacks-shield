;; =============================================================================
;; protocol-fees.clar
;; =============================================================================
;; STX Shield -- Protocol Fees & Treasury (v1.0.0)
;;
;; The fee layer of STX Shield. Owns exactly one thing: fee configuration,
;; fee collection, and the protocol treasury.
;;
;;   - Fee configuration   (per fee type, basis points, enable switches)
;;   - Fee collection      (single accounting entry point for all fee STX)
;;   - Treasury management (accounted balance, owner-gated withdrawals)
;;   - Emergency controls  (fee freeze, treasury-withdrawal freeze)
;;
;; Fee types: SHIELD, TRANSFER, WITHDRAWAL, and RELAYER (reserved for the
;; future relayer network -- configured and collectable today, unused by the
;; v1 pool).
;;
;; Authority model -- ZERO local authority state:
;;   privacy-registry.clar v1.0.0 (SECURITY FROZEN) is the single source of
;;   truth. This contract stores no owner, no roles, no allowlist:
;;     - fee configuration:      registry fee admin or owner
;;     - fee collection:         registry authorized callers (privacy-pool)
;;     - treasury withdrawals:   registry owner ONLY
;;     - freezes:                registry emergency admin or owner
;;   All checks use `contract-caller`, never tx-sender (except STX movement,
;;   where tx-sender is by definition the paying party).
;;
;; Fee ceiling -- DOUBLE enforcement:
;;   1. set-fee rejects any bps above the registry's live max-fee-bps.
;;   2. calculate-fee clamps the configured bps to the registry's live
;;      max-fee-bps at charge time, so lowering the ceiling in the registry
;;      instantly caps every fee even before configs are updated.
;;   Users can never be overcharged past the governance ceiling.
;;
;; Overflow safety: amount <= STX supply (~1.8e15 uSTX) and bps <= 10000,
;; so amount * bps <= ~1.8e19, far below the uint128 maximum. Division is
;; floor division: rounding always favors the user.
;;
;; Error space: u200-u249 (reserved for fee errors across the protocol).
;; =============================================================================

;; -----------------------------------------------------------------------------
;; CONSTANTS -- Fee types
;; -----------------------------------------------------------------------------

(define-constant FEE-TYPE-SHIELD u1)
(define-constant FEE-TYPE-TRANSFER u2)
(define-constant FEE-TYPE-WITHDRAWAL u3)
;; Reserved for the future relayer network (Milestone 8).
(define-constant FEE-TYPE-RELAYER u4)

;; -----------------------------------------------------------------------------
;; CONSTANTS -- Identity, registry interface, math
;; -----------------------------------------------------------------------------

(define-constant CONTRACT-VERSION u1)

;; Basis-point denominator: 10000 bps = 100%.
(define-constant BPS-DENOMINATOR u10000)

;; Hard ceiling for the flat fee component: 10 STX. Flat fees exist because
;; private-transfer amounts are hidden -- a percentage of an unknown amount
;; is uncomputable, so transfers charge flat only.
(define-constant FLAT-FEE-CEILING u10000000)

;; Mirrors of the frozen registry's role ids (stable public API).
(define-constant REGISTRY-ROLE-EMERGENCY-ADMIN u2)
(define-constant REGISTRY-ROLE-FEE-ADMIN u4)

;; Burn address: never a valid fee recipient.
(define-constant BURN-ADDRESS 'SP000000000000000000002Q6VF78)

;; -----------------------------------------------------------------------------
;; ERRORS -- Reserved fee space u200-u249
;; -----------------------------------------------------------------------------

(define-constant ERR-UNAUTHORIZED (err u200))          ;; caller lacks registry owner/role authority
(define-constant ERR-UNAUTHORIZED-CALLER (err u201))   ;; contract-caller not on the registry allowlist
(define-constant ERR-FEES-FROZEN (err u202))           ;; fee collection is frozen
(define-constant ERR-TREASURY-FROZEN (err u203))       ;; treasury withdrawals are frozen
(define-constant ERR-UNKNOWN-FEE-TYPE (err u204))      ;; fee type outside the defined set
(define-constant ERR-FEE-ABOVE-CEILING (err u205))     ;; bps above the registry's max-fee-bps
(define-constant ERR-ZERO-AMOUNT (err u206))           ;; zero-amount collection or withdrawal
(define-constant ERR-INSUFFICIENT-TREASURY (err u207)) ;; withdrawal exceeds accounted treasury
(define-constant ERR-STX-TRANSFER-FAILED (err u208))   ;; underlying STX transfer failed
(define-constant ERR-INVALID-RECIPIENT (err u209))     ;; burn address as recipient

;; -----------------------------------------------------------------------------
;; STORAGE -- Fee configuration
;; -----------------------------------------------------------------------------

;; Per-type fee configuration: fee = flat + amount * bps / 10000. All types
;; launch at zero (free protocol); the fee admin raises them within the
;; registry bps ceiling and the hard flat ceiling.
(define-map fee-configs
  uint  ;; fee type
  {
    bps: uint,      ;; percentage component in basis points
    flat: uint,     ;; flat component in uSTX (the only component transfers use)
    enabled: bool,  ;; disabled types always charge zero
  }
)

;; -----------------------------------------------------------------------------
;; STORAGE -- Treasury accounting
;; -----------------------------------------------------------------------------

;; Aggregate treasury accounting. `balance` is the accounted STX held by this
;; contract; it must always equal the contract's actual STX balance (exposed
;; side by side in get-treasury for monitoring).
(define-data-var treasury
  { total-collected: uint, total-withdrawn: uint, balance: uint }
  { total-collected: u0, total-withdrawn: u0, balance: u0 }
)

;; Per-type collection totals for transparency.
(define-map fee-type-stats
  uint
  { collected: uint }
)

;; -----------------------------------------------------------------------------
;; STORAGE -- Emergency switches
;; -----------------------------------------------------------------------------

;; When true, collect-fee rejects everything: with non-zero fees configured
;; this halts every fee-charging pool operation (an intentional emergency
;; lever); with zero fees the pool skips collection and continues.
(define-data-var fees-frozen bool false)

;; When true, treasury withdrawals are rejected (owner included).
(define-data-var treasury-frozen bool false)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Authority (fully delegated to the frozen registry)
;; -----------------------------------------------------------------------------

(define-private (is-registry-owner (who principal))
  (is-eq who (contract-call? .privacy-registry get-owner))
)

(define-private (is-fee-admin (who principal))
  (or
    (is-registry-owner who)
    (contract-call? .privacy-registry has-role who REGISTRY-ROLE-FEE-ADMIN)
  )
)

(define-private (is-emergency-admin (who principal))
  (or
    (is-registry-owner who)
    (contract-call? .privacy-registry has-role who REGISTRY-ROLE-EMERGENCY-ADMIN)
  )
)

(define-private (is-authorized-protocol-caller (who principal))
  (contract-call? .privacy-registry is-authorized-caller who)
)

;; -----------------------------------------------------------------------------
;; PRIVATE -- Fee math
;; -----------------------------------------------------------------------------

(define-private (is-valid-fee-type (fee-type uint))
  (or
    (is-eq fee-type FEE-TYPE-SHIELD)
    (is-eq fee-type FEE-TYPE-TRANSFER)
    (is-eq fee-type FEE-TYPE-WITHDRAWAL)
    (is-eq fee-type FEE-TYPE-RELAYER)
  )
)

;; Charge-time clamp: the registry's live max-fee-bps always wins over the
;; stored configuration, so a lowered governance ceiling applies instantly.
(define-private (effective-bps (configured uint))
  (let ((ceiling (contract-call? .privacy-registry get-max-fee-bps)))
    (if (> configured ceiling) ceiling configured)
  )
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Fee configuration and calculation
;; -----------------------------------------------------------------------------

;; Raw stored configuration for a fee type, or none for unknown types.
(define-read-only (get-fee-config (fee-type uint))
  (map-get? fee-configs fee-type)
)

;; The fee charged right now for `amount` under `fee-type`: flat component
;; plus the percentage component clamped to the registry ceiling; zero when
;; disabled; floor-rounded percentage (favors the user).
(define-read-only (calculate-fee (fee-type uint) (amount uint))
  (match (map-get? fee-configs fee-type)
    config (if (get enabled config)
      (ok (+
        (get flat config)
        (/ (* amount (effective-bps (get bps config))) BPS-DENOMINATOR)
      ))
      (ok u0)
    )
    ERR-UNKNOWN-FEE-TYPE
  )
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Treasury and status
;; -----------------------------------------------------------------------------

;; Treasury accounting next to the actual on-chain balance. The two balance
;; figures must always be equal; monitoring should alert on divergence.
(define-read-only (get-treasury)
  {
    total-collected: (get total-collected (var-get treasury)),
    total-withdrawn: (get total-withdrawn (var-get treasury)),
    balance: (get balance (var-get treasury)),
    actual-balance: (stx-get-balance (as-contract tx-sender)),
  }
)

;; Cumulative collections for one fee type.
(define-read-only (get-fee-type-stats (fee-type uint))
  (default-to { collected: u0 } (map-get? fee-type-stats fee-type))
)

(define-read-only (is-fees-frozen)
  (var-get fees-frozen)
)

(define-read-only (is-treasury-frozen)
  (var-get treasury-frozen)
)

(define-read-only (get-fees-contract-version)
  CONTRACT-VERSION
)

;; One-read snapshot for the SDK.
(define-read-only (get-fees-info)
  {
    contract-version: CONTRACT-VERSION,
    fees-frozen: (var-get fees-frozen),
    treasury-frozen: (var-get treasury-frozen),
    max-fee-bps: (contract-call? .privacy-registry get-max-fee-bps),
    shield-fee: (map-get? fee-configs FEE-TYPE-SHIELD),
    transfer-fee: (map-get? fee-configs FEE-TYPE-TRANSFER),
    withdrawal-fee: (map-get? fee-configs FEE-TYPE-WITHDRAWAL),
    relayer-fee: (map-get? fee-configs FEE-TYPE-RELAYER),
    treasury: (var-get treasury),
  }
)

;; =============================================================================
;; PUBLIC -- Fee configuration (registry fee admin or owner)
;; =============================================================================

;; Sets the fee for one fee type. The bps component can never exceed the
;; registry's live max-fee-bps ceiling (itself hard-capped at 10%); the flat
;; component can never exceed the 10 STX hard ceiling.
(define-public (set-fee (fee-type uint) (bps uint) (flat uint) (enabled bool))
  (begin
    (asserts! (is-fee-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (is-valid-fee-type fee-type) ERR-UNKNOWN-FEE-TYPE)
    (asserts! (<= bps (contract-call? .privacy-registry get-max-fee-bps))
      ERR-FEE-ABOVE-CEILING
    )
    (asserts! (<= flat FLAT-FEE-CEILING) ERR-FEE-ABOVE-CEILING)
    (map-set fee-configs fee-type { bps: bps, flat: flat, enabled: enabled })
    (print {
      event: "fee-updated",
      fee-type: fee-type,
      bps: bps,
      flat: flat,
      enabled: enabled,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; =============================================================================
;; PUBLIC -- Fee collection (authorized protocol contracts)
;; =============================================================================

;; THE single entry point for fee STX. Transfers `amount` from tx-sender
;; (the user for shield/transfer fees, the pool contract for withdrawal fees
;; paid out of shielded value) into the treasury and records it.
;;
;; Only registry-authorized contracts (privacy-pool) may invoke this, so the
;; accounting can never be inflated by third parties -- and the protocol
;; state must be ACTIVE, mirroring the gate on every protected operation.
(define-public (collect-fee (fee-type uint) (amount uint))
  (let ((stats (get-fee-type-stats fee-type)))
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (not (var-get fees-frozen)) ERR-FEES-FROZEN)
    (asserts! (is-authorized-protocol-caller contract-caller)
      ERR-UNAUTHORIZED-CALLER
    )
    (asserts! (is-valid-fee-type fee-type) ERR-UNKNOWN-FEE-TYPE)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (unwrap! (stx-transfer? amount tx-sender (as-contract tx-sender))
      ERR-STX-TRANSFER-FAILED
    )
    (var-set treasury
      (merge (var-get treasury) {
        total-collected: (+ (get total-collected (var-get treasury)) amount),
        balance: (+ (get balance (var-get treasury)) amount),
      })
    )
    (map-set fee-type-stats fee-type
      { collected: (+ (get collected stats) amount) }
    )
    (print {
      event: "fee-collected",
      fee-type: fee-type,
      amount: amount,
      payer: tx-sender,
      height: stacks-block-height,
    })
    (ok amount)
  )
)

;; =============================================================================
;; PUBLIC -- Treasury withdrawals (registry owner ONLY)
;; =============================================================================

;; Moves accounted treasury STX to `recipient`. Owner-only: treasury custody
;; is the highest-stakes fee decision and is deliberately NOT delegated to
;; the fee admin. Works in any protocol state unless the treasury is frozen
;; (funds recovery must remain possible while paused).
(define-public (withdraw-fees (amount uint) (recipient principal))
  (let ((t (var-get treasury)))
    (asserts! (is-registry-owner contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (var-get treasury-frozen)) ERR-TREASURY-FROZEN)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (asserts! (not (is-eq recipient BURN-ADDRESS)) ERR-INVALID-RECIPIENT)
    (asserts! (<= amount (get balance t)) ERR-INSUFFICIENT-TREASURY)
    (unwrap! (as-contract (stx-transfer? amount tx-sender recipient))
      ERR-STX-TRANSFER-FAILED
    )
    (var-set treasury
      (merge t {
        total-withdrawn: (+ (get total-withdrawn t) amount),
        balance: (- (get balance t) amount),
      })
    )
    (print {
      event: "treasury-withdrawal",
      amount: amount,
      recipient: recipient,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; =============================================================================
;; PUBLIC -- Emergency controls (registry emergency admin or owner)
;; =============================================================================

;; Halts all fee collection. With non-zero fees configured this freezes every
;; fee-charging pool operation; user funds in the pool are unaffected.
(define-public (freeze-fees)
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (var-get fees-frozen)) ERR-FEES-FROZEN)
    (var-set fees-frozen true)
    (print { event: "fees-frozen", height: stacks-block-height })
    (ok true)
  )
)

(define-public (unfreeze-fees)
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (var-get fees-frozen) ERR-FEES-FROZEN)
    (var-set fees-frozen false)
    (print { event: "fees-unfrozen", height: stacks-block-height })
    (ok true)
  )
)

;; Halts treasury withdrawals (including the owner's) until unfrozen.
(define-public (freeze-treasury)
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (var-get treasury-frozen)) ERR-TREASURY-FROZEN)
    (var-set treasury-frozen true)
    (print { event: "treasury-frozen", height: stacks-block-height })
    (ok true)
  )
)

(define-public (unfreeze-treasury)
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (var-get treasury-frozen) ERR-TREASURY-FROZEN)
    (var-set treasury-frozen false)
    (print { event: "treasury-unfrozen", height: stacks-block-height })
    (ok true)
  )
)

;; -----------------------------------------------------------------------------
;; DEPLOY-TIME INITIALIZATION
;; -----------------------------------------------------------------------------
;; Launch configuration: every fee type exists, enabled, at 0 bps (free
;; protocol). Governance raises fees post-launch within the registry ceiling.

(map-set fee-configs FEE-TYPE-SHIELD { bps: u0, flat: u0, enabled: true })
(map-set fee-configs FEE-TYPE-TRANSFER { bps: u0, flat: u0, enabled: true })
(map-set fee-configs FEE-TYPE-WITHDRAWAL { bps: u0, flat: u0, enabled: true })
(map-set fee-configs FEE-TYPE-RELAYER { bps: u0, flat: u0, enabled: true })
