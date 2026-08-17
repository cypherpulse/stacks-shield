# Contributing to Stacks Shield

Thanks for your interest in contributing! Stacks Shield is a privacy protocol for
Stacks — Clarity contracts, Noir/UltraHonk circuits, a TypeScript SDK, backend
services, and a React frontend. This guide covers how to get set up and land a
change.

New here? Start with the [README](README.md), the
[whitepaper](docs/whitepaper.md), and the [architecture](docs/architecture.md).

## Ways to contribute

- **Bugs & fixes** — open an issue (use the bug template), or send a PR.
- **Features & ideas** — open a discussion/issue first so we can align on design.
- **Docs** — corrections and clarifications are always welcome.
- **Security** — do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## Ground rules

- **Never touch the frozen native STX protocol** (the 6 core contracts) or its
  circuits without an explicit, discussed reason — its behaviour is intentionally
  immutable. Multi-asset and new work go in the additive SIP-10 layer or above.
- **Never change cryptographic domain strings** (e.g. the note-key derivation
  message). Changing them silently breaks every existing user's notes.
- **Never commit secrets.** `.env*`, mnemonics, and key files are gitignored —
  keep it that way.
- Keep changes focused; match the style and comment density of the code around
  you.

## Getting set up

Full instructions: [`docs/getting-started.md`](docs/getting-started.md). In short:

```bash
pnpm install
pnpm test        # Clarity contract suites (Clarinet simnet)
```

Prerequisites: Node 20+, `pnpm` 10, [Clarinet](https://docs.hiro.so/clarinet)
(contracts), Noir/`nargo` + Barretenberg (circuits), and Postgres + Redis if you
run the services.

## Development workflow

1. **Fork & branch** off `main` (`feat/…`, `fix/…`, `docs/…`).
2. **Make the change** with tests.
3. **Run the relevant suites** (see below) — they must pass.
4. **Typecheck**: `pnpm --filter ./frontend exec tsc --noEmit`, and
   `npx tsc --noEmit` in `sdk/` and `services/*` you touched.
5. **Open a PR** using the template; describe what and why, link the issue.

## Tests

| Command | Scope |
|---|---|
| `pnpm test` | Clarity contract unit tests (simnet) |
| `pnpm run test:attacks` | adversarial contract tests |
| `pnpm run test:fuzz` | fuzz tests |
| `pnpm run test:e2e` | end-to-end lifecycle |
| `pnpm run test:integration` | cross-component integration |
| `pnpm run test:privacy` | privacy properties |
| `pnpm run test:relayer` | relayer service |
| `pnpm run test:rc` | everything (release candidate) |

SDK tests: `cd sdk && npx vitest run`. API tests: `cd services/api && npx vitest run`.

**A PR that changes contracts, circuits, the SDK, or services must include or
update tests**, and `pnpm run test:rc` should pass.

## Commit & PR style

- Conventional-commit subjects: `feat(sip10): …`, `fix(sdk): …`, `docs: …`.
- Small, reviewable PRs. Explain the reasoning, not just the diff.
- Update docs when behaviour or interfaces change.

## Project layout

See [architecture](docs/architecture.md) for the map. Quick reference:
`contracts/` (Clarity), `zk/circuits/` (Noir), `sdk/`, `services/api`,
`services/relayer`, `frontend/`, `scripts/`, `docs/`.

## License

By contributing you agree your contributions are licensed under the repository's
[Apache-2.0 License](LICENSE).
