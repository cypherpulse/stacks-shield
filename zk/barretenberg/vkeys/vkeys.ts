// =============================================================================
// zk/barretenberg/vkeys -- verification-key registry
// =============================================================================
// Loads compiled verification keys, derives their on-chain hash (sha256 of the
// serialized vk), and produces the exact arguments for
// zk-verifier.register-verification-key. One entry per (proof type, circuit
// version). Immutable on chain: a wrong key is corrected by advancing the
// circuit version, never mutated.

import { createHash } from "node:crypto";
import { ProofType } from "../../../sdk/types.js";

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const toHex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");

export interface VKeyRecord {
  readonly proofType: ProofType;
  readonly circuitVersion: number;
  readonly vkeyHashHex: string;
  readonly proofLength: number;
}

/** Circuit name -> proof type, matching the deployment config. */
export const CIRCUIT_PROOF_TYPES: Readonly<Record<string, ProofType>> = {
  "shield-note": ProofType.Shield,
  "transfer-note": ProofType.Transfer,
  "withdraw-note": ProofType.Withdrawal,
  "split-note": ProofType.Split,
  "merge-note": ProofType.Merge,
};

/** Build the on-chain registration record from a serialized verification key
 *  and the circuit's fixed proof length. */
export function toVKeyRecord(
  proofType: ProofType,
  circuitVersion: number,
  serializedVk: Uint8Array,
  proofLength: number,
): VKeyRecord {
  return {
    proofType,
    circuitVersion,
    vkeyHashHex: toHex(sha256(serializedVk)),
    proofLength,
  };
}
