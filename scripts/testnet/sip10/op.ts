// =============================================================================
// STX Shield -- SIP-10 testnet: per-asset, per-operation test runner
// =============================================================================
//   npx tsx scripts/testnet/sip10/op.ts <sbtc|usdcx> <op> [seed]
//   op ∈ shield | transfer | split | merge | withdraw | lifecycle
//
// Separate, independently-runnable tests for each asset and each operation, each
// SELF-BOOTSTRAPPING the notes it needs (spends require a prior shield):
//   shield     Alice shields          -> pool balance + Alice balance checked
//   transfer   Alice shields -> transfers note to Bob
//   split      Alice shields -> splits into two
//   merge      Alice shields x2 -> merges into one
//   withdraw   Alice shields -> withdraws to Carol   (real token payout checked)
//   lifecycle  shield -> transfer -> split -> merge -> withdraw + double-spend attack
//
// Real asset-bound Noir proofs, real zkVerify Volta aggregation, real tokens.
// Each proof waits for zkVerify aggregation (tunable via SIP10_AGG_TIMEOUT_MS /
// SIP10_AGG_ATTEMPTS). Run one op at a time; e.g. `op.ts sbtc split`.

import { Cl } from "@stacks/transactions";
import { CommitmentTree } from "../../../sdk/merkle-tree/index.js";
import {
  Ctx, Signer, assetIdBig, assetIdHex, commitmentOf, nullifierOf, grumpkinPk, incArgs, tokenArg,
  tokenBalance, shieldedTotal, currentRoot, stacks, stacksExpectAbort, signer, fundStxIfLow, loadAll, openSession,
  registerFastDomain, unregisterFastDomain, doShield, doTransfer, doSplit, doMerge, doWithdraw, hexOf, toBuf,
} from "./lib.js";

// asset config; amounts chosen to satisfy the registered min-shield and to divide
// cleanly for split/merge. sBTC has 8 decimals (unit 1e8), USDCx 6 (unit 1e6).
const ASSETS = {
  sbtc: { envKey: "SBTC_CONTRACT", uid: 1, sym: "sBTC", base: 10_000_000n, a1: 4_000_000n, a2: 6_000_000n }, // 0.1 = 0.04+0.06
  usdcx: { envKey: "USDCX_CONTRACT", uid: 2, sym: "USDCx", base: 5_000_000n, a1: 2_000_000n, a2: 3_000_000n }, // 5 = 2+3
} as const;
type AssetKey = keyof typeof ASSETS;
type Op = "shield" | "transfer" | "split" | "merge" | "withdraw" | "lifecycle";

