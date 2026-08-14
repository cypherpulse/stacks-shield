# Stacks Shield

> Privacy-preserving transfers on Stacks — for native **STX** and **SIP-10 tokens** (sBTC, USDCx) — using zero-knowledge proofs, a shared shielded pool, and a relayer that breaks the on-chain link between sender and receiver.

This document is the single reference for the whole system: what it is, how every layer fits together, what we built for multi-asset (SIP-10), what worked and what didn't, the reasoning behind the design choices, and a concrete list of improvements — including how we could **remove the dependency on the external zkVerify aggregation layer**.

---

## 1. What Stacks Shield is

Stacks Shield lets a user deposit a public asset (STX, sBTC, USDCx) into a shared **shielded pool** and receive a private **note** they alone control. From there they can:

- **Shield** — deposit a public amount, get a private note.
- **Transfer** — send a note privately to another user's shield address.
- **Split** — turn one note into two (to pay an exact amount).
- **Merge** — combine two notes into one.
- **Withdraw** — redeem a note back to a public address (any address, not just the depositor).

The public chain sees deposits and withdrawals as transparent amounts, but **nothing links a withdrawal back to the deposit it came from**, and transfers/splits/merges reveal neither amounts nor participants. Privacy comes from ZK proofs over a Merkle tree of cryptographic commitments, plus a relayer that submits the spend so the chain never sees the real user as the transaction sender.

The **native STX protocol is frozen** (deployed, immutable). SIP-10 multi-asset support was added as a **separate, additive extension** that reuses the frozen privacy core, so STX behaviour never changed.

---

## 2. System architecture

Seven cooperating layers:

```
┌──────────────┐   ┌──────────────┐   ┌───────────────────────────┐
│  Frontend    │   │     SDK      │   │  Clarity contracts (Stacks)│
│  (React)     │──▶│ @stacks-     │──▶│  frozen STX core +         │
│  wallet UI   │   │  shield/sdk  │   │  SIP-10 extension          │
└──────────────┘   └──────┬───────┘   └─────────────┬─────────────┘
                          │                          │
              proofs (bb.js/UltraHonk)        events / reads
                          │                          │
                   ┌──────▼───────┐          ┌───────▼────────┐
                   │   Relayer    │          │  API + Indexer │
                   │ submit+publish│         │ (Postgres)     │
                   └──────┬───────┘          └────────────────┘
                          │
                   ┌──────▼───────┐
                   │  zkVerify    │  (external L1 — off-chain proof
                   │  (Volta)     │   verification + aggregation)
                   └──────────────┘
```

### 2.1 Clarity contracts (Stacks L1)

**Frozen native STX protocol (6 contracts):**

| Contract | Role |
|---|---|
| `privacy-registry` | Governance: protocol limits, max-fee-bps ceiling, commitment/root/note versions, the current Merkle root, nullifier & commitment registration. The shared trust anchor. |
| `note-manager` | Records note commitments + owner commitments. |
| `privacy-pool` | Native STX shield / transfer / withdraw; holds the shielded STX. |
| `split-merge-manager` | STX split & merge (reshaping notes). |
| `protocol-fees` | Native fee config + treasury (shield/transfer/withdrawal fee types). |
| `zk-verifier` | Checks that a proof's public-inputs leaf is a member of a zkVerify aggregation root that is live on chain. |

**SIP-10 extension (5 contracts) — reuses `privacy-registry` + `note-manager`:**

| Contract | Role |
|---|---|
| `sip-010-trait` | The standard SIP-010 fungible-token trait the pool calls tokens through. |
| `asset-registry` | Source of truth for supported assets: uid, symbol, token principal, decimals, shield limits, per-asset fee config, per-asset fee recipient. |
| `sip10-pool` | One pool for **all** SIP-10 assets: shield / transfer / split / merge / withdraw, asset-bound, with a per-asset conservation invariant. |
| `sip10-protocol-fees` | Per-asset token-native fee collection + per-asset treasury. |
| `sip10-zk-verifier` | Same aggregation-membership check as `zk-verifier`, for SIP-10 proofs. |

`mock-sbtc` / `mock-usdc` exist for local testing but are **never deployed** to testnet (real token contracts are used there).

### 2.2 Zero-knowledge circuits (Noir / UltraHonk)

Five operations, each a Noir circuit compiled to UltraHonk, with a native variant and a `sip10-` variant:

`shield`, `transfer`, `split`, `merge`, `withdraw` (+ `keygen` for viewing keys).

