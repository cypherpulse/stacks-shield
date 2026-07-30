# Changelog

All notable changes to `@stx-shield/sdk` are documented here. This project
follows [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

## [1.0.0] — 2026-07-29

Initial release.

### Added
- `STXShield` client with the full private-operations API: `shield`, `transfer`,
  `split`, `merge`, `withdraw`, plus `getNotes`, `getHistory`, `getStats`,
  `connect`, `getAddress`.
- Wallet authentication (nonce → signature → JWT), wallet-agnostic via a
  `WalletSigner` interface (`@stacks/connect` in the browser, key-based in Node).
- Local note discovery: trial-decryption of the API's encrypted feed with a
  viewing key; amounts are recovered on-device and never leave it.
- Shareable STX Shield addresses (`encodeAddress`/`decodeAddress`).
- Pluggable `ProofEngine` seam (Node toolchain engine proven on testnet; browser
  WASM engine on the roadmap).
- Typed error hierarchy (`STXShieldError` and subclasses).
- Retry with exponential backoff on API, relayer and auth calls.
- Multi-relayer failover.
- Dual ESM + CommonJS builds, full type declarations, tree-shakable,
  side-effect-free.

### Notes
- Testnet is live. Mainnet endpoints activate once the protocol is deployed to
  mainnet.
