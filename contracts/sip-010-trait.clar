;; =============================================================================
;; sip-010-trait.clar
;; =============================================================================
;; STX Shield -- SIP-010 Fungible Token trait (standard).
;;
;; The canonical SIP-010 interface. The SIP-10 privacy layer (asset-registry,
;; sip10-pool, sip10-protocol-fees) accepts tokens ONLY as this trait, so the
;; compiler proves every token argument conforms to the standard before a single
;; instruction runs. Value movement always goes through `transfer`; `get-decimals`
;; is used at registration to validate the declared metadata against the token.
;;
;; This is a NEW contract and touches nothing in the frozen STX protocol.
;; =============================================================================

(define-trait sip-010-trait
  (
    ;; Transfer `amount` from `sender` to `recipient`, with an optional memo.
    (transfer (uint principal principal (optional (buff 34))) (response bool uint))

    (get-name () (response (string-ascii 32) uint))
    (get-symbol () (response (string-ascii 32) uint))
    (get-decimals () (response uint uint))
    (get-balance (principal) (response uint uint))
    (get-total-supply () (response uint uint))
    (get-token-uri () (response (optional (string-utf8 256)) uint))
  )
)
