// =============================================================================
// STX Shield -- protocol upgrade script
// =============================================================================
// Drives a versioned protocol upgrade through the registry's UPGRADING state
// machine. This is the ONLY sanctioned way to change component versions
// (verifier / circuit / note / commitment / root / protocol) without breaking
// live notes, commitments, roots, nullifiers, treasury balances, or statistics.
//
// Sequence (each step is a signed contract-call, confirmed before the next):
//   1. registry.pause-protocol                 ACTIVE   -> PAUSED
//   2. registry.begin-upgrade                   PAUSED   -> UPGRADING
//   3. zk-verifier.register-verification-key    stage the NEW circuit vkeys
//      (registration is allowed in any state; the old vkeys stay enabled)
//   4. registry.update-versions(newVersions)    bump component versions
//      (or zk-verifier.set-verifier-versions for a verifier-only bump)
//   5. registry.complete-upgrade                UPGRADING -> ACTIVE
//
// Old proofs pinned to the previous circuit version are rejected once the
// registry's circuit version advances; new proofs use the new vkeys. Notes
// created under the old note version remain spendable (their version is
// recorded per note). Verified end-to-end by the upgrade-drill tests.

import { Cl } from "@stacks/transactions";
import type { ContractName } from "../deployment/config.js";

export interface UpgradeStep {
  readonly description: string;
  readonly contract: ContractName;
  readonly functionName: string;
  readonly functionArgs: readonly unknown[];
  /** wait for on-chain confirmation before the next step. */
  readonly awaitConfirmation: boolean;
}

export interface ComponentVersions {
  readonly protocol: number;
  readonly verifier: number;
  readonly note: number;
  readonly circuit: number;
  readonly commitment: number;
  readonly root: number;
}

export interface NewCircuitVKey {
  readonly proofType: number;
  readonly circuitVersion: number;
  readonly vkeyHashHex: string;
  readonly proofLength: number;
}

/** Build the ordered upgrade plan. `newVKeys` are staged before the version
 *  bump so verification never has a gap. */
export function buildUpgradePlan(args: {
  newVersions: ComponentVersions;
  newVKeys: readonly NewCircuitVKey[];
}): UpgradeStep[] {
  const steps: UpgradeStep[] = [
    step("pause protocol", "privacy-registry", "pause-protocol", [], true),
    step("enter upgrade window", "privacy-registry", "begin-upgrade", [], true),
  ];

  for (const vk of args.newVKeys) {
    steps.push(
      step(
        `stage vkey type=${vk.proofType} v=${vk.circuitVersion}`,
        "zk-verifier",
        "register-verification-key",
        [
          Cl.uint(vk.proofType),
          Cl.uint(vk.circuitVersion),
          Cl.bufferFromHex(vk.vkeyHashHex.replace(/^0x/, "")),
          Cl.uint(vk.proofLength),
        ],
        true,
      ),
    );
  }

  steps.push(
    step(
      "bump component versions",
      "privacy-registry",
      "update-versions",
      [
        Cl.tuple({
          protocol: Cl.uint(args.newVersions.protocol),
          verifier: Cl.uint(args.newVersions.verifier),
          note: Cl.uint(args.newVersions.note),
          circuit: Cl.uint(args.newVersions.circuit),
          commitment: Cl.uint(args.newVersions.commitment),
          root: Cl.uint(args.newVersions.root),
        }),
      ],
      true,
    ),
    step("resume operation", "privacy-registry", "complete-upgrade", [], true),
  );

  return steps;
}

function step(
  description: string,
  contract: ContractName,
  functionName: string,
  functionArgs: readonly unknown[],
  awaitConfirmation: boolean,
): UpgradeStep {
  return { description, contract, functionName, functionArgs, awaitConfirmation };
}
