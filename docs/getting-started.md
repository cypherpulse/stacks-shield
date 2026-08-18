# Getting started

Set up Stacks Shield locally — run the contract tests, and (optionally) the
services and frontend. For how the pieces fit together see
[architecture](architecture.md).

## Prerequisites

| Tool | For | Notes |
|---|---|---|
| **Node 20+** and **pnpm 10** | everything | `corepack enable` then `pnpm -v` (repo pins `pnpm@10`) |
| **[Clarinet](https://docs.hiro.so/clarinet)** | Clarity contracts + tests | runs the simnet the test suites use |
| **Noir (`nargo`) + Barretenberg (`bb`)** | circuits | only if you recompile/prove circuits |
| **PostgreSQL** | the API + indexer | only to run `services/api` |
| **Redis** | the relayer | only to run `services/relayer` (BullMQ) |

You can do a lot with just Node + pnpm + Clarinet — the contract test suites need
nothing else.

## Install

```bash
git clone <your-fork-url> stacks-shield && cd stacks-shield
pnpm install
```

## Run the contract tests

```bash
pnpm test            # Clarity contract unit tests (Clarinet simnet)
pnpm run test:rc     # everything: contracts + attacks + fuzz + e2e + integration + privacy
```

Targeted suites: `test:pool`, `test:registry`, `test:notes`, `test:fees`,
`test:verifier`, `test:split-merge`, `test:attacks`, `test:fuzz`, `test:e2e`,
`test:privacy`, `test:relayer`. See all in [`package.json`](../package.json).

## SDK

```bash
cd sdk
npx vitest run       # SDK unit tests
npx tsup             # build dist (index / node / web)
```

Usage:

```ts
import { STXShield, localStorageVault } from "@stacks-shield/sdk";

const shield = new STXShield({ network: "testnet", signer, noteVault: localStorageVault() });
await shield.shield(100);              // STX
await shield.shield(1000, "USDCx");    // SIP-10 by symbol
await shield.transfer(50, recipient, "USDCx");
```

More: [`sdk/README.md`](../sdk/README.md).

## Services (optional)

Both read config from a local `.env` (see each service directory for the
required variables — never commit secrets).

```bash
# API + indexer (needs PostgreSQL)
cd services/api && npx tsx scripts/migrate.ts   # set up the schema
# for a SIP-10-enabled DB, also run the SIP-10 migration + reset the indexer:
#   npx tsx scripts/migrate-sip10.ts
#   npx tsx scripts/reset-indexer.ts

# Relayer (needs Redis)
pnpm relayer
```

Run the frontend + relayer together in dev:

```bash
pnpm run dev:app     # frontend + relayer in parallel
```

## Frontend (optional)

```bash
cd frontend
pnpm dev             # Vite dev server
```

Configure `VITE_API_URL` / `VITE_RELAYER_URL` in `frontend/.env.local` to point
at your API/relayer. The compiled circuit artifacts live in
`frontend/public/circuits/` (STX + `sip10-*.json`). Vite reads `.env*` **only at
startup**, so restart the dev server after changing env.

## Deployment (maintainers)

Deploying the protocol needs the deployer key in `.env.deploy` (gitignored) and
is **not** required for development.

```bash
pnpm run deploy:testnet    # deploy STX core
pnpm run wire:testnet      # wire contracts together
pnpm run verify:testnet    # verify the deployment
```

SIP-10 extension deployment uses the scripts in
[`scripts/deployment/sip10/`](../scripts/deployment/sip10) (deploy → configure →
register-assets → verify).

## Troubleshooting

- **"note commitment not on chain yet" / balances show 0** — the indexer is
  behind or a migration wasn't applied. For a SIP-10 DB run `migrate-sip10` then
  `reset-indexer`, and confirm the API is caught up to the chain tip.
- **Vite: "does not provide an export …"** — stale dep cache after an SDK rebuild:
  `rm -rf frontend/node_modules/.vite` and restart.
- **Frontend looks STX-only** — the API it points at doesn't serve `/assets`
  (old build). Point `VITE_API_URL` at a SIP-10-enabled API and restart.
