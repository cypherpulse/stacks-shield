;; =============================================================================
;; mock-sbtc.clar  --  TEST FIXTURE ONLY (not part of the protocol)
;; =============================================================================
;; Minimal SIP-010 fungible token standing in for sBTC (8 decimals) in the
;; SIP-10 integration tests. Mintable for test setup. `skim-bps` simulates a
;; fee-on-transfer / malicious token: a transfer moves (amount - skim) to the
;; recipient and burns the rest, so the pool's balance delta is LESS than the
;; requested amount -- exercising the pool's balance-delta assertion.
;; =============================================================================

(impl-trait .sip-010-trait.sip-010-trait)

(define-fungible-token sbtc)

(define-constant ERR-NOT-OWNER (err u4))

;; basis points skimmed (burned) on each transfer; 0 = honest token.
(define-data-var skim-bps uint u0)

(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (is-eq tx-sender sender) ERR-NOT-OWNER)
    (let ((fee (/ (* amount (var-get skim-bps)) u10000)))
      (try! (ft-transfer? sbtc (- amount fee) sender recipient))
      (if (> fee u0) (try! (ft-burn? sbtc fee sender)) true)
      (ok true)
    )
  )
)

(define-read-only (get-name) (ok "Mock sBTC"))
(define-read-only (get-symbol) (ok "sBTC"))
(define-read-only (get-decimals) (ok u8))
(define-read-only (get-balance (who principal)) (ok (ft-get-balance sbtc who)))
(define-read-only (get-total-supply) (ok (ft-get-supply sbtc)))
(define-read-only (get-token-uri) (ok none))

;; ---- test helpers ----
(define-public (mint (amount uint) (recipient principal)) (ft-mint? sbtc amount recipient))
(define-public (set-skim-bps (bps uint)) (ok (var-set skim-bps bps)))
