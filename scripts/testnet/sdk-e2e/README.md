# STX Shield — SDK End-to-End Validation Suite

A **reusable** validation suite that drives the entire production stack through
`@stx-shield/sdk` — the SDK is the only interface, exactly as an app developer
uses it. Run it whenever a new protocol version ships.

```
@stx-shield/sdk → API → Relayer → zkVerify → Stacks Testnet → Smart Contracts
```

For each asset (STX, sBTC, USDCx, and any future SIP-10 asset) it runs the
identical lifecycle and records timings + pass/fail:

```
shield → scan(discover) → transfer → split → merge → withdraw
         + replay-protection + value-conservation
```

…then a cross-asset isolation pass, and writes a JSON + markdown report to
`deployments/testnet/`. The suite never selects a pool or circuit — the SDK
routes by asset automatically; that is what is under test.

## Files

| File | Purpose |
|---|---|
| `harness.ts` | reusable core: `validateAssetLifecycle`, `validateCrossAsset`, `Recorder` |
| `report.ts` | report rendering: performance rollup, Definition-of-Done, markdown + JSON |
| `signer.ts` | Node `WalletSigner` (mnemonic-backed; RSV auth signing) |
| `run.ts` | entrypoint — wires the SDK and runs the suite |
| `report.test.ts` | self-test of the suite's own logic (no live services) |

Self-test (proves the harness before pointing it at testnet):
```bash
cd scripts/testnet/sdk-e2e && npx vitest run
```

## Prerequisites for a live run

1. **API + Relayer deployed with SIP-10 support.** The relayer must accept the
   `token` field and publish SIP-10 aggregation roots to `sip10-zk-verifier`;
   the API must index `sip10-*` events and serve `GET /assets`. (Redeploy the
   updated `services/api` + `services/relayer`.)
2. **A funded test wallet** holding STX **and** sBTC **and** USDCx on testnet.
3. **Compiled circuits** under `E2E_CIRCUITS_DIR` (default `zk/circuits`): the
   native `shield/transfer/split/merge/withdraw` and the `sip10/*` family
   (`nargo compile` each). The Node engine proves with bb.js in-process.
4. A **zkVerify submission path**: a hosted submitter (`E2E_ZKVERIFY_ENDPOINT`,
   usually the relayer's `/submit`) or a funded seed (`ZKVERIFY_SEED_PHRASE`).

## Run

```bash
# from the repo root
E2E_RELAYER_URL=https://stx-shield-relayer.onrender.com \
E2E_API_URL=https://stx-shield-api.onrender.com \
E2E_ZKVERIFY_ENDPOINT=https://stx-shield-relayer.onrender.com \
E2E_MNEMONIC="…24 words…" \
npx tsx scripts/testnet/sdk-e2e/run.ts
```

Env (or a `.env*` file the runner reads): `E2E_NETWORK`, `E2E_API_URL`,
`E2E_RELAYER_URL`, `E2E_ZKVERIFY_ENDPOINT` **or** `ZKVERIFY_SEED_PHRASE`,
`E2E_MNEMONIC` (falls back to `ALICE_MNEMONIC` in `.env.users`), `E2E_RECIPIENT`,
`E2E_ASSETS` (default `stx,sbtc,usdcx`), `E2E_CIRCUITS_DIR`.

Output: `deployments/testnet/SDK-E2E-VALIDATION.md` (report) and
`sdk-e2e-report.json` (machine-readable, for CI).

## Notes

- Each shield is user-signed and waited to confirmation before spends, so the
  commitment is on chain for membership. zkVerify aggregation latency is the
  usual long pole and is captured in the performance summary.
- The deeper cross-asset guarantee — a proof for asset A cannot spend asset B on
  chain — is enforced by the circuits/contracts and is separately proven by
  `tests/integration/sip10.test.ts` and `scripts/testnet/sip10/op.ts`. This SDK
  suite verifies the SDK-level guardrails (asset tagging, cross-asset merge
  rejection) and the full happy-path lifecycle per asset.
