# STX Shield

Privacy-preserving transfers of STX on Stacks. STX Shield lets users **shield**
STX into a private pool, **transfer / split / merge** value privately between
opaque notes, and **withdraw** back to any transparent address — with note
ownership, note amounts, and recipient identities hidden by zero-knowledge
proofs (Noir + UltraHonk), verified through [zkVerify](https://zkverify.io).

📚 Full documentation: [`docs/`](docs/README.md).

> **Status: live on Stacks Testnet, v1.** The complete lifecycle — shield →
> transfer → split → merge → withdraw — has been demonstrated end-to-end with
> **real STX, real Noir/UltraHonk proofs, and real zkVerify verification**,
> including relayed transactions (the user never appears on chain) and
> double-spend rejection. Deployer: `ST2HXRZ8A82JJAP14KD83JEXNRCF34J67088WJSJH`.
> Not yet audited; not yet on mainnet. See [Honest limitations](#honest-limitations).

---

## How it works

```
        Frontend
           │
     @stx-shield/sdk ──► Noir + Barretenberg (UltraHonk proof)
           │                        │
           │                    zkVerify  (verifies + aggregates the proof)
           │                        │
           └────── Relayer ─────────┘  (publishes the aggregation root,
           │                            submits the operation — user stays hidden)
      Clarity contracts
           │
        Stacks
```

1. A note is a Poseidon commitment `Poseidon(amount, ownerPk, blinding)`. The
   chain stores only the opaque commitment — never the amount or owner.
2. The SDK builds an UltraHonk proof (Noir + Barretenberg) that an operation is
   valid: the spender owns the input note, it's in the commitment tree, value is
   conserved, and nullifiers/commitments are well-formed.
3. The proof is submitted to **zkVerify**, which verifies it and aggregates it
   into a Merkle root. A **relayer** publishes that root on chain.
4. `zk-verifier.clar` accepts the operation only if its statement — a keccak hash
   binding the registered verification-key hash, the version, and the canonical
   public inputs — is included in a published zkVerify aggregation. Change any
   parameter and the statement changes, so the operation reverts.

**Trust model (v1): verification is delegated to zkVerify.** Clarity cannot yet
verify an UltraHonk proof natively (BN254 pairings within mainnet limits), so the
contracts trust zkVerify's verification and check aggregation inclusion on chain.
This is an explicit, documented dependency — see
[docs/privacy-model.md](docs/privacy-model.md) and
[docs/comparison.md](docs/comparison.md). Native on-chain verification is a
future circuit-version upgrade with no storage/API breakage.

The five operation circuits are validated to prove correctly with both the
canonical `bb` CLI and `@aztec/bb.js` (Node **and** browser) — identical vk and
statement, accepted by zkVerify V3_0. See
[docs/bbjs-validation.md](docs/bbjs-validation.md).

---

## Contracts

Six Clarity contracts, each a single responsibility, all delegating authority
and protocol state to the registry.

| Contract | Role | Errors |
|---|---|---|
| `privacy-registry.clar` | Protocol source of truth — roots, nullifiers, commitments, limits, versions, stats, access control, state machine, relayer registry | `u100–u149` |
| `note-manager.clar` | Shielded-note lifecycle | `u150–u199` |
| `protocol-fees.clar` | Fees & treasury | `u200–u249` |
| `zk-verifier.clar` | zkVerify statement binding + aggregation-inclusion checks | `u300–u349` |
| `privacy-pool.clar` | Core user-facing pool (shield / transfer / withdraw), STX custody | `u250–u299` |
| `split-merge-manager.clar` | Private note split / merge | `u350–u399` |

---

## Operations

- **Shield** — transparent STX → a private note (user-signed; the only operation
  that moves the user's own funds). Minimum 1 STX.
- **Transfer** — move a note's ownership privately. Publishes only a nullifier +
  a new commitment; no visible STX moves.
- **Split** — one note → two smaller notes (value conserved in-circuit).
- **Merge** — two notes → one note.
- **Withdraw** — a note → transparent STX at any address, minus the protocol fee.

Transfer / split / merge / withdraw can be submitted by a **relayer**, so the
operation lands on chain from the relayer's address and the user never appears.
The relayer is trustless: every parameter is bound into the proof, so it can
submit-or-not but can never alter an amount, recipient, or commitment.

---

## Security model

- **Authority is delegated, never duplicated.** Only the registry stores the
  owner, admin roles, and the authorized-caller allowlist; every protected write
  is gated by `contract-caller` against it. Not even the owner can write
  commitments, nullifiers, notes, or fees directly.
- **Double-spend / replay.** Three independent append-only guards: registry
  nullifiers (one registration ever), note states (a spent note never transitions
  again), and the verifier's per-aggregation records.
- **Proof binding.** Each operation's exact parameters are hashed into the
  canonical public-input encoding → the zkVerify statement leaf → checked for
  inclusion in a published aggregation. A proof authorizes exactly one operation
  with exactly those parameters. See [docs/public-input-spec.md](docs/public-input-spec.md).
- **Conservation invariant.** Pool STX balance always equals the registry's
  `total-shielded-stx`; the withdraw accounting gate runs before any STX moves,
  so the pool can never pay out more than is shielded.
- **Layered emergency response.** The registry ACTIVE/PAUSED/EMERGENCY/UPGRADING/
  DEPRECATED state machine composes with per-contract freezes and the pool's
  per-operation switches. Freeze a note, kill a root, or kill a vkey in any state.
- **Upgrades** flow through the registry's UPGRADING state; versions are
  monotonic and old notes stay spendable across an upgrade.

Details: [docs/security.md](docs/security.md) and
[docs/architecture.md](docs/architecture.md).

---

## Repository layout

```
contracts/          6 Clarity contracts (the on-chain protocol)
zk/
  circuits/         Noir: shield / transfer / withdraw / split / merge + keygen + shared lib
  barretenberg/     UltraHonk proving / verification / vkeys
  proofs/           generators / serializers / verifiers
sdk/                @stx-shield/sdk — TypeScript client (bb.js proving, Node + browser)
services/
  api/              public read-only API + indexers (Fastify + PostgreSQL/Drizzle + JWT)
  relayer/          relayer service (Fastify + BullMQ/Redis) — publishes roots, submits ops
tests/              15 vitest suites (contracts, attacks, fuzz, e2e, integration, privacy)
scripts/            deployment / testnet e2e / validation / upgrades
deployments/        devnet / testnet / mainnet plans + testnet records
settings/           Clarinet network configs
docs/               documentation (start at docs/README.md)
```

---

## Quick start

```bash
pnpm install
pnpm test              # contract suites (Clarinet simnet)
pnpm run test:rc       # everything (contracts + invariants + attacks + e2e + fuzz)
```

**362 tests across 15 suites** — per-contract unit tests, canonical public-input
and zkVerify-binding parity tests, adversarial + fuzz, end-to-end lifecycle,
invariants, and privacy tests.

Using the SDK:

```ts
import { STXShield } from "@stx-shield/sdk";

const shield = new STXShield({ network: "testnet", signer });
await shield.shield(100);                  // 100 STX -> private note
await shield.transfer(50, recipient);      // send privately
const { notes } = await shield.split(note, [25, 25]);
const { note: merged } = await shield.merge(notes);
await shield.withdraw(merged);             // back to transparent STX
```

See [`sdk/README.md`](sdk/README.md). Services deployment: [docs/services.md](docs/services.md).

---

## Honest limitations

STX Shield's *design* matches shielded-pool systems; its *assurance* is early.
For a public audience this must be stated plainly (full treatment in
[docs/comparison.md](docs/comparison.md)):

- **Testnet only, unaudited.** No third-party security audit yet; not on mainnet.
- **Small anonymity set.** Privacy is only as strong as the crowd you hide in;
  the current set is small, so today's *practical* privacy is limited regardless
  of the cryptography.
- **Verification is delegated to zkVerify** — a separate chain — rather than done
  in Stacks consensus. That is a deliberate v1 choice and a real trust/liveness
  dependency the fully-native design would remove.
- **Transparent sides are public.** Shield and withdraw amounts + addresses are
  on chain; privacy is strongest with a busy pool, common amounts, and delay
  between deposit and withdrawal.

---

## License

MIT — see [LICENSE](LICENSE).
