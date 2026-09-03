# Changelog

All notable changes to Stacks Shield are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-beta.2] - 2026-09-03

**v2 protocol relaunch on Stacks Testnet.** A fresh deployment with a hardened
zero-knowledge proof system and multi-asset support, validated end-to-end on
testnet. Testnet-only and **not independently audited** — an external audit is
required before mainnet. New deployment address; see *Changed* for the migration.

### Added
- **Tree-transition binding (circuit version 2).** Every leaf-adding operation
  (shield / transfer / split / merge) now binds the new Merkle root and the exact
  insertion index into the proof, and each pool asserts the registry-assigned slot
  matches the proof — so the resulting root is **proven, not merely asserted**.
- **Fresh-deploy tooling** — a single `.env.v2.deploy` drives a full v2 deployment
  under a new wallet; adds `new-wallet.ts`, `gen-relayers.ts`, `set-relayers.ts`
  (M-of-N-ready relayer seating) and both-family verification-key generation.
- **Docs** — testnet deployment runbook (`docs/v2-testnet-deployment.md`) and
  per-release notes (`docs/releases/`).

### Changed
- Circuits and contracts move to `circuit_version = 2`; the pools and
  `split-merge-manager` fold `new_root` + `leaf_index` into the public-inputs hash.
- SDK proving adds the insertion witness and the v2 canonical public-input encoding
  (native + SIP-10); the relayer threads the leaf index through relayed operations.
- **Breaking — new deployment.** All clients now target the v2 deployer
  `ST18XMPE0PS5VNEEKB82BPW7NRZRHXEPH16JK8NN6`; the v1 deployer
  `ST2HXRZ8A82JJAP14KD83JEXNRCF34J67088WJSJH` is **superseded — do not use**.
- **Breaking — circuit version 2.** v1 proofs are not compatible with v2; use a v2
  client against the v2 deployment.

### Fixed
- STX `privacy-pool.withdraw` now excludes the fee contract as a recipient, matching
  the SIP-10 pool.
- Corrected `privacy-pool` comments that described the tree transition as proven when
  it was not (now accurate under circuit version 2).

### Security
- Proof-soundness hardening: the tree transition is now bound in-circuit and
  re-checked on-chain.
- An **internal security review** of the on-chain core, circuits, and SDK
  cryptography has been completed.
- **Known, disclosed trust assumption:** on-chain publication of zkVerify
  aggregation roots is currently a **trusted relayer role**; a threshold (M-of-N)
  publisher scheme run by independent operators is planned to remove it. Root
  publication is not yet trustless.

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

[Unreleased]: https://github.com/cypherpulse/stacks-shield/compare/v1.0.0-beta.2...HEAD
[1.0.0-beta.2]: https://github.com/cypherpulse/stacks-shield/compare/v1.0.0-beta.1...v1.0.0-beta.2
[1.0.0-beta.1]: https://github.com/cypherpulse/stacks-shield/releases/tag/v1.0.0-beta.1
