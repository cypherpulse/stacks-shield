# @stacks-shield/sdk

[![npm](https://img.shields.io/npm/v/@stacks-shield/sdk/beta)](https://www.npmjs.com/package/@stacks-shield/sdk)
[![install size](https://img.shields.io/bundlephobia/minzip/@stacks-shield/sdk)](https://bundlephobia.com/package/@stacks-shield/sdk)
[![License](https://img.shields.io/npm/l/@stacks-shield/sdk)](https://github.com/cypherpulse/stacks-shield/blob/main/LICENSE)

**Privacy for STX and SIP-10 tokens, in minutes.** Shield, transfer, split, merge
and withdraw STX, sBTC, USDCx and other SIP-10 tokens with zero-knowledge
proofs — without ever touching Noir, UltraHonk, zkVerify, Merkle trees,
nullifiers, commitments or relayers.

> **Beta / testnet.** This is a pre-release for Stacks Testnet and is **not
> audited**. Do not use it with assets of real value.

```ts
import { STXShield } from "@stacks-shield/sdk";

const shield = new STXShield({ network: "testnet", signer });

await shield.shield(100);                 // 100 STX -> private note
await shield.shield(1000, "USDCx");       // SIP-10 token by symbol
await shield.transfer(50, bobAddress);    // send privately
const [a, b] = (await shield.split(note, [25, 25])).notes;
const merged = (await shield.merge([a, b])).note;
await shield.withdraw(merged);            // back to transparent tokens
```

---

## 1. Installation

```bash
npm install @stacks-shield/sdk
# or: pnpm add @stacks-shield/sdk  /  yarn add @stacks-shield/sdk
```

ESM and CommonJS builds and full TypeScript types are included. The package is
side-effect-free and tree-shakable — you only bundle what you import.

## 2. Quick Start

```ts
import { STXShield } from "@stacks-shield/sdk";

const shield = new STXShield({
  network: "testnet",
  signer,            // your wallet signer (see Authentication)
});

const { note } = await shield.shield(100);
await shield.withdraw(note);
```

## 3. Authentication

Stacks Shield is Web3-native: **no email, passwords or OAuth.** A wallet signature
is the only credential. Provide a `signer` (in the browser this wraps
`@stacks/connect` — Leather, Xverse, Asigna; in Node a key-based signer) and the
SDK handles the nonce → sign → JWT flow for you:

```ts
await shield.connect();          // one-time wallet auth (idempotent)
const address = await shield.getAddress();   // your shareable shield address
```

Share `address` so others can transfer to you privately.

## 4. Shield

```ts
const { note } = await shield.shield(100);   // amount in STX (or bigint micro-STX)
```

Moves transparent STX into a private note. This is the only user-signed
operation (it spends your own funds). Minimum 1 STX.

## 5. Transfer

```ts
await shield.transfer(50, recipientShieldAddress);
```

Moves note ownership privately. The recipient discovers the note via
`getNotes()`. Submitted by a relayer, so **you never appear on chain.**

## 6. Split

```ts
const { notes } = await shield.split(note, [25, 25]);  // sums must equal note.amount
```

## 7. Merge

```ts
const { note: merged } = await shield.merge([noteA, noteB]);
```

## 8. Withdraw

```ts
await shield.withdraw(note, recipientStxAddress);  // recipient optional (defaults to you)
```

Converts a note back to transparent STX. Minimum 1 STX; a small protocol fee
applies. Submitted by a relayer for recipient privacy.

## 9. Notes

```ts
const notes = await shield.getNotes();   // your notes, amounts decrypted locally
const history = await shield.getHistory();
const stats = await shield.getStats();
```

Discovery trial-decrypts the API's encrypted feed with your viewing key. **The
server never learns your note amounts** — they are decrypted only on your device.

## 10. Errors

Every error is an `STXShieldError`; catch broadly or narrowly:

```ts
import { InvalidNoteError, RelayerError, STXShieldError } from "@stacks-shield/sdk";

try {
  await shield.withdraw(note);
} catch (e) {
  if (e instanceof InvalidNoteError) { /* spent / not owned */ }
  else if (e instanceof RelayerError) { /* transient — retry */ }
  else if (e instanceof STXShieldError) { /* anything else */ }
}
```

Also exported: `RootNotFoundError`, `ProofGenerationError`, `AuthenticationError`,
`ApiError`, `ConfigError`.

## 11. Networks

```ts
new STXShield({ network: "testnet" });
new STXShield({ network: "mainnet", apiUrl, relayerUrls });  // override endpoints
```

`network: "testnet"` defaults to the live deployment:

- API — `https://stx-shield-api.onrender.com`
- Relayer — `https://stx-shield-relayer.onrender.com`

Override either with `apiUrl` / `relayerUrls` (pass several relayer URLs for
censorship-resistant failover).

## 12. Examples

See [`examples/`](./examples): `node.ts`, `react.tsx`, `nextjs.ts`, `vite.ts`.

---

## Proof engine (advanced)

Zero-knowledge proving is **pluggable** and never bundled into your app unless
you opt in. Provide a `proofEngine`:

- **Node / server:** the Noir + Barretenberg toolchain engine — this is the flow
  proven end-to-end on Stacks Testnet (shield → transfer → split → merge →
  withdraw, all real, submitted by a relayer).
- **Browser:** a WASM (bb.js) engine is the roadmap. Until its proofs are
  validated byte-for-byte against zkVerify it is not enabled by default — the SDK
  will not silently ship a prover that produces rejected proofs.

Reads, authentication, stats and note discovery work **without** any engine.

## Security

The SDK never stores or logs private keys, never transmits secrets, never
exposes nullifiers or Merkle paths, never caches proofs, and validates every
response. Note secrets live only in memory.

## License

Apache-2.0 — see [LICENSE](../LICENSE).
