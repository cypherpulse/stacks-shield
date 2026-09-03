# Stacks Shield: A Multi-Asset Shielded-Pool Protocol for Stacks

**Testnet**
Deployer (v2, current): `ST18XMPE0PS5VNEEKB82BPW7NRZRHXEPH16JK8NN6`
Deployer (v1, superseded): `ST2HXRZ8A82JJAP14KD83JEXNRCF34J67088WJSJH`

> **v2** binds the Merkle-tree transition into every leaf-adding proof (`new_root`
> + `leaf_index`) and asserts the registry-assigned slot matches the proof-bound
> index, so a published root is proven rather than asserted (circuit version 2,
> deployed fresh). v1 is retained for history and no longer used by the clients.

---

## Abstract

Stacks Shield is a privacy protocol for the Stacks blockchain that lets users
hold and move value in **shielded notes** rather than transparent balances. It
supports native **STX** and **SIP-10 fungible tokens** (e.g. sBTC, USDCx) through
a single shared shielded pool. Users **shield** a public amount into a private
note, **transfer / split / merge** value between notes without revealing amounts
or participants, and **withdraw** back to any transparent address. Privacy is
provided by zero-knowledge proofs (Noir circuits proven with UltraHonk) over a
Merkle tree of Poseidon commitments, with nullifiers preventing double-spends and
a relayer removing the last on-chain link between a user and their transactions.

Because Clarity — the Stacks smart-contract language — cannot yet verify a
pairing-based SNARK natively, verification is delegated to the external
**zkVerify** network, which verifies each proof off chain and aggregates it into
a Merkle root; the on-chain contracts check only cheap **aggregation inclusion**.
This document specifies the protocol, its cryptographic and security model, the
multi-asset extension, and a concrete path toward removing the external
verification dependency.

---

## 1. Introduction

Public blockchains expose every balance and transfer. On Stacks, an observer sees
exactly how much STX or how many SIP-10 tokens an address holds, and every
movement between addresses. This is often unacceptable — for payroll, treasury
operations, trading, or simply personal financial privacy.

**Shielded-pool** designs (as pioneered by Zerocash/Zcash and adapted by systems
such as Tornado Cash and Aztec) solve this by replacing transparent balances with
cryptographic commitments and proving state transitions in zero knowledge. Stacks
Shield brings this model to Stacks, with two properties that shape the design:

1. **Clarity has no elliptic-curve pairing primitives**, so a SNARK cannot be
   verified inside a contract at acceptable cost. Verification must be delegated
   and its result checked cheaply on chain.
2. **Multi-asset from the start.** Stacks' flagship assets include sBTC (Bitcoin
   on Stacks) and stablecoins. A privacy protocol that only shields STX is of
   limited use, so Stacks Shield shields STX *and* SIP-10 tokens in one pool,
   without fragmenting the anonymity set.

---

## 2. Background

**Stacks & Clarity.** Stacks is a Bitcoin-anchored L1 whose contracts are written
in Clarity, a decidable, non-Turing-complete language. Clarity exposes hashes
(`sha256`, `keccak256`, …), `secp256k1` signature verification, and (Clarity 6) a
native Bitcoin-style Merkle-inclusion check — but no BN254/BLS pairings and only
128-bit integers.

**Notes and commitments.** A *note* represents a private balance:
`{ amount, owner keypair, blinding }`. Its public fingerprint is a *commitment* —
a collision-resistant hash that reveals nothing about its contents. The chain
stores only commitments.

**Nullifiers.** Spending a note publishes a deterministic *nullifier* derived
from the note's secret. Registering a nullifier twice is rejected, preventing
double-spends without revealing which note was spent.

