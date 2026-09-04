# Stacks Shield v2, Testnet Deployment & Relayer Runbook

This document records the **v2 relaunch** on Stacks testnet: the source and
tooling changes, the fresh deployment under a new deployer wallet, and the
dedicated relayer setup, with every command, in order.

> **v2 in one line:** every leaf-adding circuit now binds the Merkle-tree
> transition (`new_root` + `leaf_index`) into the proof, and each pool asserts
> the registry-assigned slot equals the proof-bound `leaf_index`. Because the
> tree transition is now part of the statement, the whole family moves to
> `circuit_version = 2`. Since nothing existed under the new wallet, the fix was
> applied **in place** and deployed fresh, no `-v2` contract names.

---

## 1. Deployment identity

| | Value |
|---|---|
| **v2 deployer** | `ST18XMPE0PS5VNEEKB82BPW7NRZRHXEPH16JK8NN6` |
| Previous (abandoned) deployer | `ST2HXRZ8A82JJAP14KD83JEXNRCF34J67088WJSJH` |
| Network | Stacks testnet |
| Circuit version | `2` (both native STX and SIP-10 families) |
| Genesis (empty-tree) root | `0x2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3e` |

All contracts are deployed under the v2 deployer; addresses/txids are recorded in
`deployments/testnet/addresses.json` and `deployments/testnet/contracts.json`.

**Deployed contracts** (all `ST18XMPE….<name>`):

- STX core: `privacy-registry`, `note-manager`, `protocol-fees`, `zk-verifier`, `privacy-pool`, `split-merge-manager`
- SIP-10: `sip-010-trait`, `asset-registry`, `sip10-protocol-fees`, `sip10-zk-verifier`, `sip10-pool`

---

## 2. Source changes

### Circuits (`zk/circuits/`)

Both families gained the same insertion-binding primitives and moved to v2.

| File | Change |
|---|---|
| `lib/src/lib.nr`, `sip10/lib/src/lib.nr` | Added `compute_merkle_root`, `EMPTY_LEAF`, `assert_insertion`, `assert_index_bits`; refactored `assert_merkle_membership` to reuse `compute_merkle_root`; added round-trip `#[test]`s |
| `shield`, `transfer`, `merge` (each family) | Public inputs gain `new_root` + `leaf_index`; witness gains `insertion_index_bits` + `insertion_siblings`; assert index + single append. shield also binds `old_root`. `circuit_version == 2` |
| `split` (each family) | Two sequential appends via an intermediate root (`leaf_index`, `leaf_index+1`) |
| `withdraw` (each family) | `circuit_version == 2` only (adds no leaf) |

### Contracts (`contracts/`)

| File | Change |
|---|---|
| `privacy-registry.clar` | Genesis `CIRCUIT-VERSION u1 → u2` (so `get-circuit-version` returns 2) |
| `privacy-pool.clar` | `shield` + `transfer` take `(leaf-index uint)`; fold `new-root` + `leaf-index` into the inputs-hash in circuit order; assert registry slot == proof-bound index (`ERR-LEAF-INDEX-MISMATCH u258`). **L-1:** `withdraw` now rejects `.protocol-fees` as recipient. **D-1:** canonical-encoding comment corrected |
| `split-merge-manager.clar` | `split-note` + `merge-notes` take `(leaf-index uint)`; same inputs-hash + slot assertions (split asserts both `leaf-1 == idx`, `leaf-2 == idx+1`); `ERR-LEAF-INDEX-MISMATCH u358` |
| `sip10-pool.clar` | `shield`/`transfer`/`split`/`merge-notes` take `(leaf-index uint)`; same folding + assertions; `SIP10-CIRCUIT-VERSION u2`; `ERR-LEAF-INDEX-MISMATCH u465` |

### SDK (`sdk/`)

| File | Change |
|---|---|
| `merkle-tree/index.ts` | `insertionWitness(commitment)` → `{ index, indexBits, siblings, oldRoot, newRoot }` (non-mutating) |
| `src/proving/engine.ts` | New `InsertionWitness` type; added `insertion` to shield/transfer/merge witnesses, `insertion1`+`insertion2` to split |
| `src/proving/bbjs.ts` | Emits `new_root`/`leaf_index`/insertion witness for **both** families; `circuit_version` always `"2"`; shield binds `old_root`; only `asset_id` differs per family |
| `src/client/STXShield.ts` | `insertionFor()` builds the witness from the live tree; every op threads it into the proof + pool call; `leafIndexParam` passes the proof-bound index (native + SIP-10) |

