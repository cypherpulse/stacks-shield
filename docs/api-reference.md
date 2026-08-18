# API reference

The Stacks Shield API is a **read-only indexer** over the on-chain protocol, plus
an authenticated per-wallet namespace for encrypted-note storage. It never holds
amounts, secrets, viewing keys, or nullifier→commitment links.

> Most integrators don't call this directly — the [`@stacks-shield/sdk`](../sdk/README.md)
> wraps every endpoint. This reference is for building your own client or
> dashboard.

**Base URL:** your deployment's API origin (e.g. a local `http://localhost:8888`
or the hosted testnet API). All responses are JSON.

## Public (read-only)

### `GET /assets`
Every supported asset (native STX + registered SIP-10 tokens), from the on-chain
`asset-registry`.

```json
{ "results": [
  { "id": 0, "symbol": "STX",   "token": null, "decimals": 6, "active": true, "native": true,  "pool": "…", "verifier": "…" },
  { "id": 1, "symbol": "USDCx", "token": "ST1….usdcx",      "decimals": 6, "active": true, "native": false, "pool": "…", "verifier": "…" },
  { "id": 2, "symbol": "sBTC",  "token": "ST1….sbtc-token", "decimals": 8, "active": true, "native": false, "pool": "…", "verifier": "…" }
] }
```

### `GET /stats`
Aggregate protocol stats, with a **per-asset** breakdown. `shielded`/`fees`
top-level are STX (backward compatible); `byAsset` carries every asset in its own
units.

```json
{
  "shielded": 506, "notes": 52, "operations": 131, "users": 11, "fees": 1.316,
  "byAsset": [
    { "id": 0, "symbol": "STX",   "decimals": 6, "native": true,  "shielded": 506,    "fees": 1.316 },
    { "id": 1, "symbol": "USDCx", "decimals": 6, "native": false, "shielded": 300020, "fees": 0 },
    { "id": 2, "symbol": "sBTC",  "decimals": 8, "native": false, "shielded": 200000, "fees": 0 }
  ],
  "updatedAt": "2026-08-15T…Z"
}
```

### `GET /commitments`
All on-chain commitments in leaf-index order — clients rebuild the Merkle tree
from this to produce membership proofs.

```json
{ "results": [ { "commitment": "0x…", "leafIndex": 0 }, … ] }
```

### `GET /notes/encrypted?limit=&offset=`
The public encrypted-note feed. Clients **trial-decrypt** these locally to
discover their own notes; the server learns nothing.

```json
{ "results": [ { "commitment": "0x…", "ciphertext": "0x…", "root": "0x…", "txid": "0x…", "status": "confirmed", "spent": false } ], "limit": 1000, "offset": 0 }
```

### `GET /roots` · `GET /roots/latest`
Historical / current commitment-tree roots observed on chain.

### `GET /fees` · `GET /treasury`
Aggregate protocol fees collected, and the treasury balance.

### `GET /version` · `GET /health`
API/protocol version, and a health check.

## Authenticated (per-wallet)

Used by the SDK to persist and retrieve a wallet's own encrypted notes. Auth is a
sign-in-with-Stacks flow yielding a bearer token.

| Endpoint | Purpose |
|---|---|
| `POST /auth/nonce` | request a nonce + message to sign |
| `POST /auth/verify` | exchange a signature for a session token |
| `POST /auth/logout` | invalidate the session |
| `GET /me` | the authenticated wallet + note count |
| `GET /me/notes` | this wallet's encrypted notes |
| `GET /me/history` | this wallet's operation history |
| `POST /me/notes` | register an encrypted note (`{ commitment, ciphertext }`) |
| `POST /me/notes/{commitment}/spent` | mark a note spent |

The stored payload is always **ciphertext** encrypted to the owner's viewing key
plus public locators — safe at rest, exactly like the public feed.

## Notes

- Amounts in `/stats.byAsset` are **display units** (already divided by the
  asset's decimals).
- The API is an indexer: after an on-chain operation there is a short lag before
  it appears. Clients should tolerate this (the SDK does).
- CORS is enabled for browser clients.
