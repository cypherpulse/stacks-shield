// =============================================================================
// set-relayers.ts -- seat the aggregation relayers on BOTH verifiers
// =============================================================================
//   npx tsx scripts/deployment/set-relayers.ts
//
// Seats every address in RELAYER_ADDRESSES as an aggregation relayer on the
// native `zk-verifier` AND the `sip10-zk-verifier`, so the same relayer set
// serves STX and SIP-10. Optionally removes the deployer from the relayer set
// (RELAYER_DROP_DEPLOYER=true) once the real relayers are seated -- so the
// deployer is not doing double duty. NO redeploy: this is runtime admin config.
//
// The "aggregation relayer" is a LIVENESS role: a seated relayer publishes
// zkVerify aggregation roots on-chain (submit-aggregation) so proofs can be
// re-checked. It CANNOT forge a root or approve/deny any user op. Each seated
// address must be FUNDED (it pays the submit-aggregation gas), and whoever runs
// the transaction-relayer service (services/relayer) signs with that address's
// key (RELAYER_PRIVATE_KEY). Mint keys with gen-relayers.ts.
//
// Reads .env.v2.deploy (the deployer is the verifier admin). Idempotent.

import { Cl, cvToHex } from "@stacks/transactions";
import { env, getDeployer, asContract } from "./sip10/lib.js";
import type { Deployer } from "./deployer.js";

const VERIFIERS = ["zk-verifier", "sip10-zk-verifier"] as const;

const parseRelayers = (e: Record<string, string>): string[] => {
  const csv = e["RELAYER_ADDRESSES"];
  const raw = csv
    ? csv.split(",")
    : ["RELAYER_1_ADDRESS", "RELAYER_2_ADDRESS", "RELAYER_3_ADDRESS"].map((k) => e[k] ?? "");
  return [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
};

/** Whether `who` is currently a seated relayer on `verifier` (get-relayer !=
 *  none). Membership is checked BEFORE every write so the script is idempotent
 *  and never relies on an on-chain abort (whose message omits the error code). */
async function isRelayer(d: Deployer, verifier: string, who: string): Promise<boolean> {
  const res = await d.readOnly(asContract(verifier), "get-relayer", [cvToHex(Cl.principal(who))]);
  // Clarity `none` serializes to 0x09; any (some ...) begins 0x0a.
  return Boolean(res.okay && res.result && res.result !== "0x09");
}

async function main(): Promise<void> {
  const e = env();
  const relayers = parseRelayers(e);
  if (relayers.length === 0) {
    throw new Error(
      "No relayer addresses. Set RELAYER_ADDRESSES=ST..,ST..,ST.. (or RELAYER_1_ADDRESS..RELAYER_3_ADDRESS) in .env.v2.deploy.",
    );
  }
  const d = await getDeployer();
  const dropDeployer = /^(1|true|yes)$/i.test(e["RELAYER_DROP_DEPLOYER"] ?? "");
  const statusOnly = process.argv.includes("--status");
  // Explicit addresses to remove (e.g. a leftover seeded by AGGREGATION_RELAYER /
  // RELAYER_ADDRESS at deploy/configure time). The deployer is added when dropping.
  const removeList = [...new Set((e["RELAYER_REMOVE"] ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (dropDeployer) removeList.push(d.signer.address);
  if (dropDeployer && relayers.includes(d.signer.address)) {
    throw new Error("RELAYER_DROP_DEPLOYER=true but the deployer is itself in RELAYER_ADDRESSES — remove it from the list.");
  }

  // Extra addresses worth probing in --status so we can spot an unexpected member.
  const probe = [...new Set([d.signer.address, e["AGGREGATION_RELAYER"], e["RELAYER_ADDRESS"], ...removeList].filter(Boolean) as string[])];

  console.log(`${statusOnly ? "Status of" : "Seating"} ${relayers.length} relayer(s) on ${VERIFIERS.length} verifiers under ${d.signer.address}:`);
  for (const r of relayers) console.log(`  - ${r}`);

  for (const verifier of VERIFIERS) {
    console.log(`\n${verifier}:`);
    if (!(await d.isDeployed(asContract(verifier)))) {
      console.log(`  · not deployed yet — skipping (re-run after deploying it)`);
      continue;
    }

    if (statusOnly) {
      for (const who of relayers) console.log(`  relayer ${who}: ${(await isRelayer(d, verifier, who)) ? "SEATED" : "absent"}`);
      for (const who of probe) console.log(`  probe   ${who}${who === d.signer.address ? " (deployer)" : ""}: ${(await isRelayer(d, verifier, who)) ? "SEATED" : "absent"}`);
      const cnt = await d.readOnly(asContract(verifier), "get-relayer-count", []);
      console.log(`  relayer-count -> ${cnt.result ?? "?"} (want u${relayers.length})`);
      continue;
    }

    // Add each intended relayer that isn't already seated.
    for (const who of relayers) {
      if (await isRelayer(d, verifier, who)) {
        console.log(`  · ${who} already a relayer`);
      } else {
        await d.callContract(asContract(verifier), "add-relayer", [Cl.principal(who)], `${verifier}.add-relayer ${who}`);
      }
    }
    // Remove leftovers (+ deployer) AFTER the intended set is seated, and only if
    // actually seated — removing a non-member aborts.
    for (const who of removeList) {
      if (relayers.includes(who)) continue; // never remove an intended relayer
      if (await isRelayer(d, verifier, who)) {
        await d.callContract(asContract(verifier), "remove-relayer", [Cl.principal(who)], `${verifier}.remove-relayer ${who}`);
      } else {
        console.log(`  · ${who}${who === d.signer.address ? " (deployer)" : ""} not a relayer — nothing to remove`);
      }
    }
    const cnt = await d.readOnly(asContract(verifier), "get-relayer-count", []);
    console.log(`  relayer-count -> ${cnt.result ?? "?"} (want u${relayers.length})`);
  }

  console.log(
    "\nDone. FUND each relayer address (it pays submit-aggregation + relay gas). " +
      "Point the SDK/frontend at their service URLs via STX_SHIELD_RELAYERS.",
  );
}

main().catch((e) => {
  console.error("SET RELAYERS FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