The SIP-10 variants add an `asset_id` public input and bind it into the commitment (see §3). Proofs are generated **client-side** (`@aztec/bb.js` WASM) — in the browser for the web app, in-process in Node for scripts/e2e (no WSL, no native toolchain needed).

### 2.3 zkVerify (external aggregation L1)

UltraHonk proofs are far too expensive to verify directly inside Clarity (no elliptic-curve pairing primitives). Instead proofs are verified **off chain** by **zkVerify (Volta testnet)**, which batches many verified proofs into an **aggregation** and produces a single Merkle **aggregation root**. The relayer publishes that root on chain (`submit-aggregation`). A spend then only has to prove, cheaply, that its public-inputs leaf is a member of a published root — a hash-path check Clarity *can* do.

Because zkVerify is a separate chain, aggregation roots **survive Stacks testnet resets**.

### 2.4 Relayer (`services/relayer`)

- **proof-validator** — sanity-checks proofs/public inputs before submission.
- **zkVerify submitter** — submits proofs to zkVerify and tracks aggregation.
- **root-publisher** — publishes each aggregation root on chain to **both** verifiers (`zk-verifier` and `sip10-zk-verifier`), idempotently.
- **transaction-manager** — builds, signs and broadcasts the on-chain spend **as the relayer**, so the chain never sees the real user (this is what makes transfers private).
- **relayer-service** — orchestration + REST API the SDK talks to.

### 2.5 API + indexer (`services/api`, Postgres)

- **block-indexer** — watches the tip, dispatches contract events.
- **note-indexer** — turns `commitment-registered` / pool events into rows (asset-aware via `asset_id`).
- **aggregation-indexer** — tracks published roots.
- **stats-indexer** — recomputes protocol stats (pool balances read live on chain).
- Serves the SDK/clients: `/assets`, `/stats` (now with a per-asset `byAsset` breakdown), `/commitments` (to rebuild the tree), `/notes/encrypted` (the trial-decrypt feed), `/roots`, `/me/*`.

The API **never stores note amounts, secrets, or nullifier→commitment links** — only opaque ciphertext and public locators.

### 2.6 SDK (`@stacks-shield/sdk`)

The single integration surface. Everything (contracts, relayer, zkVerify, Merkle tree, nullifiers, commitments) is hidden behind:

```ts
const shield = new STXShield({ network: "testnet", signer,
  proofEngine: createWebEngine({ artifactsBaseUrl: "/circuits" }),
  noteVault: localStorageVault() });
await shield.shield(100, "USDCx");
```

Injectable seams: `ProofEngine` (bb.js), `WalletSigner`, `ApiProvider`, `RelayerProvider`, `ZkVerifySubmitter`, `NoteVault`. Builds an index/node/web bundle via tsup. (Renamed from `@stx-shield/sdk` → `@stacks-shield/sdk`.)

### 2.7 Frontend (React)

Multi-asset dashboard: asset selector on shield, per-note asset denomination, per-asset balances, live USD (CoinGecko), protocol stats by asset, and a local `NoteVault` for durability. The SDK is a hard dependency — the frontend never talks to contracts/relayer/zkVerify directly.

---

## 3. The privacy model

**Note.** A private balance is a *note*: `{ amount, owner keys, blinding }`. Its public fingerprint is a **commitment**.

**Commitment (STX):** `Poseidon4(amount, ownerPkX, ownerPkY, blinding)`.

**Commitment (SIP-10):** `Poseidon2( Poseidon4(amount, ownerPkX, ownerPkY, blinding), asset_id )` where `asset_id = fePrincipal(token)` — the token contract principal reduced to a field element. This **binds the asset into the commitment cryptographically**, so a USDCx note can never be spent as a sBTC note even though all assets share one tree.

**Merkle tree.** All commitments (every asset) live in **one shared, asset-agnostic commitment tree** in `privacy-registry`. Spends prove Merkle membership of their input commitment.

**Nullifier.** Spending a note publishes a deterministic **nullifier** derived from the note secret. The registry rejects a repeat → **double-spend prevention** without revealing which note was spent.

**Encrypted notes.** The note payload is encrypted to the owner's **viewing key** and published as opaque ciphertext. Clients discover their notes by **trial-decrypting** the public feed locally — the server never learns ownership or amounts.

**Value conservation.** Every circuit enforces inputs = outputs (+ fee), so no value is created or destroyed; for SIP-10 the pool additionally asserts a per-asset **conservation invariant**: `token.balance(pool) == shielded-total[asset]` (shield adds to both, withdraw subtracts from both), defending against lying/fee-on-transfer tokens.