### Relayer (`services/relayer/`)

| File | Change |
|---|---|
| `types/index.ts` | Optional `leafIndex` on transfer/split/merge request schemas |
| `transaction-manager/index.ts` | `leafIndexArg()` inserts `Cl.uint(leafIndex)` after `new-root` for all leaf-adding ops (both families); withdraw adds none |

Tests: SDK 41/41 and relayer 25/25 pass; both `tsc` clean.

---

## 3. New / changed deployment tooling (`scripts/deployment/`)

| Script | Purpose |
|---|---|
| `new-wallet.ts` | **New.** Mints the fresh 24-word deployer wallet, scaffolds `.env.v2.deploy` (mode 600) |
| `gen-relayers.ts` | **New.** Mints N relayer wallets (default 3): address + private key + mnemonic |
| `set-relayers.ts` | **New.** Seats `RELAYER_ADDRESSES` on both verifiers, removes `RELAYER_REMOVE` + the deployer; `--status` for a read-only report. Idempotent (checks `get-relayer` before every write) |
| `sip10/generate-vkeys.ts` | Extended to cover **both** families; reads `.env.v2.deploy`; overwrites stale `target/vk`; prints a paste-ready env block. (Raw `bb write_vk` is not used.) |
| `deploy-fresh.ts` | Reads `.env.v2.deploy`; **requires** the v2 vkey hashes from env (no hardcoded v1 fallback); aborts if the derived address ≠ `NEW_DEPLOYER_ADDRESS` |
| `config.ts` | `loadEnv` targets `.env.v2.deploy`; `resolveDeployerMnemonic` prefers `NEW_DEPLOYER_MNEMONIC`; new `STX_CIRCUIT_VERSION = 2` |
| `wire-contracts.ts` | Registers STX vkeys at `STX_CIRCUIT_VERSION` (2) |
| `sip10/lib.ts` | `SIP10_CIRCUIT_VERSION = 2`; reads `.env.v2.deploy` |
| `sip10/configure-sip10.ts` | Added step: `set-circuit-version 2` on the SIP-10 verifier |
| `deploy-all.ts`, `deploy-*.ts`, `testnet-validation.ts` | Default to `.env.v2.deploy` (override with `DEPLOY_ENV_FILE`) |
| `.env.v2.deploy.example` | **New.** Single template driving both deploys (genesis root prefilled; all vkey/asset/relayer vars documented) |

---

## 4. Step-by-step runbook (commands, in order)

Run from the repo root; circuit steps run in WSL.

```bash
# 0. New deployer wallet → scaffolds .env.v2.deploy, prints the address.
#    Fund that address at https://explorer.hiro.so/sandbox/faucet?chain=testnet
npx tsx scripts/deployment/new-wallet.ts

# 1. Compile all 10 circuits (WSL). Do NOT use `bb write_vk`, step 2 handles vks.
for d in shield transfer withdraw split merge \
         sip10/shield sip10/transfer sip10/withdraw sip10/split sip10/merge; do
  ( cd zk/circuits/$d && nargo test && nargo compile )
done

# 2. Generate + register verification keys (both families), then paste the
#    printed block into .env.v2.deploy. --register needs a funded zkVerify Volta
#    account (ZKVERIFY_SEED_PHRASE); omit it for offline VK_HASH values only.
npx tsx scripts/deployment/sip10/generate-vkeys.ts --register

# 3. Deploy the STX core under the new wallet (deploys + wires + zkVerify bindings)
npx tsx scripts/deployment/deploy-fresh.ts

# 4. Deploy + configure the SIP-10 stack (authorize + vkeys + assets + set-circuit-version 2)
npx tsx scripts/deployment/sip10/deploy-sip10.ts
npx tsx scripts/deployment/sip10/configure-sip10.ts

# 5. Mint 3 dedicated relayer wallets. Fund each address, then paste the printed
#    RELAYER_ADDRESSES=.. and RELAYER_DROP_DEPLOYER=true into .env.v2.deploy
npx tsx scripts/deployment/gen-relayers.ts

# 6. Seat the 3 relayers on BOTH verifiers and drop the deployer
npx tsx scripts/deployment/set-relayers.ts

# (diagnostic) read-only membership + count report
npx tsx scripts/deployment/set-relayers.ts --status
```

