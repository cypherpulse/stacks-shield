// =============================================================================
// set-sip10-fees.ts -- turn on protocol fees for the SIP-10 assets
// =============================================================================
//   npx tsx scripts/deployment/sip10/set-sip10-fees.ts
//
// Configures per-asset fees for USDCx + sBTC by calling
// `asset-registry.set-asset-fee-config` (fee-admin only — the deployer from
// .env.deploy). Defaults MIRROR the live native STX protocol.
//
// WHY THESE DEFAULTS — how the native STX protocol charges (protocol-fees.clar,
// verified live): SHIELD 25 bps, WITHDRAWAL 30 bps, TRANSFER/SPLIT/MERGE flat
// 0.01 STX. The meaningful, value-scaled fees are on SHIELD + WITHDRAWAL and are
// paid by the USER directly; the reshaping ops carry only a tiny flat.
//
// HOW A FEE-TYPE PICKS bps vs flat (from sip10-pool.clar):
//   • SHIELD     -> calculate-fee(asset, SHIELD, amount): fee = flat + amount*bps/10000.
//                   Percentage works; paid by the user on deposit (user -> fee manager).
//   • WITHDRAWAL -> calculate-fee(asset, WITHDRAWAL, amount): percentage; taken OUT
//                   of the withdrawn amount by the pool (as-contract), fee < amount.
//   • TRANSFER/SPLIT/MERGE -> calculate-fee(asset, type, u0): amount is ZERO, so bps
//                   is ALWAYS ignored — only the `flat` fee applies, and it is paid
//                   by the tx-sender = the RELAYER for shielded ops. So a NON-ZERO
//                   flat here requires the relayer to HOLD that token (and recoup off
//                   chain), or the op reverts. Default 0 to avoid that; percentage
//                   fees on shield+withdrawal are the clean, user-paid model.
//
// A percentage naturally scales across assets (100 USDCx vs 0.5 sBTC); a fixed
// flat cannot (0.01 STX is fine, 0.01 sBTC would be ~$630), which is the other
// reason the real fees live on shield/withdrawal as bps.
//
// Ceiling: bps <= privacy-registry.get-max-fee-bps (testnet default 100 = 1%);
// flat <= the asset's max-shield. Both are asserted on chain too.
//
// Tunables (edit here or override via .env.deploy):
//   FEE_SHIELD_BPS     shield fee in basis points       (default 25 = 0.25%)
//   FEE_WITHDRAW_BPS   withdrawal fee in basis points   (default 30 = 0.30%)
//   FEE_FLAT_TOKENS    flat fee for transfer/split/merge, in WHOLE tokens, paid by
//                      the relayer (default 0 = off; set >0 only after funding the
//                      relayer with the token). Scaled per asset decimals.

import { cvToJSON, hexToCV, cvToHex } from "@stacks/transactions";
import { ASSET_REGISTRY, REGISTRY, Cl, asContract, env, getDeployer, isEntrypoint, requireEnvVars } from "./lib.js";
import { assetSpecs, assetEnvKeys } from "./register-assets.js";
import type { Deployer } from "../deployer.js";

// Fee types — mirror asset-registry / sip10-protocol-fees.
const FEE_TYPES = { SHIELD: 1, TRANSFER: 2, WITHDRAWAL: 3, SPLIT: 4, MERGE: 5 } as const;

const numEnv = (e: Record<string, string>, k: string, dflt: number): number =>
  e[k] && e[k]!.trim() !== "" ? Number(e[k]) : dflt;

/** Resolve an asset's registry uid from its token principal (throws if absent). */
async function resolveAssetId(d: Deployer, principal: string): Promise<number> {
  const r = await d.readOnly(asContract(ASSET_REGISTRY), "get-asset-id-by-principal", [cvToHex(Cl.principal(principal))]);
  if (!r.okay || !r.result) throw new Error(`get-asset-id-by-principal(${principal}) failed: ${r.cause ?? "no result"}`);
  const j = cvToJSON(hexToCV(r.result)) as { value?: { value?: string } };
  const uid = j.value?.value; // (optional uint) -> .value.value
  if (uid == null) throw new Error(`asset ${principal} is not registered in asset-registry`);
  return Number(uid);
}