---

## 4. Multi-asset (SIP-10) design

The goal was to add sBTC/USDCx **without touching the frozen STX protocol** and **without fragmenting privacy**.

- **One pool, many assets.** `sip10-pool` handles every registered SIP-10 asset. Routing (which pool/verifier/fee-manager) comes from the on-chain `asset-registry`, exposed by the API's `/assets`, consumed by the SDK — so **adding a new token needs only on-chain registration, no code change**.
- **One shared tree.** All assets share the `privacy-registry` commitment tree; asset isolation is enforced by the asset-bound commitment, not by separate trees. This keeps the anonymity infrastructure unified.
- **Asset-aware everywhere.** Commitments, nullifiers, circuits (6/7/9 public inputs incl. `asset_id`), indexer columns, SDK note model, and the UI all carry the asset through.
- **Backward compatible.** Native STX notes (no asset field) still decode and spend exactly as before.

**Live status (testnet):** all three assets — STX, USDCx (`…usdcx`), sBTC (`…sbtc-token`) — pass the full shield → transfer → split → merge → withdraw lifecycle with real proofs, replay-rejection, and value-conservation checks.

---

## 5. Fee model

Fees mirror the native STX protocol and are configured per-asset in `asset-registry`:

| Operation | Fee | Who pays | How it's charged | Private? |
|---|---|---|---|---|
| **Shield** | **25 bps (0.25%)** | user | `bps × amount`, folded into the deposit | ✅ |
| **Withdrawal** | **30 bps (0.30%)** | user | `bps × amount`, taken from the payout `as-contract` from the pool | ✅ (public can't link the payer) |
| Transfer / Split / Merge | 0 (flat-only, disabled) | tx-sender = **relayer** | `calculate-fee(…, u0)` ⇒ bps ignored, **flat only** | — |

Key insight that shaped this: **only shield & withdrawal can take a percentage**, because their amount is public at that moment. Transfer/split/merge run over hidden amounts, so the contract passes `amount = u0` and only a **flat** fee is possible — and that flat fee is paid by the transaction sender, which for a shielded op is the **relayer**. Charging a meaningful fee there would force the relayer to subsidise fees (or hold every token), so we keep those at 0. The value-scaled, user-paid fees live where they belong: **shield and withdrawal**. A percentage also scales across wildly different unit values (100 USDCx vs 0.5 sBTC) where a fixed flat cannot. Ceiling: `privacy-registry.get-max-fee-bps` (testnet 1%). Script: `scripts/deployment/sip10/set-sip10-fees.ts`.

---

## 6. What worked well

- **Additive multi-asset with zero changes to the frozen core.** Asset-bound commitments + a shared tree gave real multi-asset privacy while STX stayed byte-for-byte frozen.
- **Registry-driven assets.** New tokens are onboarded by on-chain registration alone; the SDK/frontend discover them via `/assets`. No redeploy to add an asset.
- **In-process proving with bb.js.** UltraHonk proofs generate in the browser (WASM threads) and in Node with no native toolchain / no WSL — huge for portability and CI.
- **Clean SDK seam.** One injectable client hides the entire stack; the frontend never touches contracts/relayer/zkVerify. Made the web integration small and safe.
- **zkVerify survived resets.** Because aggregation lives on a separate chain, Stacks testnet resets didn't destroy proof history.
- **Strong invariants.** Per-asset conservation invariant + nullifier double-spend rejection + value-conservation in every circuit — verified live for all three assets.
- **Layered testing.** ~93 automated tests (integration + relayer + API + SDK) plus real-proof e2e for STX, USDCx and sBTC (including big amounts and withdraw-to-new-address).

---

## 7. What didn't work / hard-won fixes

| Problem | Root cause | Fix |
|---|---|---|
| Dashboard showed **0 notes / lost 100 STX** | `asset_id` columns were never migrated into the live DB → every note/tx insert threw → nothing indexed → `registerNote` silently failed | Run `migrate-sip10.ts` **+** `reset-indexer.ts` after any API deploy; stop swallowing `registerNote` errors; add a local `NoteVault` |
| Spends failed "**not on chain yet**" after a testnet reset | Indexer cursor persisted the *old* chain's height → indexed nothing, served stale commitments | `reset-indexer.ts` (truncate + clear cursors) so it re-scans the fresh chain |
| `u561 ERR-AGGREGATION-NOT-FOUND` on SIP-10 shield | Relayer published roots only to `zk-verifier`, never `sip10-zk-verifier` | root-publisher now dual-publishes idempotently; SDK waits for the root on **the asset's own verifier** before broadcasting |
| **Frontend reported "Shield complete" for a tx that reverted** (`u459`) | `shield()` returned `status:"confirmed"` the instant it broadcast, never checking the tx | `waitForTx()` polls the tx and **throws on abort/dropped**, returns confirmed only on success, and **rolls back** the optimistic note from store + vault |
| sBTC shield reverts `u459` from the web wallet | That wallet holds **0 sBTC** (deployed `sbtc-token` has no public mint) | Fund the wallet via a standard `transfer` from a wallet that holds sBTC |
| Frontend still "STX-only" | `.env.local` overrode the API URL to the old (pre-SIP-10) deployed API that 404s on `/assets` | Point `VITE_API_URL` at the SIP-10 API; restart (Vite reads env only at startup) |
| Vite `does not provide an export 'localStorageVault'` | Vite's pre-bundled dep cache was stale after the SDK dist changed / the package was renamed | `rm -rf frontend/node_modules/.vite` and restart |

**Recurring theme:** the **indexer is the fragile joint.** Most "privacy is broken" symptoms were actually indexer/DB drift (missing migration, stale cursor), not cryptography. See §9.

---

## 8. Why we chose this model

- **Off-chain verification + on-chain aggregation membership (zkVerify).** Clarity has no BN254/BLS pairing primitives, so verifying an UltraHonk proof *inside* a contract is infeasible today. Verifying off-chain and only proving cheap **Merkle membership of the public-inputs leaf** on chain is the only workable path on current Stacks. It also amortises cost across many proofs via aggregation.
- **A relayer for sender privacy.** ZK hides *what* moved; it can't hide *who broadcast the transaction*. Having the relayer sign and pay for the spend removes the last identifying link. The trade-off is a trusted-liveness component (see §10).
- **One shared tree + asset-bound commitments** (rather than one pool/tree per asset) keeps the anonymity set and infrastructure unified while still guaranteeing assets can't cross.
- **Registry-driven routing** so the protocol scales to new assets by governance, not by shipping code.
- **A frozen core + additive extension** to guarantee the audited STX behaviour is untouched by later work.

---

## 9. Improvement proposals

### 9.1 Harden the indexer (highest ROI)
- **Migrations run automatically** on API boot, idempotent, with a schema-version check that refuses to serve if the DB is behind.
- **Reset detection:** if the on-chain tip height < the stored cursor, auto-truncate + re-scan instead of silently indexing nothing.
- **Health endpoint** exposing `indexerLag = tipHeight − processedHeight`; the SDK can warn/wait on it instead of blindly retrying "not on chain yet".
- **Reconciliation job** that periodically checks `/commitments` count vs on-chain commitment count.

### 9.2 Confirmation & durability (partly done)
- `waitForTx` now guards shield; extend the same on-chain-status confirmation to relayer-submitted transfer/split/merge/withdraw so nothing ever reports success on a revert.
- Encrypt-and-persist notes to the `NoteVault` on **every** op, and reconcile the vault against the API feed on load. (A note's blinding lives only in its ciphertext — losing it loses the funds.)

### 9.3 Prover performance
- Cache compiled circuits + proving keys aggressively; warm the WASM prover on app load.
- Explore GPU/native proving for the relayer/e2e path; keep bb.js WASM for the browser.
- **Recursive aggregation** to compress many spends into one proof and cut per-op cost.

### 9.4 Fee & economics
- Add a **relayer fee type** so the relayer recoups its gas + (optional) flat op fee from the user, enabling non-zero transfer/split/merge economics without subsidy.
- Per-asset fee dashboards + treasury withdrawal tooling.

### 9.5 UX
- Show pending vs confirmed distinctly (the SDK now returns honest `pending`).
- Built-in faucet/fund flow for test tokens; surface `indexerLag` as a subtle "syncing" state.
- Label testnet USD as indicative (mock sBTC priced at real BTC produces huge but arithmetically-correct figures).

### 9.6 Decentralisation & resilience
- **Multiple relayers / a relayer marketplace** so no single relayer is a liveness or censorship chokepoint.
- Multiple indexers behind a quorum read.

---

## 10. Removing the third-party dependency (zkVerify)

zkVerify is currently the **critical external dependency**: it verifies proofs and produces the aggregation roots the contracts trust. It adds latency (aggregation dominates per-op time), an external-chain liveness assumption, and an external trust root. Options to reduce or remove it, roughly in order of feasibility:

**A. Self-host the aggregation layer (shortest path).**
Run our **own** proof-verification + aggregation service (same cryptographic design, our infrastructure) and have the relayer publish its roots. This *removes the third party* without changing the contracts — the on-chain check is still "leaf ∈ published root". Trade-off: we now operate and must be trusted for that service (mitigate with multiple independent aggregators + published roots anyone can audit).

**B. Native on-chain proof verification (the real end-goal).**
Verify the SNARK directly in Clarity, deleting the aggregation layer entirely. Blocked today because Clarity lacks EC-pairing/precompile support for BN254/BLS. Paths:
- Advocate for / adopt **Clarity pairing precompiles** (a `crypto`-namespace addition) — then a Groth16/PLONK verifier becomes viable on chain.
- Switch to a **proof system verifiable with the primitives Clarity already has** (sha256/keccak, secp256k1). Hash-based **STARKs** need no pairings, but a full STARK verifier is still heavy for Clarity's cost budget today; a **recursive STARK-wrapping-SNARK** that shrinks to a tiny final check is the research direction.

**C. Anchor to Bitcoin via the Stacks/Nakamoto + sBTC stack.**
Use Bitcoin finality / an sBTC-aligned verification path as the trust root instead of an external L1. Speculative, but philosophically aligned with Stacks.

**D. An app-specific L2 / subnet.**
Do verification + aggregation in a Stacks subnet that settles to L1, keeping everything inside the Stacks ecosystem. Removes the *external* dependency at the cost of running the subnet.

**Recommended sequence:** ship **(A)** now to eliminate the outside party and control latency; invest in **(B)** (pairing precompiles or a Clarity-friendly proof system) as the durable, trust-minimised finish line; treat **(C)/(D)** as ecosystem-level bets.

Independently, **decentralising the relayer (§9.6)** removes the *other* trusted component (sender-privacy liveness), which together with (A)/(B) would make Stacks Shield self-contained on Stacks.

---

## 11. Repository map

```
contracts/                 Clarity: frozen STX core + SIP-10 extension (+ mocks, not deployed)
zk/circuits/               Noir/UltraHonk circuits (native + sip10/) + keygen
sdk/                       @stacks-shield/sdk (client, crypto, proving, providers, vault)
services/api/              REST API + Postgres indexer (block/note/aggregation/stats)
services/relayer/          proof-validator, zkVerify submitter, root-publisher, tx-manager
frontend/                  React app (multi-asset dashboard, per-asset + USD, local vault)
scripts/deployment/sip10/  deploy, configure, register-assets, set-sip10-fees, verify
scripts/testnet/sip10/     real-proof op runner + e2e
scripts/testnet/sdk-e2e/   reusable SDK end-to-end validation suite (STX/USDCx/sBTC)
```

**Handy commands**
```bash
# API: always after deploying the API
tsx services/api/scripts/migrate-sip10.ts
tsx services/api/scripts/reset-indexer.ts          # after a testnet reset

# Fees (mirrors native STX: shield 25 bps, withdrawal 30 bps)
FEE_SHIELD_BPS=25 FEE_WITHDRAW_BPS=30 FEE_FLAT_TOKENS=0 \
  npx tsx scripts/deployment/sip10/set-sip10-fees.ts

# Full SDK e2e (all three assets)
E2E_ASSETS=stx,usdcx,sbtc npx tsx scripts/testnet/sdk-e2e/run.ts
```

---

## 12. TL;DR

Stacks Shield is a working, multi-asset (STX + sBTC + USDCx) shielded-transfer protocol on Stacks. Privacy = ZK commitments + nullifiers + one shared Merkle tree, with a relayer for sender anonymity. Proofs are verified off chain by zkVerify (because Clarity can't verify SNARKs yet) and only cheap aggregation-membership is checked on chain. Multi-asset was added additively via asset-bound commitments and an on-chain asset registry, leaving the frozen STX core untouched. Fees are user-paid percentages on shield (0.25%) and withdrawal (0.30%), private, exactly like native STX. The main fragility is the indexer, not the cryptography — harden that first. The biggest architectural win available is **removing the external zkVerify dependency**: self-host aggregation now, and pursue native on-chain verification (pairing precompiles or a Clarity-friendly proof system) as the trust-minimised endgame.
