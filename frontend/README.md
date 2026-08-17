# Stacks Shield — Web App

The official Stacks Shield frontend: a privacy wallet for **STX and SIP-10 tokens
(sBTC, USDCx)**. Shield, transfer, split, merge and withdraw with zero-knowledge
proofs — no cryptography to learn.

A **React SPA** (client-rendered, no SSR). All protocol interaction goes through
`@stacks-shield/sdk`; the app never talks to contracts, relayers or zkVerify
directly.

## Stack

| Concern      | Choice                                        |
| ------------ | --------------------------------------------- |
| Framework    | React 19 + Vite                               |
| Routing      | TanStack Router (code-based, lazy, type-safe) |
| Server state | TanStack Query                                |
| Client state | Zustand                                       |
| Styling      | Tailwind CSS v4 + shadcn/ui                   |
| Motion       | Framer Motion                                 |
| Wallet       | @stacks/connect                               |
| Protocol     | @stacks-shield/sdk                            |

## Structure

```text
src/
├── app/          # entry: main, App, router (code-based routes), providers
├── features/     # one folder per domain: wallet, dashboard, shield, notes,
│                 #   transfer, split, merge, withdraw, activity, explorer,
│                 #   settings, faucet, guide, assets, legal
├── shared/       # components (ui + shared), layouts, hooks, types, constants, utils
├── services/     # sdk/ (ShieldService singleton + wallet signer)
├── store/        # zustand: wallet, theme, notifications, ui
├── lib/          # query-client, env, cn
└── styles/       # globals.css (design tokens)
```

- **`services/sdk/shield.service.ts`** — a singleton (`ShieldService.getInstance()`)
  wrapping `@stacks-shield/sdk`, with a per-wallet `localStorageVault()` for local
  note durability. Exactly one long-lived SDK instance per session; note/tree
  state lives in it, so it is never recreated per action.
- **Multi-asset** — the shield page has an asset selector; every page denominates
  each note in its own asset (STX/USDCx 6dp, sBTC 8dp) and shows live USD.
  Supported assets are discovered from the API's `/assets` — no hardcoding.
- **Routing** is code-based in `app/router.tsx`: public `/`, `/terms`, `/privacy`
  routes, and a pathless `AppShell` layout wrapping the in-app routes
  (`/dashboard`, `/shield`, `/notes`, `/transfer`, `/split`, `/merge`,
  `/withdraw`, `/activity`, `/explorer`, `/settings`, `/faucet`, `/guide`). Every
  page is lazy-loaded (code-split).

## Getting started

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm build      # tsc --noEmit && vite build
pnpm preview
```

## Environment

Defaults point at the live testnet deployment, so the app runs with zero config.
Override via `.env.local` (gitignored) — see [`.env.local.example`](.env.local.example):

```bash
VITE_API_URL=https://stx-shield-api.onrender.com   # must be a SIP-10-aware API (serves /assets)
VITE_RELAYER_URL=http://localhost:8787
VITE_ZKVERIFY_URL=http://localhost:8787            # hosted zkVerify submitter
VITE_NETWORK=testnet
VITE_FAUCET_API_KEY=                                # required for the testnet faucet; never committed
```

> Vite reads `.env*` **only at startup** — restart the dev server after changes.
> If the app looks STX-only, the API it points at doesn't serve `/assets` (old
> build); point `VITE_API_URL` at a SIP-10-aware API and restart.

## Proving & zkVerify

Read-only stats and wallet connection work out of the box. Private operations
need:

1. **Circuit artifacts** — compiled circuit JSON at `public/circuits/*.json`
   (STX `shield/transfer/split/merge/withdraw.json` **and** the SIP-10 variants
   `sip10-*.json`).
2. **A zkVerify submitter** — set `VITE_ZKVERIFY_URL` to a hosted submitter
   endpoint. Never ship a zkVerify seed in the browser.

WASM proving uses threads, which require cross-origin isolation. The dev/preview
servers already send `COOP: same-origin` / `COEP: require-corp`; set the same
headers in production.

## Docs

Protocol and integration docs live at the repo root: [`../docs/`](../docs/README.md)
(whitepaper, architecture, privacy model, security) and the
[`@stacks-shield/sdk` README](../sdk/README.md).
