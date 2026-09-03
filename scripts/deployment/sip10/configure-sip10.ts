// =============================================================================
// configure-sip10.ts -- one-shot post-deploy configuration
// =============================================================================
//   npx tsx scripts/deployment/sip10/configure-sip10.ts
//
// Runs the full SIP-10 configuration in order, after deploy-sip10.ts:
//   1. authorize sip10-pool on the shared privacy-registry (protected writes)
//   2. authorize sip10-pool on sip10-zk-verifier (only-the-pool verify)
//   3. seat the aggregation relayer on sip10-zk-verifier
//   4. register the five vkeys + zkVerify bindings   (register-verification-keys)
//   5. register sBTC + USDCx                          (register-assets)
//   6. set the verifier's active circuit-version      (SIP10_CIRCUIT_VERSION)
//
// note-manager is already an authorized caller from the STX deployment; step 1
// only adds the new pool. Each step is idempotent: an "already configured"
// abort is reported and skipped, so the script is safe to re-run.
//
// Step 6 is what makes verify-proof accept proofs at the active version: the
// verifier's `verify-proof` asserts circuit-version == sip10-circuit-version, so
// after registering vkeys at SIP10_CIRCUIT_VERSION the var must be advanced to
// match. set-circuit-version only moves forward, so a re-run skips on u572.

import { REGISTRY, VERIFIER, SIP10_CIRCUIT_VERSION, Cl, asContract, env, getDeployer } from "./lib.js";
import { registerVerificationKeys } from "./register-verification-keys.js";
import { registerAssets } from "./register-assets.js";
import type { Deployer } from "../deployer.js";

/** Call a contract fn, tolerating a specific "already done" error code. */
async function tolerant(deployer: Deployer, contract: string, fn: string, args: Parameters<Deployer["callContract"]>[2], okCode: string, skipMsg: string): Promise<void> {
  try {
    await deployer.callContract(asContract(contract), fn, args, `${contract}.${fn}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(okCode)) console.log(`  · ${skipMsg}`);
    else throw err;
  }
}

async function main(): Promise<void> {
  const deployer = await getDeployer();
  const e = env();
  const addr = deployer.signer.address;
  const pool = Cl.contractPrincipal(addr, "sip10-pool");
  console.log(`Configuring SIP-10 under ${addr}\n`);

  console.log("1/6  authorize sip10-pool on privacy-registry");
  await tolerant(deployer, REGISTRY, "add-authorized-caller", [pool], "u144", "pool already authorized on registry");

  console.log("2/6  authorize sip10-pool on sip10-zk-verifier");
  await tolerant(deployer, VERIFIER, "set-authorized-pool", [pool], "u573", "authorized-pool already set");

  console.log("3/6  seat aggregation relayer");
  const relayer = e["RELAYER_ADDRESS"] || addr;
  await tolerant(deployer, VERIFIER, "add-relayer", [Cl.principal(relayer)], "u318", "relayer already seated");

  console.log("4/6  register vkeys + zkVerify bindings");
  await registerVerificationKeys(deployer, e);

  console.log("5/6  register assets (sBTC, USDCx)");
  await registerAssets(deployer, e);

  console.log(`6/6  set verifier circuit-version -> ${SIP10_CIRCUIT_VERSION}`);
  await tolerant(deployer, VERIFIER, "set-circuit-version", [Cl.uint(SIP10_CIRCUIT_VERSION)], "u572", `circuit-version already at >= ${SIP10_CIRCUIT_VERSION}`);

  console.log("\nConfiguration complete. Run verify-deployment.ts to validate.");
}

main().catch((err) => { console.error("CONFIGURE FAILED:", err instanceof Error ? err.message : err); process.exit(1); });