### `.env.v2.deploy` keys

- Wallet: `NEW_DEPLOYER_MNEMONIC`, `NEW_DEPLOYER_ADDRESS`
- Network: `STACKS_API_URL`, `CORE_API_URL`
- Genesis / fees: `GENESIS_ROOT`, `SHIELD_FEE_BPS`, `TRANSFER_FEE_FLAT`, `WITHDRAW_FEE_BPS`, `TREASURY_ADDRESS`, `FEE_RECIPIENT`
- vkeys (from `generate-vkeys.ts`): `ZKVERIFY_CONTEXT_HASH`; native `VKEY_HASH_*`, `PROOF_LEN_*`, `STX_ZKV_VKEY_HASH_*`, `STX_VERSION_HASH`; SIP-10 `*_VK_HASH`, `*_ZKV_VKEY_HASH`, `*_VERSION_HASH`
- zkVerify: `ZKVERIFY_ENDPOINT`, `ZKVERIFY_SEED_PHRASE`, `ZKVERIFY_DOMAIN_ID`
- Assets: `SBTC_CONTRACT`, `SBTC_DECIMALS`, `USDCX_CONTRACT`, `USDCX_DECIMALS`
- Relayers: `RELAYER_ADDRESSES`, `RELAYER_DROP_DEPLOYER`, `RELAYER_REMOVE`

> `AGGREGATION_RELAYER` / `RELAYER_ADDRESS` are read **only** by the one-time
> wire/configure step. After deploy they are inert, the live relayer set is
> controlled entirely by `set-relayers.ts` + `RELAYER_ADDRESSES`.

---

## 5. Relayer configuration (result)

Three dedicated relayers, seated on **both** `zk-verifier` and `sip10-zk-verifier`;
the deployer is **not** a relayer.

| Relayer | Address |
|---|---|
| 1 | `ST120ECJ9VVNVW26SY4YK9F6TJJ8TXSSFRX08RQX9` |
| 2 | `STZ9SND2H7P1355MMEFV0AB0EQAB7F82PRBKRG3G` |
| 3 | `ST2HGFJKTAFCYR7EQN05MWWR8VHMTH59GVXXCAH1R` |

Removed leftovers seeded at setup time: `STGDS0Y17973EN5TCHNHGJJ9B31XWQ5YXBQ0KQ2Y`
(from `zk-verifier`), `ST2D071WKZFS36FTCAHZ7Z186DRZPGFVD0MPBQS1F` (from
`sip10-zk-verifier`). Final `get-relayer-count` on each verifier: **`u3`**.

**What a relayer does:** the seated address is the only party that can call
`submit-aggregation`, i.e. publish zkVerify aggregation roots on-chain so
`verify-proof` can confirm a proof's public-inputs leaf is included under a
published root. It is a **liveness** role only: it cannot forge a root, nor
approve/reject/alter any user operation. Several relayers give redundancy (any
one can publish). Each seated address must be **funded** (it pays the
`submit-aggregation` gas). *Note: publishing is currently any-one-of-N, not M-of-N
consensus.*

**Still to do for relayers:** fund the 3 addresses; run one `services/relayer`
per wallet (each with its own `RELAYER_PRIVATE_KEY`); expose their URLs to the SDK
/ frontend via `STX_SHIELD_RELAYERS=r1=…,r2=…,r3=…`.

---

## 6. Access control reference

All authority derives from `privacy-registry`: the **owner** (currently the
deployer, since ownership defaults to the deploying account) plus role grants
(`has-role`).

