# Changelog

All notable changes to Stacks Shield are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-beta.1] - 2026-08-15

First public release. Privacy-preserving transfers on Stacks Testnet for native
**STX** and **SIP-10 tokens** (sBTC, USDCx). Testnet-only and **not yet audited** —
see [SECURITY.md](SECURITY.md) and the [whitepaper](docs/whitepaper.md#8-limitations).

### Added
- **Native STX protocol** (frozen): shield / transfer / split / merge / withdraw
  over a Poseidon-commitment Merkle tree, with nullifier double-spend protection
  and relayer-based sender privacy.
- **SIP-10 multi-asset extension** — one shared shielded pool for sBTC, USDCx and
  any registered SIP-10 token, using asset-bound commitments
  (`Poseidon2(Poseidon4(...), asset_id)`), an on-chain `asset-registry`, and a
  per-asset conservation invariant. Adds a token by on-chain registration only.
- **Verification via zkVerify** — off-chain UltraHonk verification with on-chain
  aggregation-inclusion checks (`zk-verifier`, `sip10-zk-verifier`).
- **`@stacks-shield/sdk`** — one client for STX + SIP-10 (browser + Node), with
  injectable proof engine, wallet signer, and a local `NoteVault` for durability;
  `shield()` waits for on-chain confirmation and rolls back on revert.
- **Services** — read-only API + indexer (per-asset `/stats`, `/assets`,
  `/commitments`, encrypted-note feed) and a relayer that publishes roots to both
  verifiers and submits operations.
- **Frontend** — multi-asset dashboard (asset selector, per-asset balances, live
  USD), multi-asset testnet faucet, and Terms / Privacy pages.
- **Fees** — per-asset, user-paid and private: shield 0.25%, withdrawal 0.30%.
- **Docs** — whitepaper, architecture, privacy model, security, getting-started,
  glossary, API reference; contribution + security policy + templates.

### Security
- No custodial control; the protocol cannot move user funds.
- API stores only opaque encrypted note payloads — never amounts, secrets, or
  nullifier→commitment links.

[Unreleased]: https://github.com/cypherpulse/stacks-shield/compare/v1.0.0-beta.1...HEAD
[1.0.0-beta.1]: https://github.com/cypherpulse/stacks-shield/releases/tag/v1.0.0-beta.1