**Zero-knowledge proofs.** Each operation is proven with a Noir circuit compiled
to **UltraHonk** (Aztec's Barretenberg proof system). A proof attests that the
operation is valid — ownership, membership, value conservation, well-formed
nullifiers/commitments — without revealing the witness.

---

## 3. Protocol design

### 3.1 Notes and commitments

A note commitment uses the Poseidon hash (a ZK-friendly permutation):

- **Native STX:** `C = Poseidon4(amount, ownerPkX, ownerPkY, blinding)`
- **SIP-10:** `C = Poseidon2( Poseidon4(amount, ownerPkX, ownerPkY, blinding), asset_id )`

where `asset_id = fePrincipal(token)` reduces the token's contract principal to a
field element. Binding `asset_id` into the commitment means the *asset itself* is
part of the note's identity: a proof spending a note must reproduce the exact
commitment, so a note of one asset can never be spent as another (§6).

The owner keypair is a Grumpkin (embedded-curve) scalar/point; `blinding` is a
random field element that makes commitments to equal amounts indistinguishable.

### 3.2 Merkle tree

All commitments — across **all assets** — are inserted into a single,
asset-agnostic **Merkle tree** maintained by the registry. Its root is published
on chain. Every spend proves Merkle membership of its input commitment under a
known root. Sharing one tree keeps the anonymity set unified rather than split
per asset.

### 3.3 Nullifiers and double-spend prevention

Spending publishes a nullifier `N` bound to the note secret and its position.
The registry maintains an append-only nullifier set; a second attempt to register
`N` reverts. Because `N` is derived from secrets not present in the commitment,
observers cannot link a nullifier to the commitment it spends.

### 3.4 Operations

| Operation | Effect | Signer |
|---|---|---|
| **Shield** | transparent amount → new note | user (moves own funds) |
| **Transfer** | note → new note owned by recipient | relayer |
| **Split** | note → two notes (Σ preserved) | relayer |
| **Merge** | two notes (same asset) → one note | relayer |
| **Withdraw** | note → transparent amount at any address − fee | relayer |

Every circuit enforces **value conservation**: outputs (plus fee) equal inputs,
so no value is created or destroyed. Shield and withdraw touch transparent
amounts; transfer/split/merge move only commitments and nullifiers.

### 3.5 Relayer and sender privacy

Zero-knowledge hides *what* moved, but the transaction still has an on-chain
*sender*. To close that gap, transfer/split/merge/withdraw are submitted by a
**relayer**: the operation lands from the relayer's address, so the user never
appears on chain. The relayer is **trustless** — every parameter (amount,
recipient, asset, commitments, root) is bound into the proof, so the relayer can
choose to submit or not, but can never alter the operation.

---

## 4. Verification architecture

### 4.1 Why not on-chain verification

Verifying an UltraHonk proof requires BN254 pairing operations and 254-bit field
arithmetic. Clarity has neither (§2), so native verification is infeasible at
current cost budgets.

### 4.2 zkVerify delegation

Instead, a proof is submitted to **zkVerify** (a specialised verification L1),
which verifies it and **aggregates** many verified statements into a Merkle root.
A relayer publishes that root on chain via `submit-aggregation`. The verifier
contract then accepts an operation only if its **statement** — a keccak hash
binding the registered verification-key hash, the circuit version, and the
canonical public inputs (including `asset_id` for SIP-10) — is a **member of a
published aggregation root**. This is a hash-path check Clarity performs cheaply.

Change any parameter and the statement changes, so it is no longer in any
published root and the operation reverts. Because zkVerify is a separate chain,
aggregation roots persist across Stacks testnet resets.

### 4.3 Trust model

This is an explicit **v1 trust delegation**: the contracts trust zkVerify's
verification and check only inclusion. It is a real trust/liveness dependency,
and the primary direction of future work is to move verification onto Stacks
itself. [§9](#9-toward-native-zk-verification-on-stacks) sets out that path —
from a self-hosted, federated verifier to fully native on-chain verification.

---

## 5. Multi-asset extension (SIP-10)

The multi-asset layer is **purely additive**: the audited native STX protocol is
frozen and untouched; SIP-10 support is a separate set of contracts that reuse
the frozen `privacy-registry` and `note-manager`.

- **Asset registry.** `asset-registry` is the on-chain source of truth for
  supported assets: uid, token principal, decimals, shield limits, per-asset fee
  configuration and fee recipient. Adding a new token requires **only on-chain
  registration** — no SDK or contract change. Clients discover assets through the
  API's `/assets` endpoint.
- **One pool.** `sip10-pool` handles shield/transfer/split/merge/withdraw for
  every registered asset, routing by uid.
- **Asset-bound commitments** (§3.1) provide isolation: assets share one tree but
  can never cross.
- **Conservation invariant (per asset).** For each asset A,
  `token_A.balance(pool) == shielded-total[A]` — shield adds to both, withdraw
  subtracts from both. This defends against malicious or fee-on-transfer tokens:
  the pool asserts the balance delta equals the claimed amount.

The SIP-10 extension has its own fee manager (`sip10-protocol-fees`) and verifier
(`sip10-zk-verifier`), mirroring the native contracts.

---

## 6. Fees

Fees are configured per asset in the registry and mirror the native STX
protocol. They are **user-paid and private**:

| Operation | Rate | Payer | Mechanism |
|---|---|---|---|
| Shield | 0.25% (25 bps) | user | folded into the transparent deposit |
| Withdrawal | 0.30% (30 bps) | user | taken from the payout `as-contract` from the pool |
| Transfer / Split / Merge | 0 (flat-only) | tx-sender (relayer) | `calculate-fee(·, 0)` ⇒ flat only |

Only shield and withdrawal expose a public amount at the moment of charging, so
only they can take a **percentage**. Transfer/split/merge operate over hidden
amounts, so the protocol can only levy a **flat** fee there, paid by the
transaction sender (the relayer); Stacks Shield keeps this at zero to avoid the
relayer subsidising fees. The withdrawal fee is pulled from the pool as the
contract, so the public cannot link a fee to a specific person.

---

## 7. Security model

**Threat model.** A global passive adversary observing the chain; active
adversaries who submit malformed operations, attempt double-spends/replays, or
deploy malicious tokens; a malicious relayer; and a curious indexer/API operator.

**Guarantees.**

- **Confidentiality.** Commitments and nullifiers reveal no amount, owner, or
  linkage. Encrypted note payloads are readable only by the owner's viewing key;
  the API stores opaque ciphertext and never amounts, secrets, or
  nullifier→commitment links.
- **Integrity / no forgery.** An operation is accepted only if a valid proof's
  statement is included in a published aggregation; parameters are bound into the
  statement, so nothing can be altered post-proof.
- **No double-spend / replay.** Three independent append-only guards: registry
  nullifiers, note-state transitions, and per-aggregation verifier records.
- **Value conservation.** Enforced in-circuit, and reinforced on chain by the
  per-pool conservation invariant, which runs *before* any funds move — a pool
  can never pay out more than is shielded.
- **Authority delegation.** Only the registry stores ownership, roles, and the
  authorized-caller allowlist; every protected write is gated by
  `contract-caller`. Not even the owner writes commitments/nullifiers/notes/fees
  directly.
- **Malicious-token defence.** The SIP-10 pool measures its own token-balance
  delta and rejects any transfer whose observed movement ≠ the claimed amount.
- **Emergency response.** A registry state machine
  (ACTIVE/PAUSED/EMERGENCY/UPGRADING/DEPRECATED) composes with per-contract
  freezes and per-operation switches. Roots, vkeys, and notes can be frozen.

**Relayer trust.** Liveness only. A relayer cannot alter operations, but can
censor. Decentralising the relayer set removes this as a chokepoint (§9).

---

## 8. Limitations

- **Testnet, unaudited.** No third-party audit yet; not on mainnet.
- **Anonymity set.** Privacy scales with the crowd. A shared multi-asset tree
  helps, but current usage is low, so *practical* privacy is limited regardless
  of the cryptography.
- **Delegated verification.** Verification runs on zkVerify, not in Stacks
  consensus — a real trust/liveness dependency (§4.3, §9).
- **Transparent edges.** Shield and withdraw amounts and addresses are public;
  privacy is strongest with a busy pool, common denominations, and time between
  deposit and withdrawal.

---

## 9. Toward native ZK verification on Stacks

The destination is **native on-chain proof verification**: the contracts verify
proofs themselves, so Stacks Shield no longer depends on any external chain for
verification. Because Clarity cannot yet verify a pairing-based SNARK (§4.1), we
reach that destination in stages, in order of feasibility:

1. **Interim — a self-hosted, federated verifier.** Move verification in-house:
   N independent nodes each verify the proof off chain and co-sign the
   aggregation root; the contract checks M-of-N `secp256k1` signatures (native)
   plus native `verify-merkle-proof` inclusion. No circuit rewrite; trust is
   minimised by public re-verifiability and bonding/slashing. This decentralises
   verification while the fully-native paths below mature.
2. **Native Groth16, via a Clarity pairing precompile.** If Clarity gains
   BN254/BLS pairing operations (as Ethereum, Stellar and Cardano already have),
   switch the proving system to Groth16 and verify its single pairing check on
   chain — fully native and trustless. The existing circuit-version upgrade path
   supports this migration with no storage or API breakage.
3. **Native STARKs.** Hash-based proofs need no pairings, and a Goldilocks field
   fits Clarity's 128-bit integers, making a **native on-chain FRI verifier** the
   only pairing-free route — gated by on-chain cost, likely using recursion to
   shrink the final check. This needs no new Clarity primitive at all.

Independently, decentralising the relayer removes the sender-privacy liveness
dependency, completing a self-contained protocol that lives entirely on Stacks.

---

## 10. Conclusion

Stacks Shield demonstrates a working, multi-asset shielded-pool protocol on
Stacks: STX, sBTC and USDCx move privately through one pool, with cryptographic
asset isolation, per-asset conservation, user-paid private fees, and relayer-based
sender anonymity — all while leaving the frozen native protocol untouched. The
principal open problem is trust-minimising verification; the delegation to
zkVerify is a deliberate, documented v1 choice with a concrete removal path. As
Clarity's cryptographic surface grows, native verification becomes the endgame.

---

## References & further reading

- [`README.md`](../README.md) — project overview with system diagrams
- [`docs/architecture.md`](architecture.md) · [`docs/privacy-model.md`](privacy-model.md) · [`docs/security.md`](security.md)
- [`docs/getting-started.md`](getting-started.md) · [`docs/api-reference.md`](api-reference.md) · [`docs/glossary.md`](glossary.md)
- Zerocash / Zcash protocol specification; Aztec Barretenberg (UltraHonk); [zkVerify](https://zkverify.io)
