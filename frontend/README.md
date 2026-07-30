# STX Shield — Web App

The official STX Shield frontend: a privacy wallet for STX. Shield, transfer,
split, merge and withdraw STX with zero-knowledge proofs — no cryptography to
learn.

A **React SPA** (client-rendered, no SSR). All protocol interaction goes through
the `@stx-shield/sdk`; the app never talks to contracts, relayers or zkVerify
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
| Protocol     | @stx-shield/sdk                               |

## Structure

```text
src/
├── app/          # entry: main, App, router (code-based routes), providers
├── features/     # one folder per domain: wallet, dashboard, shield, notes,
│                 #   transfer, split, merge, withdraw, activity, explorer, settings
├── shared/       # components (ui + shared), layouts, hooks, types, constants, utils
├── services/     # sdk/ (ShieldService singleton + wallet signer)
├── store/        # zustand: wallet, theme, notifications, ui
├── lib/          # query-client, env, cn
└── styles/       # globals.css (design tokens)
```

- **`services/sdk/shield.service.ts`** — a singleton (`ShieldService.getInstance()`)
  wrapping `@stx-shield/sdk`. There is exactly one long-lived SDK instance per
  session; note/tree state lives in it, so it is never recreated per action.
- **Routing** is code-based in `app/router.tsx`: a public `/` landing route and a
  pathless `AppShell` layout wrapping the in-app routes (`/dashboard`, `/shield`,
  `/notes`, `/transfer`, `/split`, `/merge`, `/withdraw`, `/activity`,
  `/explorer`, `/settings`). Every page is lazy-loaded (code-split).

## Getting started

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm build      # tsc --noEmit && vite build
pnpm preview
pnpm lint
```

## Environment

All values default to the live testnet deployment, so the app runs with zero
config. Override via a `.env` file:

```bash
VITE_API_URL=https://stx-shield-api.onrender.com
VITE_RELAYER_URL=https://stx-shield-relayer.onrender.com
VITE_ZKVERIFY_URL=           # hosted zkVerify submitter (see below)
VITE_NETWORK=testnet
```

## Proving & zkVerify (to enable private operations)

Read-only stats and wallet connection work out of the box. To generate proofs
and run private operations, two things are needed:

1. **The SDK** — install the workspace package `@stx-shield/sdk` (and the
   optional prover peers `@aztec/bb.js`, `@noir-lang/noir_js`, `zkverifyjs`).
   Until then, operations fail loudly with `SDKUnavailableError` and only public
   stats are shown.
2. **Circuit artifacts** — host the compiled circuit JSON at `/circuits/*.json`.
3. **A zkVerify submitter** — set `VITE_ZKVERIFY_URL` to a hosted submitter
   endpoint. Do not ship a zkVerify seed in the browser.

WASM proving uses threads, which require cross-origin isolation. The dev/preview
servers already send `COOP: same-origin` / `COEP: require-corp`; set the same
headers in production.

See the repo-root `frontendguide.md` for the full SDK surface and flow-by-flow
integration details.
