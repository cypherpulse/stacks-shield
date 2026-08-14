// =============================================================================
// register-assets.ts -- register the official testnet SIP-10 assets
// =============================================================================
//   npx tsx scripts/deployment/sip10/register-assets.ts
//
// Registers sBTC and USDCx in asset-registry, using the OFFICIAL testnet token
// contracts (from .env.deploy). register-asset validates the token against the
// SIP-010 trait and asserts its live get-decimals matches the declared value.
// Idempotent-ish: a re-run fails with ERR-PRINCIPAL-EXISTS (u401), which the
// script reports and treats as "already registered".

import { ASSET_REGISTRY, Cl, asContract, contractPrincipalArg, env, getDeployer, isEntrypoint, requireEnvVars } from "./lib.js";
import type { Deployer } from "../deployer.js";

interface AssetSpec {
  contract: string;   // "ST....token"
  name: string;       // display name (<= 32 ascii)
  decimals: number;
  minShield: number;
  maxShield: number;
}

export const assetEnvKeys = ["SBTC_CONTRACT", "SBTC_DECIMALS", "USDCX_CONTRACT", "USDCX_DECIMALS"];

const num = (e: Record<string, string>, k: string, dflt: number): number =>
  e[k] && e[k]!.trim() !== "" ? Number(e[k]) : dflt;

export function assetSpecs(e: Record<string, string>): AssetSpec[] {
  return [
    {
      contract: e["SBTC_CONTRACT"]!, name: "sBTC", decimals: num(e, "SBTC_DECIMALS", 8),
      minShield: num(e, "SBTC_MIN_SHIELD", 1_000),             // 0.00001 sBTC
      maxShield: num(e, "SBTC_MAX_SHIELD", 100_000_000_000),   // 1000 sBTC
    },
    {
      contract: e["USDCX_CONTRACT"]!, name: "USDCx", decimals: num(e, "USDCX_DECIMALS", 6),
      minShield: num(e, "USDCX_MIN_SHIELD", 1_000_000),        // 1 USDCx
      maxShield: num(e, "USDCX_MAX_SHIELD", 1_000_000_000_000),// 1,000,000 USDCx
    },
  ];
}

export async function registerAssets(deployer: Deployer, e: Record<string, string>): Promise<void> {
  requireEnvVars(e, assetEnvKeys);
  const feeRecipient = e["FEE_RECIPIENT"] || deployer.signer.address;
  const AR = asContract(ASSET_REGISTRY);

  for (const a of assetSpecs(e)) {
    console.log(`Registering ${a.name} (${a.contract}, ${a.decimals} decimals) …`);
    try {
      await deployer.callContract(AR, "register-asset", [
        contractPrincipalArg(a.contract),
        Cl.stringAscii(a.name),
        Cl.uint(a.decimals),
        Cl.uint(a.minShield),
        Cl.uint(a.maxShield),
        Cl.uint(1),                 // min-note (dust floor)
        Cl.uint(0),                 // max-note (0 = unlimited)
        Cl.principal(feeRecipient),
        Cl.uint(1),                 // asset schema version
      ], `${ASSET_REGISTRY}.register-asset.${a.name}`);
      console.log(`  ✓ ${a.name} registered`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("u401")) console.log(`  · ${a.name} already registered — skipping`);
      // Token contract not on chain (e.g. wiped by a testnet reset, or not yet
      // redeployed by its maintainer): skip it rather than failing the whole run,
      // so the assets that ARE available still get registered.
      else if (/NoSuchContract|BadFunctionArgument/.test(msg)) console.log(`  · ${a.name} token contract not found (${a.contract}) — skipping`);
      else throw err;
    }
  }
}

async function main(): Promise<void> {
  await registerAssets(await getDeployer(), env());
}

if (isEntrypoint(import.meta.url)) {
  main().catch((err) => { console.error("ASSET REGISTRATION FAILED:", err instanceof Error ? err.message : err); process.exit(1); });
}