const main = async (): Promise<number> => {
  const asset = process.argv[2] as AssetKey;
  const op = (process.argv[3] ?? "shield") as Op;
  const seed = BigInt(process.argv[4] ?? Date.now().toString());
  if (!ASSETS[asset] || !["shield", "transfer", "split", "merge", "withdraw", "lifecycle"].includes(op)) {
    console.error("usage: op.ts <sbtc|usdcx> <shield|transfer|split|merge|withdraw|lifecycle> [seed]");
    return 1;
  }
  const cfg = ASSETS[asset];
  const { deployer, deployEnv, testnetEnv, users } = loadAll();
  const token = deployEnv[cfg.envKey];
  if (!token) throw new Error(`.env.deploy missing ${cfg.envKey}`);
  const assetId = assetIdBig(token);

  console.log(`SIP-10 ${cfg.sym} ${op}  (token ${token}, asset ${assetIdHex(token).slice(0, 14)}…)`);
  console.log(`  deployer/relayer ${deployer}  seed ${seed}\n`);

  const alice = await signer(users.ALICE_MNEMONIC!);
  const bob = await signer(users.BOB_MNEMONIC!);
  const carol = await signer(users.CAROL_MNEMONIC!);
  const relay = await signer(deployEnv.NEW_DEPLOYER_MNEMONIC!);

  console.log("[fund] user gas (tSTX) if low...");
  for (const u of [alice.address, bob.address, carol.address]) await fundStxIfLow(relay, u, 1_500_000n, 3_000_000n);

  console.log("[keys] deriving Grumpkin keys...");
  const sk = { alice: (seed % 2n ** 240n) + 1n, bob: ((seed * 3n + 7n) % 2n ** 240n) + 1n, carol: ((seed * 5n + 11n) % 2n ** 240n) + 1n };
  const pk = { alice: grumpkinPk(sk.alice), bob: grumpkinPk(sk.bob), carol: grumpkinPk(sk.carol) };

  const { session, zk } = await openSession(testnetEnv);
  const domainId = await registerFastDomain(session, zk);
  const ctx: Ctx = { deployer, deployEnv, session, zk, relay, domainId, tree: new CommitmentTree(), onChainRoot: await currentRoot(deployer) };

  let ok = false;
  try {
    if (op === "shield") {
      const before = await tokenBalance(token, alice.address), pBefore = await shieldedTotal(deployer, cfg.uid);
      await doShield(ctx, alice, pk.alice, token, assetId, cfg.base, 0);
      const after = await tokenBalance(token, alice.address), pAfter = await shieldedTotal(deployer, cfg.uid);
      ok = before - after === cfg.base && pAfter - pBefore === cfg.base;
      console.log(`  Alice ${cfg.sym} -${before - after}; pool shielded +${pAfter - pBefore} (expect ${cfg.base})`);
    } else if (op === "transfer") {
      const n = await doShield(ctx, alice, pk.alice, token, assetId, cfg.base, 0);
      await doTransfer(ctx, n, sk.alice, pk.bob, token, assetId, 10); // -> Bob, relayed
      ok = true; // success = neither tx aborted (proof + registry accepted the private move)
    } else if (op === "split") {
      const n = await doShield(ctx, alice, pk.alice, token, assetId, cfg.base, 0);
      const [o1, o2] = await doSplit(ctx, n, sk.alice, pk.alice, token, assetId, cfg.a1, cfg.a2, 10);
      ok = o1.amount + o2.amount === n.amount;
      console.log(`  conservation ${n.amount} == ${o1.amount} + ${o2.amount}: ${ok}`);
    } else if (op === "merge") {
      const n1 = await doShield(ctx, alice, pk.alice, token, assetId, cfg.a1, 0);
      const n2 = await doShield(ctx, alice, pk.alice, token, assetId, cfg.a2, 1);
      const m = await doMerge(ctx, n1, n2, sk.alice, pk.alice, token, assetId, 10);
      ok = m.amount === n1.amount + n2.amount;
      console.log(`  conservation ${n1.amount} + ${n2.amount} == ${m.amount}: ${ok}`);
    } else if (op === "withdraw") {
      const before = await tokenBalance(token, carol.address);
      const n = await doShield(ctx, alice, pk.alice, token, assetId, cfg.base, 0);
      await doWithdraw(ctx, n, sk.alice, carol.address, token, assetId); // -> Carol, relayed
      const after = await tokenBalance(token, carol.address);
      ok = after - before === cfg.base; // fee assumed 0; Carol receives full amount
      console.log(`  Carol ${cfg.sym} +${after - before} (expect ${cfg.base})`);
    } else if (op === "lifecycle") {
      ok = await lifecycle(ctx, { alice, bob, carol }, sk, pk, token, assetId, cfg);
    }
    await unregisterFastDomain(session, domainId);
    await session.close().catch(() => {});
  } catch (e) {
    await unregisterFastDomain(session, domainId).catch(() => {});
    await session.close().catch(() => {});
    throw e;
  }

  console.log(`\n${ok ? `*** ${cfg.sym} ${op} PASSED ***` : `*** ${cfg.sym} ${op} FAILED ***`}`);
  return ok ? 0 : 1;
};

// full chain for one asset, mirroring the STX split-merge lifecycle.
const lifecycle = async (ctx: Ctx, u: { alice: Signer; bob: Signer; carol: Signer }, sk: any, pk: any, token: string, assetId: bigint, cfg: (typeof ASSETS)[AssetKey]): Promise<boolean> => {
  const carolBefore = await tokenBalance(token, u.carol.address);
  const n0 = await doShield(ctx, u.alice, pk.alice, token, assetId, cfg.base, 0);                 // user-signed deposit
  const n1 = await doTransfer(ctx, n0, sk.alice, pk.bob, token, assetId, 10);                     // -> Bob, relayed
  const [s1, s2] = await doSplit(ctx, n1, sk.bob, pk.bob, token, assetId, cfg.a1, cfg.a2, 20);    // relayed
  const merged = await doMerge(ctx, s1, s2, sk.bob, pk.bob, token, assetId, 30);                  // relayed, back to base
  const w = await doWithdraw(ctx, merged, sk.bob, u.carol.address, token, assetId);               // -> Carol, relayed
  const carolAfter = await tokenBalance(token, u.carol.address);

  console.log("  [attack] replay spent withdraw nullifier (double-spend)...");
  const atk = await stacksExpectAbort(ctx.relay, ctx.deployer, "sip10-pool", "withdraw",
    [tokenArg(token), Cl.buffer(toBuf(hexOf(w.nf))), Cl.uint(merged.amount), Cl.principal(u.carol.address), Cl.buffer(toBuf(w.root)), ...incArgs(w.inc)]);

  const conservation = s1.amount + s2.amount === n1.amount && merged.amount === s1.amount + s2.amount;
  const paid = carolAfter - carolBefore === cfg.base;
  console.log(`  conservation ${conservation}; Carol +${carolAfter - carolBefore} (expect ${cfg.base}); replay aborted ${atk.aborted}`);
  void nullifierOf; void commitmentOf; void currentRoot; void stacks;
  return conservation && paid && atk.aborted;
};

main().then((c) => process.exit(c)).catch((e) => { console.error("\nop failed:", e instanceof Error ? e.message : e); process.exit(1); });
