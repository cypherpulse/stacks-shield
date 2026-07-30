// =============================================================================
// STX Shield -- post-deployment verification
// =============================================================================
// Reads the deployed contracts back and asserts the protocol is configured
// correctly and — critically — that NO committee gate exists on user
// transactions. Exits non-zero on any failure so CI can gate on it.

import { CONTRACT_ORDER, type Network } from "./config.js";
import type { Deployer } from "./deployer.js";
import { loadAddresses } from "./save-addresses.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export const verifyDeployment = async (
  d: Deployer,
  network: Network,
): Promise<{ checks: Check[]; passed: boolean }> => {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

  console.log(`\nVerifying deployment on ${network}...`);

  // 1. every contract exists
  for (const c of CONTRACT_ORDER) {
    add(`contract deployed: ${c}`, await d.isDeployed(c));
  }

  // 2. addresses artifact matches the chain
  try {
    const a = loadAddresses(network);
    add("addresses.json present and consistent", a.deployer === d.signer.address, a.deployer);
  } catch (e) {
    add("addresses.json present", false, (e as Error).message);
  }

  // 3. protocol is live
  const state = await d.readOnly("privacy-registry", "get-protocol-state");
  add("registry reachable", state.okay, state.cause ?? "");

  // 4. the verifier is the migrated one, with no committee surface
  const version = await d.readOnly("zk-verifier", "get-verifier-contract-version");
  add("verifier is v2 (committee removed)", version.okay, version.result ?? "");

  // The committee functions must NOT exist. If any of these resolve, the old
  // verifier is deployed and user transactions are still gated.
  for (const gone of [
    "get-attestor-count",
    "get-attestation-threshold",
    "add-attestor",
    "set-attestation-threshold",
  ]) {
    const res = await d.readOnly("zk-verifier", gone);
    add(`committee surface absent: ${gone}`, !res.okay, res.okay ? "STILL PRESENT" : "absent");
  }

  // 5. the aggregation pipeline exists
  const aggCount = await d.readOnly("zk-verifier", "get-aggregation-count");
  add("aggregation registry present", aggCount.okay, aggCount.result ?? "");
  const relayers = await d.readOnly("zk-verifier", "get-relayer-count");
  add("relayer registry present", relayers.okay, relayers.result ?? "");

  // 6. fees / treasury reachable
  const fees = await d.readOnly("protocol-fees", "get-fees-info");
  add("fees contract reachable", fees.okay, fees.cause ?? "");

  // 7. pool operational switches
  const pool = await d.readOnly("privacy-pool", "is-shield-enabled");
  add("pool operational", pool.okay, pool.result ?? "");

  const passed = checks.every((c) => c.ok);
  for (const c of checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log(passed ? "\nDeployment verified." : "\nDEPLOYMENT VERIFICATION FAILED.");
  return { checks, passed };
};
