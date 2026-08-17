<!-- Thanks for contributing to Stacks Shield! Please read CONTRIBUTING.md first. -->

## What & why

<!-- What does this PR change, and why? Link any related issue: Closes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Docs
- [ ] Refactor / chore

## Component(s)

- [ ] Contracts (`contracts/`)
- [ ] Circuits (`zk/circuits/`)
- [ ] SDK (`sdk/`)
- [ ] Relayer / API (`services/`)
- [ ] Frontend (`frontend/`)
- [ ] Docs

## Checklist

- [ ] I did **not** modify the frozen native STX core (or I explain why below).
- [ ] I did **not** change any cryptographic domain string.
- [ ] No secrets are committed (`.env*`, keys, mnemonics).
- [ ] Tests added/updated, and the relevant suites pass (`pnpm run test:rc` for
      protocol changes; `npx vitest run` in the package I touched).
- [ ] Typecheck passes for changed TS packages (`tsc --noEmit`).
- [ ] Docs updated if behaviour or interfaces changed.

## Notes for reviewers

<!-- Anything reviewers should focus on, trade-offs, follow-ups. -->