export async function setSip10Fees(deployer: Deployer, e: Record<string, string>): Promise<void> {
  requireEnvVars(e, assetEnvKeys);
  const AR = asContract(ASSET_REGISTRY);

  const shieldBps = numEnv(e, "FEE_SHIELD_BPS", 25);
  const withdrawBps = numEnv(e, "FEE_WITHDRAW_BPS", 30);
  const flatTokens = numEnv(e, "FEE_FLAT_TOKENS", 0); // 0 = no relayer-paid flat fee

  // Validate the bps values against the live registry ceiling BEFORE any tx.
  const ceilRes = await deployer.readOnly(asContract(REGISTRY), "get-max-fee-bps");
  const maxBps = ceilRes.okay && ceilRes.result ? Number((cvToJSON(hexToCV(ceilRes.result)) as { value?: string }).value) : 100;
  for (const [name, bps] of [["FEE_SHIELD_BPS", shieldBps], ["FEE_WITHDRAW_BPS", withdrawBps]] as const) {
    if (bps > maxBps) throw new Error(`${name}=${bps} exceeds the registry ceiling (${maxBps}). Lower it or raise the ceiling first.`);
  }

  console.log(
    `Setting SIP-10 fees (mirrors native STX) — shield ${shieldBps} bps, withdrawal ${withdrawBps} bps, ` +
      `flat ${flatTokens} token(s) on transfer/split/merge (ceiling ${maxBps} bps)\n`,
  );

  for (const a of assetSpecs(e)) {
    let uid: number;
    try {
      uid = await resolveAssetId(deployer, a.contract);
    } catch (err) {
      console.log(`· ${a.name} (${a.contract}): ${err instanceof Error ? err.message : err} — skipping`);
      continue;
    }
    const flat = Math.round(flatTokens * 10 ** a.decimals); // per-asset base units
    if (flat > a.maxShield) throw new Error(`${a.name}: flat fee ${flat} exceeds max-shield ${a.maxShield}`);

    // fee-type -> { bps, flat }. Shield + withdrawal are percentage (user-paid);
    // transfer/split/merge are flat-only (relayer-paid, default 0).
    const plan: Array<[keyof typeof FEE_TYPES, number, number]> = [
      ["SHIELD", shieldBps, 0],
      ["WITHDRAWAL", withdrawBps, 0],
      ["TRANSFER", 0, flat],
      ["SPLIT", 0, flat],
      ["MERGE", 0, flat],
    ];

    console.log(`${a.name} (uid ${uid}, ${a.decimals} decimals):`);
    for (const [type, bps, flatAmt] of plan) {
      // A zero-bps, zero-flat config is already the registered default — skip it
      // rather than spend a tx re-writing ZERO-FEE (keeps the run to the fees
      // that actually matter: shield + withdrawal).
      if (bps === 0 && flatAmt === 0) { console.log(`  · ${type.padEnd(10)} left at 0 (default)`); continue; }
      await deployer.callContract(
        AR,
        "set-asset-fee-config",
        [Cl.uint(uid), Cl.uint(FEE_TYPES[type]), Cl.uint(bps), Cl.uint(flatAmt), Cl.bool(true)],
        `${ASSET_REGISTRY}.set-asset-fee-config.${a.name}.${type}`,
      );
      console.log(`  ✓ ${type.padEnd(10)} bps=${bps} flat=${flatAmt}`);
    }
  }
  console.log("\n✓ SIP-10 fees configured. New transfers/withdrawals/splits/merges will collect them.");
}

async function main(): Promise<void> {
  await setSip10Fees(await getDeployer(), env());
}

if (isEntrypoint(import.meta.url)) {
  main().catch((err) => { console.error("SET SIP-10 FEES FAILED:", err instanceof Error ? err.message : err); process.exit(1); });
}
