# STX Shield — Frontend Integration Guide

Everything a frontend needs to consume the STX Shield SDK and drive every flow
we tested on testnet — **shield → transfer → split → merge → withdraw** — plus
the raw API and relayer endpoints you can call directly.

The SDK hides Noir, UltraHonk, zkVerify, Merkle trees, nullifiers, commitments
and relayers. A frontend works with three things: a **client**, a **signer**,
and **notes**.

- Live API: `https://stx-shield-api.onrender.com`
- Live relayer: `https://stx-shield-relayer.onrender.com`
- Contracts (testnet deployer): `ST2HXRZ8A82JJAP14KD83JEXNRCF34J67088WJSJH`

> Note: the API/relayer are on Render's free tier and cold-start after ~15 min
> idle — the first request after a nap takes ~30–60s. The SDK retries/timeouts
> absorb this, but show a "waking up…" state on first load.

---

## 1. Install

```bash
npm install @stx-shield/sdk
# provers are OPTIONAL peer deps — install only if you generate proofs in-app:
npm install @aztec/bb.js@3.0.0-nightly.20260102 @noir-lang/noir_js@1.0.0-beta.18 zkverifyjs
# browser wallet:
npm install @stacks/connect
```

Entry points:

| Import | Use |
|---|---|
| `@stx-shield/sdk` | the `STXShield` client, types, errors |
| `@stx-shield/sdk/web` | `createWebEngine` — browser (WASM) proof engine |
| `@stx-shield/sdk/node` | `createNodeEngine` — Node proof engine (SSR / scripts) |

---

## 2. Construct the client

```ts
import { STXShield } from "@stx-shield/sdk";
import { createWebEngine } from "@stx-shield/sdk/web";

const shield = new STXShield({
  network: "testnet",              // defaults to the live API + relayer URLs
  signer,                          // see §3 — required for anything key-related
  proofEngine: createWebEngine({   // see §4 — required to prove
    artifactsBaseUrl: "/circuits",
    threads: 4,
  }),
  zkVerify: { seed: import.meta.env.VITE_ZKVERIFY_SEED },  // see §5
});
```

### `SDKConfig`

| Field | Type | Default | Notes |
|---|---|---|---|
| `network` | `"testnet" \| "mainnet"` | — | `testnet` → live URLs; `mainnet` not deployed |
| `apiUrl` | `string` | network default | override the public API base URL |
| `relayerUrl` | `string` | — | single relayer |
| `relayerUrls` | `string[]` | network default | multiple relayers → automatic failover |
| `deployer` | `string` | network default | contract deployer address |
| `signer` | `WalletSigner` | — | required for connect/getNotes/shield/etc. |
| `proofEngine` | `ProofEngine` | — | required to generate proofs |
| `zkVerify` | `{ endpointUrl?, seed?, domainId? }` | domain 0 | how proofs reach zkVerify (§5) |
| `timeoutMs` | `number` | `30000` | per-request timeout for API/relayer |
| `logger` | `Logger` | warn (testnet) | structured logger; never logs secrets |

Read-only stats work with **no** signer, engine, or zkVerify config:

```ts
const readonly = new STXShield({ network: "testnet" });
await readonly.getStats();
```

---

## 3. Implement the `WalletSigner` (browser)

The SDK never holds a private key — you pass a signer it calls when it needs a
signature. In the browser, back it with `@stacks/connect` (Leather / Xverse /
Asigna). The interface:

```ts
interface WalletSigner {
  getAddress(network: "testnet" | "mainnet"): Promise<string> | string;
  signMessage(message: string): Promise<{ signature: string; publicKey: string }>;
  signAndBroadcast(call: ContractCall, network): Promise<string>; // txid
  getShieldSecret(): Promise<Uint8Array> | Uint8Array;            // 32 bytes
}
```

What each is for:

