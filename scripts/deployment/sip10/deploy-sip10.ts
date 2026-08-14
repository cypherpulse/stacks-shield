// =============================================================================
// deploy-sip10.ts -- deploy the SIP-10 contracts to Stacks Testnet
// =============================================================================
//   npx tsx scripts/deployment/sip10/deploy-sip10.ts
//
// Deploys ONLY the five new SIP-10 contracts, in dependency order, under the
// existing STX Shield deployer (ST2HXRZ8...). The six frozen STX contracts are
// NOT redeployed; `.privacy-registry` / `.note-manager` inside the SIP-10
// contracts resolve to the live frozen ones because we deploy under the same
// account. The test-only mock tokens are NEVER deployed. Idempotent: a contract
// already on chain is skipped.

import { SIP10_CONTRACTS, asContract, getDeployer } from "./lib.js";

async function main(): Promise<void> {
  const deployer = await getDeployer();
  const bal = await deployer.accountBalance();
  console.log(`Deployer ${deployer.signer.address}  balance ${Number(bal) / 1e6} STX`);
  if (bal < 5_000_000n) console.warn("  ! low balance — deploys may fail for lack of fees");

  console.log(`Deploying ${SIP10_CONTRACTS.length} SIP-10 contracts (in order):`);
  for (const name of SIP10_CONTRACTS) {
    const txid = await deployer.deployContract(asContract(name));
    if (txid) console.log(`  ✓ ${name} deployed (${txid})`);
  }
  console.log("\nDone. Next: configure-sip10.ts (authorization + VKs + assets).");
}

main().catch((e) => {
  console.error("DEPLOY FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
