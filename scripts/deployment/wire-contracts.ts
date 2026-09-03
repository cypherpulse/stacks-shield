// =============================================================================
// STX Shield -- contract wiring
// =============================================================================
// Post-deployment configuration. Runs automatically as part of deploy-all, and
// can be re-run on its own (every step is idempotent).
//
//   1. authorize the protocol callers on the registry
//   2. bootstrap the genesis Merkle root
//   3. register the five circuit verification keys (the zkVerify vkey hashes)
//   4. seat the aggregation relayer
//   5. configure fees and the treasury
//
// NOTE: no committee is seated. There isn't one.

import { Cl } from "@stacks/transactions";
import { AUTHORIZED_CALLERS, CIRCUITS, STX_CIRCUIT_VERSION, type Network } from "./config.js";
import type { Deployer } from "./deployer.js";

export interface WireOptions {
  /** zkVerify verification-key hashes per circuit, hex, keyed by proof type. */
  vkeyHashes: Record<number, string>;
  /** Proof byte length per circuit, keyed by proof type. */
  proofLengths: Record<number, number>;
  /** Principal permitted to publish zkVerify aggregation roots. */
  relayer?: string;
  /** Treasury recipient for protocol fees. */
  treasury?: string;
  /** Fee schedule: [feeType, bps, flat]. */
  fees?: Array<[number, number, number]>;
  genesisRootHex: string;
  /** zkVerify statement binding — the values that make contract==zkVerify.
   *  keccak256(verifier_ctx) for the UltraHonk pallet. */
  zkverifyContextHash?: string;
  /** Per proof-type: [zkvVkeyHash, versionHash], both hex. */
  zkverifyBindings?: Record<number, [string, string]>;
}

const hexBuf = (hex: string) =>
  Cl.buffer(Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex")));

export const wireContracts = async (
  d: Deployer,
  network: Network,
  opts: WireOptions,
): Promise<void> => {
  console.log(`\nWiring contracts on ${network}...`);

  // 1. authorize the contracts that perform protected registry writes
  for (const caller of AUTHORIZED_CALLERS) {
    const already = await d.readOnly("privacy-registry", "is-authorized-caller", []);
    void already; // best-effort; the call below is idempotent by contract design
    try {
      await d.callContract(
        "privacy-registry",
        "add-authorized-caller",
        [Cl.contractPrincipal(d.signer.address, caller)],
        `authorize ${caller}`,
      );
    } catch (e) {
      console.log(`  · ${caller} already authorized (${(e as Error).message.slice(0, 60)})`);
    }
  }

  // 2. bootstrap the empty-tree root
  try {
    await d.callContract(
      "privacy-registry",
      "update-root",
      [hexBuf(opts.genesisRootHex), Cl.uint(1)],
      "bootstrap genesis root",
    );
  } catch {
    console.log("  · genesis root already set");
  }

  // 3. register the zkVerify verification keys — the anchor binding a
  //    zkVerify statement to this protocol
  for (const circuit of CIRCUITS) {
    const vkey = opts.vkeyHashes[circuit.proofType];
    const len = opts.proofLengths[circuit.proofType];
    if (!vkey || !len) {
      console.log(`  · no vkey for ${circuit.name} — skipping (register before going live)`);
      continue;
    }
    try {
      await d.callContract(
        "zk-verifier",
        "register-verification-key",
        [Cl.uint(circuit.proofType), Cl.uint(STX_CIRCUIT_VERSION), hexBuf(vkey), Cl.uint(len)],
        `register vkey ${circuit.name}`,
      );
    } catch {
      console.log(`  · vkey for ${circuit.name} already registered (immutable)`);
    }
  }

  // 3b. configure the zkVerify statement binding. Without this verify-proof
  //     fails closed (u320), so a real proof cannot be accepted until these
  //     network-observed constants are set.
  if (opts.zkverifyContextHash) {
    try {
      await d.callContract(
        "zk-verifier",
        "set-zkverify-context-hash",
        [hexBuf(opts.zkverifyContextHash)],
        "set zkVerify context hash",
      );
    } catch {
      console.log("  · zkVerify context already set");
    }
  }
  for (const circuit of CIRCUITS) {
    const binding = opts.zkverifyBindings?.[circuit.proofType];
    if (!binding) {
      console.log(`  · no zkVerify binding for ${circuit.name} — skipping`);
      continue;
    }
    const [zkvVkey, versionHash] = binding;
    try {
      await d.callContract(
        "zk-verifier",
        "set-zkverify-binding",
        [Cl.uint(circuit.proofType), Cl.uint(STX_CIRCUIT_VERSION), hexBuf(zkvVkey), hexBuf(versionHash)],
        `bind zkVerify ${circuit.name}`,
      );
    } catch {
      console.log(`  · zkVerify binding for ${circuit.name} already set`);
    }
  }

  // 4. seat the aggregation relayer
  if (opts.relayer) {
    try {
      await d.callContract(
        "zk-verifier",
        "add-relayer",
        [Cl.principal(opts.relayer)],
        "add aggregation relayer",
      );
    } catch {
      console.log("  · relayer already registered");
    }
  }

  // 5. treasury and fees
  if (opts.treasury) {
    try {
      await d.callContract(
        "protocol-fees",
        "set-treasury",
        [Cl.principal(opts.treasury)],
        "set treasury",
      );
    } catch {
      console.log("  · treasury already set");
    }
  }
  for (const [feeType, bps, flat] of opts.fees ?? []) {
    await d.callContract(
      "protocol-fees",
      "set-fee",
      [Cl.uint(feeType), Cl.uint(bps), Cl.uint(flat), Cl.bool(true)],
      `set fee type ${feeType}`,
    );
  }

  console.log("Wiring complete.");
};