- **`getAddress`** — the user's Stacks address (for auth + default withdraw target).
- **`signMessage`** — signs the API auth challenge (§7 `connect`).
- **`signAndBroadcast`** — signs+broadcasts the **shield** contract call (the only
  operation that moves the user's own transparent STX). Relayed ops never touch it.
- **`getShieldSecret`** — a stable 32-byte secret the SDK deterministically derives
  the note **owner key** (spending) and **viewing key** (discovery) from. Derive it
  from a wallet signature over a **fixed** message so it's reproducible per wallet
  and never leaves the device.

Sketch of a `@stacks/connect`-backed signer:

```ts
import { openContractCall, openSignatureRequestPopup } from "@stacks/connect";
import { sha256 } from "@noble/hashes/sha256";

const SHIELD_SECRET_MSG = "STX Shield — derive my private note key (v1)";

const signer: WalletSigner = {
  getAddress: () => userSession.loadUserData().profile.stxAddress.testnet,

  signMessage: (message) => new Promise((resolve) =>
    openSignatureRequestPopup({
      message,
      onFinish: (d) => resolve({ signature: d.signature, publicKey: d.publicKey }),
    })),

  signAndBroadcast: (call) => new Promise((resolve, reject) =>
    openContractCall({
      contractAddress: call.contractAddress,
      contractName: call.contractName,
      functionName: call.functionName,
      functionArgs: call.functionArgs,   // already Clarity-encoded by the SDK
      onFinish: (d) => resolve(d.txId),
      onCancel: () => reject(new Error("user cancelled")),
    })),

  getShieldSecret: async () => {
    const { signature } = await signer.signMessage(SHIELD_SECRET_MSG);
    return sha256(new TextEncoder().encode(signature)); // 32 bytes, stable per wallet
  },
};
```

> The shield-secret derivation must be **deterministic** — the same wallet must
> always produce the same 32 bytes, or the user loses access to their notes.
> Signing a fixed message is the standard trick; the wallet signature is stable.

---

## 4. The proof engine (browser)

Proofs are generated in the browser with `createWebEngine`. It fetches compiled
circuit JSON over HTTP and runs bb.js (UltraHonk, WASM).

```ts
import { createWebEngine } from "@stx-shield/sdk/web";

const proofEngine = createWebEngine({
  artifactsBaseUrl: "/circuits",  // hosts shield.json, transfer.json, split.json,
                                  //           merge.json, withdraw.json, keygen.json
  threads: 4,                     // use 1 if NOT cross-origin isolated
});
```

**Host the circuit artifacts.** Copy the compiled circuits to a public path your
app serves (`/circuits/shield.json`, etc.). These are the frozen, validated
artifacts — byte-identical vk to the CLI, accepted by zkVerify.

**Cross-origin isolation is required for WASM threads.** Serve your app with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers, set `threads: 1` (works, just slower). In Vite:

```ts
// vite.config.ts
export default defineConfig({
  server: { headers: {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  }},
});
```

---

## 5. zkVerify submission (important architectural decision)

After generating a proof, the SDK submits it to zkVerify to obtain an aggregation
inclusion the contracts re-check. Two paths:

| Path | Config | When |
|---|---|---|
| **Hosted submitter** (recommended) | `zkVerify: { endpointUrl }` | production; a small backend service you run that holds the funded zkVerify account and exposes `POST /submit` |
| **Direct** | `zkVerify: { seed }` | dev / server-side; submits straight to zkVerify Volta with a funded account seed |

**Do not ship a `seed` in a public frontend** — it's a funded zkVerify account.
For a real user-facing app, stand up a hosted submitter (accepts `{ proof,
publicInputs, vk, domainId }`, returns the `Inclusion`) and point `endpointUrl`
at it. For local testing against testnet, `seed` is fine.

> This is currently the main piece to build for a pure-browser deployment: a
> hosted submitter endpoint. Everything else already runs live.

---

## 6. The five flows (exactly what we tested)

All operation methods return a response with `{ txid, status, timestamp }`. Amounts
are **STX** (numbers) or **micro-STX** (bigint); `1 STX = 1_000_000 µSTX`.

### 6.1 Shield — transparent STX → private note (user-signed)

```ts
const res = await shield.shield(100);      // 100 STX
// res.note  → the new ShieldNote (keep it; it's spendable)
// res.txid  → Stacks txid
```

- Minimum **1 STX**. Below that throws `InvalidNoteError`.
- The **only** flow that prompts the wallet (moves the user's own STX).
- Internally: proves, submits to zkVerify, waits for the root to publish, then
  `signAndBroadcast` the `privacy-pool.shield` call.

### 6.2 Transfer — send privately to a shield address (relayed)

```ts
const recipientAddr = "..."; // recipient's STX Shield address (see §8 getAddress)
const res = await shield.transfer(50, recipientAddr);
```

- **Requires an unspent note of EXACTLY that amount.** If you don't have one,
  it throws `no unspent note of exactly … µSTX; split first`. **Split to the
  denomination first** (§6.3). This is by design — see §9.
- Goes through the **relayer** — no wallet prompt; the sender never appears on chain.

### 6.3 Split — one note → two notes you own (relayed)

```ts
const res = await shield.split(note, [30, 70]);  // must sum to note.amount
// res.notes → [ShieldNote, ShieldNote]
```

- Produces **exactly two** notes; amounts must sum to the input note's amount.
- For more than two, chain splits: split, then split a result.
- Use this to create exact denominations for transfer/withdraw.

### 6.4 Merge — two notes → one (relayed)

```ts
const res = await shield.merge([noteA, noteB]);
// res.note → the single merged note (amount = A + B)
```

- Takes **exactly two** notes.

### 6.5 Withdraw — private note → transparent STX (relayed)

```ts
const res = await shield.withdraw(note);            // to the signer's address
const res = await shield.withdraw(note, someStxAddr); // to an explicit address
// res.recipient       → where funds landed
// res.amountReceived  → µSTX after the ~0.3% protocol withdraw fee (bigint)
```

- Minimum **1 STX**.
- A spent note cannot be reused — the nullifier is published, so a second
  withdraw of the same note fails on chain (we verified double-spend prevention).

### End-to-end example (the flows we ran)

```ts
await shield.connect();                       // §7
const s = await shield.shield(100);           // Alice shields 100
await shield.transfer(100, bobShieldAddress); // Alice → Bob (needs exact 100 note)

// Split + withdraw path:
const s2 = await shield.shield(1);
const { notes } = await shield.split(s2.note, [0.3, 0.7]);
const merged = await shield.merge(notes);     // 0.3 + 0.7 → 1
await shield.withdraw(merged.note, aliceAddr);
```

---

## 7. Auth, identity & reads

```ts
await shield.connect();       // wallet-signature login to the API (idempotent) → address
await shield.getAddress();    // the user's shareable STX Shield address (owner+viewing pk)
await shield.getNotes();      // ShieldNote[] this wallet owns (trial-decrypts the feed)
await shield.getStats();      // protocol Stats (no auth needed)
await shield.getHistory();    // this wallet's HistoryEntry[] (auth)
await shield.disconnect();    // clears the API session
```

- **`connect()`** does the `POST /auth/nonce` → sign → `POST /auth/verify` handshake
  and stores the JWT. Called automatically by `shield()`; call it yourself before
  `getHistory()`/authenticated reads.
- **`getAddress()`** returns the address you give to senders so they can `transfer`
  to you. Decode/encode helpers are exported: `encodeAddress`, `decodeAddress`.
- **`getNotes()`** discovers owned notes by trial-decrypting the API's encrypted
  feed with the viewing key. Amounts are decrypted **locally** — the server never
  sees them.

---

## 8. Sharing a receive address

```ts
import { encodeAddress, decodeAddress, type ShieldAddress } from "@stx-shield/sdk";

const myAddr = await shield.getAddress();     // give this to senders
// senders pass it straight to transfer():
await shield.transfer(25, myAddr);
```

---

## 9. Important behaviors & limitations (read before building UI)

- **In-memory note/tree state.** The client keeps the commitment tree and note
  store **in memory** for the life of the instance. On page reload, call
  `getNotes()` to re-discover owned notes. Keep one long-lived `STXShield`
  instance per session; don't recreate it per action.
- **Exact-denomination transfer.** `transfer(amount)` needs an unspent note of the
  exact amount. Build a small coin-selection UX: if the user lacks an exact note,
  `split` an existing one first, then transfer. (Surface this as "preparing…".)
- **Split is binary, merge is binary.** Two out of split, two into merge. Chain them
  for other shapes.
- **Shield prompts the wallet; the other four don't.** Only `shield` calls
  `signAndBroadcast`. Transfer/split/merge/withdraw are relayed — reflect that in UI
  (no signature popup, but a relayer round-trip).
- **Withdraw fee ~0.3%.** Show `amountReceived`, not the note amount.
- **Cold starts.** First API/relayer call after idle is slow (Render free tier).
- **Minimums: 1 STX** to shield and to withdraw.

---

## 10. Error handling

Every error is an `STXShieldError` (has `.code`). Catch broadly or narrowly:

```ts
import {
  STXShieldError, InvalidNoteError, RootNotFoundError, ProofGenerationError,
  RelayerError, AuthenticationError, ApiError, ConfigError,
} from "@stx-shield/sdk";

try {
  await shield.withdraw(note);
} catch (e) {
  if (e instanceof InvalidNoteError)      { /* spent / not owned / wrong amount */ }
  else if (e instanceof RelayerError)     { /* transient — retry; e.relayerCode */ }
  else if (e instanceof ProofGenerationError) { /* engine/zkVerify path issue */ }
  else if (e instanceof AuthenticationError)  { /* reconnect */ }
  else if (e instanceof ApiError)         { /* e.status */ }
  else if (e instanceof ConfigError)      { /* missing signer/engine/config */ }
  else if (e instanceof STXShieldError)   { /* anything else */ }
}
```

| Error | `code` | Typical cause |
|---|---|---|
| `InvalidNoteError` | `INVALID_NOTE` | spent, not owned, or no exact-denomination note |
| `RootNotFoundError` | `ROOT_NOT_FOUND` | referenced Merkle root not yet on chain |
| `ProofGenerationError` | `PROOF_GENERATION_FAILED` | bad witness, engine unavailable, no zkVerify path |
| `RelayerError` | `RELAYER_ERROR` | relayer rejected/failed; `.relayerCode` |
| `AuthenticationError` | `AUTHENTICATION_FAILED` | bad signature / expired nonce |
| `ApiError` | `API_ERROR` | API returned an error; `.status` |
| `ConfigError` | `CONFIG_ERROR` | missing signer/engine/config |

---

## 11. Types reference

```ts
interface ShieldNote {
  commitment: string;    // public
  ciphertext: string;    // opaque (server-stored)
  root: string;          // public
  txid: string;          // public
  amount: bigint;        // µSTX, decrypted locally — PRIVATE
  spent: boolean;
  readonly secret: NoteSecret;  // spendable; never serialize/log/transmit
}

interface Stats { shielded: number; notes: number; operations: number; users: number; fees: number; }
interface HistoryEntry { txid: string; type: "shield"|"transfer"|"split"|"merge"|"withdraw"; commitment?: string; createdAt: string; }

interface ShieldResponse   { txid; status; timestamp; note: ShieldNote; }
interface TransferResponse { txid; status; timestamp; change?: ShieldNote; }
interface SplitResponse    { txid; status; timestamp; notes: ShieldNote[]; }
interface MergeResponse    { txid; status; timestamp; note: ShieldNote; }
interface WithdrawResponse { txid; status; timestamp; recipient: string; amountReceived: bigint; }
```

> `ShieldNote.secret` is local-only. Persisting notes across reloads means
> persisting `secret` **securely** (e.g. encrypted with a wallet-derived key) —
> or just re-run `getNotes()` and treat the store as ephemeral.

---

## 12. Raw endpoints (for custom UI beyond the SDK)

The SDK covers everything above; these are the underlying HTTP surfaces if you
want to build custom views (explorers, dashboards) without the client.

### Public API — `https://stx-shield-api.onrender.com` (no auth)

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `{ ok, service, version }` |
| GET | `/stats` | protocol totals |
| GET | `/notes/encrypted?limit&offset` | `{ results, limit, offset }` |
| GET | `/roots?limit&offset` | recent Merkle roots |
| GET | `/roots/latest` | `{ root, aggregationId, height, txid, createdAt }` |
| GET | `/aggregations?limit&offset` | zkVerify aggregations |
| GET | `/aggregations/:id` | one aggregation (404 if unknown) |
| GET | `/transactions?limit&offset&type` | indexed operations |
| GET | `/transactions/:txid` | one transaction |
| GET | `/fees` | fee configuration |
| GET | `/treasury` | `{ address, balanceMicroStx, balanceStx }` |
| GET | `/version` | api/network/deployer/contracts |

### Authenticated API (JWT via `Authorization: Bearer <token>`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/nonce` | `{ wallet }` → `{ nonce, message }` |
| POST | `/auth/verify` | `{ wallet, publicKey, signature, message }` → `{ token, expiresAt }` |
| POST | `/auth/logout` | end session |
| GET | `/me` | `{ wallet, notes }` |
| GET | `/me/notes` | your encrypted note records |
| GET | `/me/history` | your operation history |
| GET | `/me/operations` | your operations |
| POST | `/me/notes` | `{ commitment, ciphertext }` register a note |
| POST | `/me/notes/:commitment/spent` | mark a note spent |

### Relayer — `https://stx-shield-relayer.onrender.com`

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{ ok: true }` |
| GET | `/info` | address, network, operations, fees, contracts, `accepting` |
| POST | `/transfer` | submit a relayed transfer (returns `202` + job) |
| POST | `/withdraw` | submit a relayed withdraw |
| POST | `/split` | submit a relayed split |
| POST | `/merge` | submit a relayed merge |
| GET | `/status/:jobId` | job state (`queued`/`active`/`completed`/`failed`) + txid |

> The SDK's relayer provider already handles submission, failover across
> `relayerUrls`, and polling `/status/:jobId` until the tx lands. Only call these
> directly if you're bypassing the SDK.

---

## 13. Minimal React wiring

```tsx
import { useMemo, useState } from "react";
import { STXShield, type ShieldNote } from "@stx-shield/sdk";
import { createWebEngine } from "@stx-shield/sdk/web";

export function useShield(signer) {
  return useMemo(() => new STXShield({
    network: "testnet",
    signer,
    proofEngine: createWebEngine({ artifactsBaseUrl: "/circuits", threads: 4 }),
    zkVerify: { endpointUrl: import.meta.env.VITE_SUBMITTER_URL }, // hosted submitter
  }), [signer]);
}

export function Wallet({ shield }: { shield: STXShield }) {
  const [notes, setNotes] = useState<ShieldNote[]>([]);
  const refresh = async () => setNotes(await shield.getNotes());

  return (
    <>
      <button onClick={() => shield.connect().then(refresh)}>Connect</button>
      <button onClick={() => shield.shield(10).then(refresh)}>Shield 10 STX</button>
      <ul>{notes.map((n) => (
        <li key={n.commitment}>{Number(n.amount) / 1e6} STX
          <button onClick={() => shield.withdraw(n).then(refresh)}>Withdraw</button>
        </li>
      ))}</ul>
    </>
  );
}
```

---

## 14. Frontend build checklist

- [ ] Long-lived `STXShield` instance (don't recreate per action).
- [ ] `WalletSigner` backed by `@stacks/connect`, with a **deterministic**
      `getShieldSecret`.
- [ ] Circuit artifacts hosted at `artifactsBaseUrl`.
- [ ] COOP/COEP headers set (or `threads: 1`).
- [ ] A **hosted zkVerify submitter** (`endpointUrl`) — do not ship a `seed`.
- [ ] Coin-selection UX: split to exact denominations before transfer.
- [ ] Show `amountReceived` (post-fee) on withdraw.
- [ ] Handle cold-start latency on first API/relayer call.
- [ ] Re-run `getNotes()` on load; treat note store as ephemeral (or persist
      `secret` encrypted).
```
