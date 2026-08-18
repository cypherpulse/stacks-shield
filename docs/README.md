# Stacks Shield — Documentation

Privacy-preserving transfers on Stacks for **STX** and **SIP-10 tokens** (sBTC,
USDCx). Start with the [project README](../README.md) for the overview and system
diagrams, then dive in below.

## Read in this order

1. **[Whitepaper](whitepaper.md)** — the protocol: notes, commitments,
   nullifiers, operations, verification, multi-asset, fees, security, roadmap.
   The canonical reference.
2. **[Architecture](architecture.md)** — the seven layers (contracts, circuits,
   zkVerify, relayer, API/indexer, SDK, frontend) and how a request flows through
   them.
3. **[Privacy model](privacy-model.md)** — what is hidden, what is public, and the
   cryptography that makes it so.
4. **[Security](security.md)** — threat model, guarantees, invariants, and the
   trust assumptions (including the zkVerify dependency).
5. **[Getting started](getting-started.md)** — set up locally, run the tests, and
   the services/frontend.
6. **[Glossary](glossary.md)** — the terms (note, commitment, nullifier, shield…)
   in one place.

The multi-asset (SIP-10) model — the asset registry, the one-pool design, and
asset-bound commitments — is covered in
[whitepaper §5](whitepaper.md#5-multi-asset-extension-sip-10).

## Roadmap

- **[Toward native ZK verification](whitepaper.md#9-toward-native-zk-verification-on-stacks)**
  — the path from delegated verification to fully native, on-chain proofs.

## For developers & integrators

- **[Getting started](getting-started.md)** — prerequisites, install, tests.
- **[API reference](api-reference.md)** — the public read-only endpoints.
- **[SDK](../sdk/README.md)** — `@stacks-shield/sdk`: shield / transfer / split /
  merge / withdraw for STX and SIP-10, browser and Node.
- **Services** — the [API + indexer](../services/api) and the
  [relayer](../services/relayer).
- **Contracts** — Clarity source in [`contracts/`](../contracts); circuits in
  [`zk/circuits/`](../zk/circuits).

---

> **Status: live on Stacks Testnet, v1.** Not audited; not on mainnet. See the
> whitepaper's [Limitations](whitepaper.md#8-limitations).
