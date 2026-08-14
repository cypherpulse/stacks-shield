;; =============================================================================
;; sip10-protocol-fees.clar
;; =============================================================================
;; STX Shield -- SIP-10 Protocol Fees & Treasury (v1.0.0)
;;
;; The token-native fee layer for the SIP-10 privacy pool. It mirrors the STX
;; `protocol-fees.clar` separation of concerns exactly, with two differences the
;; multi-asset world requires:
;;   1. Fees are collected and custodied in the ASSET's own SIP-10 token, never STX.
;;   2. Configuration and accounting are PER ASSET. Fee configuration is NOT stored
;;      here -- `asset-registry.clar` is the single source of truth; this contract
;;      reads it, clamps to the registry's live bps ceiling, collects, custodies,
;;      and accounts.
;;
;; It owns exactly one thing: SIP-10 fee collection, per-asset accounting, and the
;; per-asset token treasury. It manages NO notes, commitments, trees, nullifiers,
;; proofs, or shielding logic.
;;
;; Authority model -- ZERO local authority state (delegates to the frozen registry):
;;   - fee collection:        registry authorized callers (sip10-pool)
;;   - treasury withdrawals:  registry owner ONLY (paid to the asset's fee recipient)
;;   - freezes:               registry emergency admin or owner
;;   All checks use `contract-caller` (except token movement, where tx-sender is by
;;   definition the paying party -- identical to protocol-fees.clar).
;;
;; Fee ceiling -- DOUBLE enforcement (same as STX):
;;   1. asset-registry.set-asset-fee-config rejects bps above the registry ceiling.
;;   2. calculate-fee clamps to the live ceiling at charge time.
;;
;; Error space: u500-u549 (reserved for SIP-10 fee errors across the protocol).
;; =============================================================================

(use-trait sip-010-trait .sip-010-trait.sip-010-trait)

;; -----------------------------------------------------------------------------
;; CONSTANTS
;; -----------------------------------------------------------------------------

(define-constant CONTRACT-VERSION u1)

;; Basis-point denominator: 10000 bps = 100%.
(define-constant BPS-DENOMINATOR u10000)

;; Fee types (one per user operation). Mirrors asset-registry / the pool ops.
(define-constant FEE-TYPE-SHIELD u1)
(define-constant FEE-TYPE-TRANSFER u2)
(define-constant FEE-TYPE-WITHDRAWAL u3)
(define-constant FEE-TYPE-SPLIT u4)
(define-constant FEE-TYPE-MERGE u5)

;; Mirrors of the frozen registry role ids.
(define-constant REGISTRY-ROLE-EMERGENCY-ADMIN u2)

;; Empty per-asset treasury.
(define-constant ZERO-TREASURY { total-collected: u0, total-withdrawn: u0, balance: u0 })

;; -----------------------------------------------------------------------------
;; ERRORS -- Reserved SIP-10 fee space u500-u549
;; -----------------------------------------------------------------------------

(define-constant ERR-UNAUTHORIZED (err u500))          ;; caller lacks registry owner/role authority
(define-constant ERR-UNAUTHORIZED-CALLER (err u501))   ;; contract-caller not on the registry allowlist
(define-constant ERR-FEES-FROZEN (err u502))           ;; fee collection is frozen
(define-constant ERR-TREASURY-FROZEN (err u503))       ;; treasury withdrawals are frozen
(define-constant ERR-UNKNOWN-FEE-TYPE (err u504))      ;; no fee config for (asset, fee-type)
(define-constant ERR-ZERO-AMOUNT (err u505))           ;; zero-amount collection or withdrawal
(define-constant ERR-INSUFFICIENT-TREASURY (err u506)) ;; withdrawal exceeds accounted asset treasury
(define-constant ERR-TOKEN-TRANSFER-FAILED (err u507)) ;; underlying SIP-10 transfer failed
(define-constant ERR-UNKNOWN-ASSET (err u508))         ;; asset id not registered
(define-constant ERR-ASSET-TOKEN-MISMATCH (err u509))  ;; token trait != the asset's registered token

;; -----------------------------------------------------------------------------
;; STORAGE -- Per-asset treasury accounting
;; -----------------------------------------------------------------------------

;; asset-id -> accounting for that asset's token held by this contract. `balance`
;; must always equal this contract's real balance of the asset's token.
(define-map asset-treasury
  uint
  { total-collected: uint, total-withdrawn: uint, balance: uint }
)

;; (asset-id, fee-type) -> cumulative collections, for per-asset revenue analytics.
(define-map asset-fee-stats
  { asset-id: uint, fee-type: uint }
  { collected: uint }
)

;; -----------------------------------------------------------------------------
;; STORAGE -- Emergency switches (global, mirror protocol-fees)
;; -----------------------------------------------------------------------------

(define-data-var fees-frozen bool false)
(define-data-var treasury-frozen bool false)

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

(define-private (is-authorized-protocol-caller (who principal))
  (contract-call? .privacy-registry is-authorized-caller who)
)

(define-private (is-valid-fee-type (fee-type uint))
  (or
    (is-eq fee-type FEE-TYPE-SHIELD)
    (is-eq fee-type FEE-TYPE-TRANSFER)
    (is-eq fee-type FEE-TYPE-WITHDRAWAL)
    (is-eq fee-type FEE-TYPE-SPLIT)
    (is-eq fee-type FEE-TYPE-MERGE)
  )
)

;; Charge-time clamp: the registry's live max-fee-bps always wins.
(define-private (effective-bps (configured uint))
  (let ((ceiling (contract-call? .privacy-registry get-max-fee-bps)))
    (if (> configured ceiling) ceiling configured)
  )
)

;; -----------------------------------------------------------------------------
;; READ-ONLY -- Calculation and accounting
;; -----------------------------------------------------------------------------

;; The fee charged right now for `amount` of `fee-type` on `asset-id`: config is
;; read from asset-registry (the source of truth), the bps clamped to the live
;; registry ceiling, floor-rounded (favors the user), zero when disabled.
(define-read-only (calculate-fee (asset-id uint) (fee-type uint) (amount uint))
  (match (contract-call? .asset-registry get-asset-fee-config asset-id fee-type)
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

(define-read-only (get-asset-treasury (asset-id uint))
  (default-to ZERO-TREASURY (map-get? asset-treasury asset-id))
)

(define-read-only (get-asset-fee-stats (asset-id uint) (fee-type uint))
  (default-to { collected: u0 } (map-get? asset-fee-stats { asset-id: asset-id, fee-type: fee-type }))
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

;; -----------------------------------------------------------------------------
;; PUBLIC -- Fee collection (authorized protocol contracts)
;; -----------------------------------------------------------------------------

;; THE single entry point for SIP-10 fee tokens. Moves `amount` of the asset's
;; token from tx-sender (the user for shield/transfer fees; the pool contract,
;; via as-contract, for fees paid out of shielded value) into this contract and
;; records it. The `token` trait is validated against the asset's registered
;; principal, so a caller can never account a fee under the wrong asset.
(define-public (collect-fee
    (asset-id uint)
    (fee-type uint)
    (amount uint)
    (token <sip-010-trait>)
  )
  (let (
      (asset (unwrap! (contract-call? .asset-registry get-asset asset-id) ERR-UNKNOWN-ASSET))
      (t (get-asset-treasury asset-id))
      (stats (get-asset-fee-stats asset-id fee-type))
    )
    (try! (contract-call? .privacy-registry check-protocol-active))
    (asserts! (not (var-get fees-frozen)) ERR-FEES-FROZEN)
    (asserts! (is-authorized-protocol-caller contract-caller) ERR-UNAUTHORIZED-CALLER)
    (asserts! (is-valid-fee-type fee-type) ERR-UNKNOWN-FEE-TYPE)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (asserts! (is-eq (contract-of token) (get token asset)) ERR-ASSET-TOKEN-MISMATCH)
    (unwrap!
      (contract-call? token transfer amount tx-sender (as-contract tx-sender) none)
      ERR-TOKEN-TRANSFER-FAILED
    )
    (map-set asset-treasury asset-id (merge t {
      total-collected: (+ (get total-collected t) amount),
      balance: (+ (get balance t) amount),
    }))
    (map-set asset-fee-stats { asset-id: asset-id, fee-type: fee-type }
      { collected: (+ (get collected stats) amount) }
    )
    (print {
      event: "sip10-fee-collected",
      asset-id: asset-id,
      fee-type: fee-type,
      amount: amount,
      payer: tx-sender,
      height: stacks-block-height,
    })
    (ok amount)
  )
)

;; -----------------------------------------------------------------------------
;; PUBLIC -- Treasury withdrawals (registry owner ONLY)
;; -----------------------------------------------------------------------------

;; Moves `amount` of the asset's accounted token treasury to the asset's
;; configured fee recipient (from asset-registry). Owner-only: treasury custody
;; is the highest-stakes decision and is not delegated. The recipient is taken
;; from the registry, not an argument, so funds can only flow to the governed
;; destination. Works in any protocol state unless the treasury is frozen.
(define-public (withdraw-fees
    (asset-id uint)
    (amount uint)
    (token <sip-010-trait>)
  )
  (let (
      (asset (unwrap! (contract-call? .asset-registry get-asset asset-id) ERR-UNKNOWN-ASSET))
      (t (get-asset-treasury asset-id))
      (recipient (get fee-recipient asset))
    )
    (asserts! (is-registry-owner contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (var-get treasury-frozen)) ERR-TREASURY-FROZEN)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (asserts! (is-eq (contract-of token) (get token asset)) ERR-ASSET-TOKEN-MISMATCH)
    (asserts! (<= amount (get balance t)) ERR-INSUFFICIENT-TREASURY)
    (unwrap!
      (as-contract (contract-call? token transfer amount tx-sender recipient none))
      ERR-TOKEN-TRANSFER-FAILED
    )
    (map-set asset-treasury asset-id (merge t {
      total-withdrawn: (+ (get total-withdrawn t) amount),
      balance: (- (get balance t) amount),
    }))
    (print {
      event: "sip10-treasury-withdrawal",
      asset-id: asset-id,
      amount: amount,
      recipient: recipient,
      height: stacks-block-height,
    })
    (ok true)
  )
)

;; -----------------------------------------------------------------------------
;; PUBLIC -- Emergency controls (registry emergency admin or owner)
;; -----------------------------------------------------------------------------

(define-public (freeze-fees)
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (var-get fees-frozen)) ERR-FEES-FROZEN)
    (var-set fees-frozen true)
    (print { event: "sip10-fees-frozen", height: stacks-block-height })
    (ok true)
  )
)

(define-public (unfreeze-fees)
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (var-get fees-frozen) ERR-FEES-FROZEN)
    (var-set fees-frozen false)
    (print { event: "sip10-fees-unfrozen", height: stacks-block-height })
    (ok true)
  )
)

(define-public (freeze-treasury)
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (not (var-get treasury-frozen)) ERR-TREASURY-FROZEN)
    (var-set treasury-frozen true)
    (print { event: "sip10-treasury-frozen", height: stacks-block-height })
    (ok true)
  )
)

(define-public (unfreeze-treasury)
  (begin
    (asserts! (is-emergency-admin contract-caller) ERR-UNAUTHORIZED)
    (asserts! (var-get treasury-frozen) ERR-TREASURY-FROZEN)
    (var-set treasury-frozen false)
    (print { event: "sip10-treasury-unfrozen", height: stacks-block-height })
    (ok true)
  )
)
