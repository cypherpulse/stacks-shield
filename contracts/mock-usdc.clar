;; =============================================================================
;; mock-usdc.clar  --  TEST FIXTURE ONLY (not part of the protocol)
;; =============================================================================
;; Minimal SIP-010 token standing in for USDCx (6 decimals) in the SIP-10
;; integration tests. Same shape as mock-sbtc, different decimals/principal, so
;; the suite exercises two genuinely distinct assets.
;; =============================================================================

(impl-trait .sip-010-trait.sip-010-trait)

(define-fungible-token usdc)

(define-constant ERR-NOT-OWNER (err u4))

(define-data-var skim-bps uint u0)

(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (is-eq tx-sender sender) ERR-NOT-OWNER)
    (let ((fee (/ (* amount (var-get skim-bps)) u10000)))
      (try! (ft-transfer? usdc (- amount fee) sender recipient))
      (if (> fee u0) (try! (ft-burn? usdc fee sender)) true)
      (ok true)
    )
  )
)

(define-read-only (get-name) (ok "Mock USDCx"))
(define-read-only (get-symbol) (ok "USDCx"))
(define-read-only (get-decimals) (ok u6))
(define-read-only (get-balance (who principal)) (ok (ft-get-balance usdc who)))
(define-read-only (get-total-supply) (ok (ft-get-supply usdc)))
(define-read-only (get-token-uri) (ok none))

;; ---- test helpers ----
(define-public (mint (amount uint) (recipient principal)) (ft-mint? usdc amount recipient))
(define-public (set-skim-bps (bps uint)) (ok (var-set skim-bps bps)))
