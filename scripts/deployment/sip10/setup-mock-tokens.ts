// =============================================================================
// setup-mock-tokens.ts -- stand up mock sBTC/USDCx for testnet validation
// =============================================================================
//   npx tsx scripts/deployment/sip10/setup-mock-tokens.ts
//
// The external sBTC/USDCx testnet tokens were wiped by a testnet reset and are
// outside our control to redeploy. This deploys the mock-sbtc / mock-usdc SIP-010
// fixtures under the deployer, registers them in asset-registry (as "sBTC" /
// "USDCx"), and mints a test balance to alice/bob/carol so the SDK e2e can run.
// The SDK + API discover these from the on-chain registry by symbol — no config
// change needed. Swap back to the real tokens (re-run register-assets.ts) once
// they are available again.

import { readFileSync } from "node:fs";
import { getDeployer, Cl, contractPrincipalArg, asContract } from "./lib.js";

const users = (): string[] => {
  const t = readFileSync(".env.users", "utf8");
  const get = (k: string) => t.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
  return [get("ALICE_ADDRESS"), get("BOB_ADDRESS"), get("CAROL_ADDRESS")].filter(Boolean) as string[];
};

const TOKENS = [
  { contract: "mock-sbtc", symbol: "sBTC", decimals: 8, minShield: 1_000, maxShield: 100_000_000_000, mint: 500_000_000n }, // 5 sBTC each
  { contract: "mock-usdc", symbol: "USDCx", decimals: 6, minShield: 1_000_000, maxShield: 1_000_000_000_000, mint: 100_000_000n }, // 100 USDCx each
];

async function main(): Promise<void> {
  const d = await getDeployer();
  const deployer = d.signer.address;
  const recipients = users();
  console.log(`Setting up mock tokens under ${deployer}`);
  console.log(`  recipients: ${recipients.join(", ")}\n`);

  for (const t of TOKENS) {
    console.log(`=== ${t.symbol} (${t.contract}) ===`);
    // 1. deploy the mock SIP-010 token (idempotent — skipped if already on chain)
    await d.deployContract(asContract(t.contract));
    const tokenId = `${deployer}.${t.contract}`;

    // 2. register it in the asset-registry (validates its live get-decimals)
    try {
      await d.callContract(asContract("asset-registry"), "register-asset", [
        contractPrincipalArg(tokenId),
        Cl.stringAscii(t.symbol),
        Cl.uint(t.decimals),
        Cl.uint(t.minShield),
        Cl.uint(t.maxShield),
        Cl.uint(1),        // min-note (dust floor)
        Cl.uint(0),        // max-note (0 = unlimited)
        Cl.principal(deployer),
        Cl.uint(1),        // schema version
      ], `register-asset.${t.symbol}`);
      console.log(`  ✓ registered ${t.symbol}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("u401")) console.log(`  · ${t.symbol} already registered`);
      else throw e;
    }

    // 3. mint a test balance to each user
    for (const r of recipients) {
      await d.callContract(asContract(t.contract), "mint", [Cl.uint(t.mint), Cl.principal(r)], `mint.${t.symbol}`);
      console.log(`  ✓ minted ${t.mint} ${t.symbol} base units -> ${r}`);
    }
  }

  console.log("\n✓ mock sBTC + USDCx deployed, registered, and minted. Verify: GET /assets should now list STX + sBTC + USDCx.");
}

main().catch((e) => { console.error("SETUP FAILED:", e instanceof Error ? e.message : e); process.exit(1); });
