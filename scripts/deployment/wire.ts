// =============================================================================
// STX Shield -- protocol wiring script (post-deploy configuration)
// =============================================================================
// Runs the deployment runbook as on-chain transactions, in order:
//
//   1. registry.add-authorized-caller(pool, note-manager, split-merge-manager)
//   2. registry.update-root(genesis empty-tree root)
//   3. zk-verifier.register-verification-key for each of the 5 circuits
//   4. zk-verifier.add-attestor for each committee member, then
//      set-attestation-threshold(threshold)
//   5. (optional) protocol-fees.set-fee per type
//   6. registry.transfer-ownership(finalOwner)  [owner accepts separately]
//
// Every step is a contract-call the operator signs with the deployer key.
// Idempotent: re-running skips steps whose on-chain state already matches.
//
// Usage: DEPLOYER_KEY=<hex> ts-node deployment/wire.ts <network>

import { Cl } from "@stacks/transactions";
import {
  AUTHORIZED_CALLERS,
  CIRCUITS,
  NETWORKS,
  type ContractName,
  type Network,
} from "./config.js";

/** A planned contract-call step (built here, signed+broadcast by the runner). */
export interface WireStep {
  readonly description: string;
  readonly contract: ContractName;
  readonly functionName: string;
  readonly functionArgs: readonly unknown[];
}

export interface CommitteeMember {
  readonly publicKeyHex: string; // 33-byte compressed, 0x-hex
}

export interface VKeyRegistration {
  readonly proofType: number;
  readonly circuitVersion: number;
  readonly vkeyHashHex: string; // sha256 of the serialized vk
  readonly proofLength: number; // exact UltraHonk proof byte length
}

export interface FeeSetting {
  readonly feeType: number;
  readonly bps: number;
  readonly flat: number;
  readonly enabled: boolean;
}

/** Build the full, ordered wiring plan. The runner signs and broadcasts each
 *  step, waiting for confirmation between dependent steps. */
export function buildWirePlan(args: {
  network: Network;
  vkeys: readonly VKeyRegistration[];
  committee: readonly CommitteeMember[];
  fees?: readonly FeeSetting[];
  finalOwner?: string;
}): WireStep[] {
  const cfg = NETWORKS[args.network];
  const steps: WireStep[] = [];

  // 1. authorize protocol contracts
  for (const caller of AUTHORIZED_CALLERS) {
    steps.push({
      description: `authorize ${caller}`,
      contract: "privacy-registry",
      functionName: "add-authorized-caller",
      functionArgs: [Cl.contractPrincipal(deployerPlaceholder(), caller)],
    });
  }

  // 2. bootstrap the tree with the empty-tree root
  steps.push({
    description: "bootstrap genesis root",
    contract: "privacy-registry",
    functionName: "update-root",
    functionArgs: [Cl.bufferFromHex(cfg.genesisRootHex.replace(/^0x/, "")), Cl.uint(1)],
  });

  // 3. register verification keys (must cover all 5 circuits)
  if (args.vkeys.length !== CIRCUITS.length)
    throw new Error(`expected ${CIRCUITS.length} vkeys, got ${args.vkeys.length}`);
  for (const vk of args.vkeys) {
    steps.push({
      description: `register vkey type=${vk.proofType} v=${vk.circuitVersion}`,
      contract: "zk-verifier",
      functionName: "register-verification-key",
      functionArgs: [
        Cl.uint(vk.proofType),
        Cl.uint(vk.circuitVersion),
        Cl.bufferFromHex(vk.vkeyHashHex.replace(/^0x/, "")),
        Cl.uint(vk.proofLength),
      ],
    });
  }

  // 4. seat the committee, then set the threshold
  for (const m of args.committee) {
    steps.push({
      description: `add attestor ${m.publicKeyHex.slice(0, 12)}…`,
      contract: "zk-verifier",
      functionName: "add-attestor",
      functionArgs: [Cl.bufferFromHex(m.publicKeyHex.replace(/^0x/, ""))],
    });
  }
  if (cfg.attestationThreshold > args.committee.length)
    throw new Error("threshold exceeds committee size");
  steps.push({
    description: `set threshold ${cfg.attestationThreshold}-of-${args.committee.length}`,
    contract: "zk-verifier",
    functionName: "set-attestation-threshold",
    functionArgs: [Cl.uint(cfg.attestationThreshold)],
  });

  // 5. optional fee configuration
  for (const fee of args.fees ?? []) {
    steps.push({
      description: `set fee type=${fee.feeType}`,
      contract: "protocol-fees",
      functionName: "set-fee",
      functionArgs: [Cl.uint(fee.feeType), Cl.uint(fee.bps), Cl.uint(fee.flat), Cl.bool(fee.enabled)],
    });
  }

  // 6. hand ownership to the production multisig/timelock (two-step: the new
  //    owner accepts in a separate transaction it signs itself)
  const owner = args.finalOwner ?? cfg.finalOwner;
  if (owner) {
    steps.push({
      description: `transfer ownership -> ${owner}`,
      contract: "privacy-registry",
      functionName: "transfer-ownership",
      functionArgs: [Cl.principal(owner)],
    });
  }

  return steps;
}

// Deployer principal is injected at run time; placeholder keeps the plan builder
// pure and unit-testable.
function deployerPlaceholder(): string {
  return process.env.DEPLOYER_ADDRESS ?? "SP000000000000000000002Q6VF78";
}