| Action | Contract | Allowed caller |
|---|---|---|
| `register-asset`, `set-asset-enabled`, `set-asset-status`, `set-asset-limits` | `asset-registry` | protocol-admin (owner or role `u1`) |
| `set-asset-fee-config`, `set-asset-fee-recipient` | `asset-registry` | fee-admin (owner or role `u4`) |
| `add-relayer` / `remove-relayer` | `zk-verifier`, `sip10-zk-verifier` | verifier admin (owner) |
| `withdraw-fees(token, amount)` | `sip10-protocol-fees` | registry owner, pays the asset's configured `fee-recipient` (not the caller) |
| `withdraw-fees(amount, recipient)` | `protocol-fees` (STX) | registry owner, recipient is caller-chosen (any non-burn) |
| `collect-fee` | both fee contracts | the pool contracts only |
| freeze/unfreeze fees + treasury | both fee contracts | emergency-admin (owner or emergency-admin role) |

To delegate without sharing the deployer key: grant `PROTOCOL-ADMIN` (`u1`) /
`FEE-ADMIN` (`u4`) roles in `privacy-registry`, and (before mainnet) transfer
registry ownership to a multisig.

---

## 7. Outstanding / next

1. ~~Repoint clients to `ST18XMPE…`~~ **DONE.** SDK, frontend, scripts, examples,
   `sdk/_diag.mts`, and the service `.env.*.example` templates now target v2; the
   docs (README, whitepaper) list v1 + v2 with the v2 change described. SDK
   typechecks + 41/41 tests pass.
2. **Fund the 3 relayers + run their services**; set `STX_SHIELD_RELAYERS`.
3. **Prove the fix + live end-to-end.**
   - *Proof-of-fix (circuit level):* `nargo test` in `zk/circuits/lib` and
     `zk/circuits/sip10/lib`, the `should_fail` tests confirm a forged `new_root`
     and a mismatched `leaf_index` cannot produce a valid proof.
   - ✅ *Live STX e2e PASSED (real testnet):* `scripts/testnet/sdk-e2e/run.ts`
     `E2E_ASSETS=stx`, all 15 checks green (shield→transfer→split→merge→withdraw
     with real UltraHonk proofs; public-input arities 8/8/10/9/6 confirm v2), plus
     replay-protection + value-conservation. This is the definitive on-chain
     proof-of-fix.
   - Command used: `E2E_API_URL=http://localhost:8888 E2E_RELAYER_URL=http://localhost:8787
     E2E_ZKVERIFY_ENDPOINT=http://localhost:8787 E2E_ASSETS=stx npx tsx scripts/testnet/sdk-e2e/run.ts`
     (`E2E_ZKVERIFY_ENDPOINT` is the relayer BASE url, the SDK appends `/submit`).
   - ✅ *Live SIP-10 e2e PASSED (real testnet):* `E2E_ASSETS=sbtc,usdcx`, both
     assets 15/15 (arities 9/9/11/10/7 confirm SIP-10 v2) + cross-asset isolation.
     All three assets (STX/sBTC/USDCx) now validated end-to-end with real proofs.
     Note: per-asset shield limits are enforced (an out-of-range amount returns
     `u456`); keep e2e amounts within each asset's registered `[min,max]` (sBTC max
     is 1000 sBTC).
   - **Gotchas hit + fixed (for next time):** (a) local relayer needs
     `ZKVERIFY_USE_API=false` (read-only RPC → `-32053`/500 on `/submit`); (b) the
     API DB must be FRESH for a v2 relaunch, stale v1 commitments make the SDK
     prove against the wrong tree → on-chain `u310`. Point the API at a new v2
     database and run `pnpm db:push` + `pnpm db:migrate:sip10`.
4. ~~Refresh the Clarinet contract test suites to the v2 ABI~~ **DONE.** Updated the
   shared harnesses (`tests/helpers/protocol.ts`, `sip10-protocol.ts`, `attestation.ts`),
   the canonical encodings (`sdk/public-inputs/index.ts` + `sip10.ts`), and the per-file
   unit tests to thread `leaf-index` + the tree transition and to register/verify at
   circuit-version 2. **Root suite 475/475 (29 files), SDK 41/41, relayer 25/25, tsc clean.**
5. **Publish the v2 SDK** (npm beta) once the above are green.
6. **External audit** before any mainnet move.
