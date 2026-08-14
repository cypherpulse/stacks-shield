// =============================================================================
// verify-deployment.ts -- read-only health check for the SIP-10 deployment
// =============================================================================
//   npx tsx scripts/deployment/sip10/verify-deployment.ts
//
// Broadcasts nothing. Reads on-chain state and prints a PASS/FAIL report over
// every deployment invariant: contracts present, authorization wired, vkeys +
// zkVerify bindings ready, assets registered, pool healthy. Exit code is 1 if
// any check fails, so it can gate CI / a deploy pipeline.

import { cvToJSON, cvToHex, hexToCV, Cl } from "@stacks/transactions";
import { ASSET_REGISTRY, CIRCUITS, POOL, REGISTRY, SIP10_CONTRACTS, SIP10_CIRCUIT_VERSION, VERIFIER, asContract, getDeployer } from "./lib.js";
import type { Deployer } from "../deployer.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  ok ? pass++ : fail++;
};

const readJson = async (deployer: Deployer, contract: string, fn: string, args: string[] = []) => {
  const r = await deployer.readOnly(asContract(contract), fn, args);
  if (!r.result) throw new Error(`read ${contract}.${fn} failed: ${r.cause ?? JSON.stringify(r)}`);
  return cvToJSON(hexToCV(r.result));
};

async function main(): Promise<void> {
  const deployer = await getDeployer();
  const addr = deployer.signer.address;
  const poolHex = cvToHex(Cl.contractPrincipal(addr, "sip10-pool"));
  console.log(`SIP-10 deployment check @ ${addr}\n`);

  console.log("Contracts:");
  for (const c of SIP10_CONTRACTS) check(`${c} deployed`, await deployer.isDeployed(asContract(c)));

  console.log("\nAuthorization:");
  const authed = await readJson(deployer, REGISTRY, "is-authorized-caller", [poolHex]);
  check("sip10-pool authorized on privacy-registry", (authed as { value: boolean }).value === true);
  const pool = await readJson(deployer, VERIFIER, "get-authorized-pool");
  check("sip10-zk-verifier authorized-pool = sip10-pool", JSON.stringify(pool).includes("sip10-pool"));

  console.log("\nVerifier bindings (context + per-circuit):");
  for (const c of CIRCUITS) {
    const ready = await readJson(deployer, VERIFIER, "is-binding-ready", [cvToHex(Cl.uint(c.proofType)), cvToHex(Cl.uint(SIP10_CIRCUIT_VERSION))]);
    check(`binding ready: ${c.name} (proof-type ${c.proofType})`, (ready as { value: boolean }).value === true);
  }

  console.log("\nAssets:");
  const count = await readJson(deployer, ASSET_REGISTRY, "get-asset-count");
  check("asset-registry has >= 2 assets", Number((count as { value: string }).value) >= 2, `count=${(count as { value: string }).value}`);
  for (const uid of [1, 2]) {
    const a = await readJson(deployer, ASSET_REGISTRY, "get-asset", [cvToHex(Cl.uint(uid))]);
    check(`asset ${uid} registered`, JSON.stringify(a).includes("token"));
  }

  console.log("\nPool:");
  // NOTE: get-pool-info cross-calls .privacy-registry, which loads that large
  // contract and pushes a single read-only API call past the node's read_length
  // budget. Use the cheap, self-contained reads instead for the health check.
  const ver = await readJson(deployer, POOL, "get-pool-contract-version");
  check("sip10-pool reachable (get-pool-contract-version)", (ver as { value?: string }).value !== undefined, `version=${(ver as { value?: string }).value}`);
  const shieldEnabled = await readJson(deployer, POOL, "is-operation-enabled", [cvToHex(Cl.uint(1))]);
  check("sip10-pool shield operation enabled", (shieldEnabled as { value: boolean }).value === true);

  console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : "DEPLOYMENT INCOMPLETE"} — ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error("VERIFY FAILED:", err instanceof Error ? err.message : err); process.exit(1); });
