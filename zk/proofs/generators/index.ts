// =============================================================================
// zk/proofs/generators -- per-operation proof generators
// =============================================================================
// Orchestrates witness assembly + UltraHonk proving for each of the five
// operations, returning a GeneratedProof (proof bytes + public inputs + hashes
// + proof-id) ready for attestation and submission. Pure orchestration over
// the SDK's witness builders, the barretenberg prover, and the public-inputs
// hashing — all cryptographic rules live in the circuits and contracts.

import { UltraHonkProver } from "../../barretenberg/proving/prover.js";
import { attestationMessage } from "../../../sdk/attestations/index.js";
import * as PI from "../../../sdk/proofs/public-inputs.js";
import {
  ProofType,
  type Bytes32,
  type GeneratedProof,
  ShieldError,
} from "../../../sdk/types.js";
import { toHex } from "../../../sdk/utilities/crypto.js";

/** A generator bound to one circuit's prover + circuit version. */
export class ProofGenerator {
  constructor(
    private readonly provers: ReadonlyMap<ProofType, UltraHonkProver>,
    private readonly circuitVersion: number,
  ) {}

  private prover(t: ProofType): UltraHonkProver {
    const p = this.provers.get(t);
    if (!p) throw new ShieldError("NO_PROVER", `no prover for proof type ${t}`);
    return p;
  }

  /** Generate a proof from an already-assembled witness and its public-inputs
   *  hash. Returns everything needed to attest and submit. */
  async generate(
    proofType: ProofType,
    witness: Record<string, unknown>,
    publicInputsHash: Bytes32,
  ): Promise<GeneratedProof> {
    const { proof, publicInputs, vkeyHash } = await this.prover(proofType).prove(witness);
    const proofId = attestationMessage({
      proofType,
      circuitVersion: this.circuitVersion,
      vkeyHash,
      publicInputsHash,
      proof,
    });
    return {
      proofType,
      circuitVersion: this.circuitVersion,
      proof,
      publicInputs: publicInputs.map((p) => (p.startsWith("0x") ? p : "0x" + p)),
      publicInputsHash,
      vkeyHash,
      proofId,
    };
  }
}

/** Convenience re-export: the public-inputs hashers used to derive the hash a
 *  generator binds a proof to. */
export const publicInputHashers = {
  shield: PI.shieldInputsHash,
  transfer: PI.transferInputsHash,
  withdraw: PI.withdrawInputsHash,
  split: PI.splitInputsHash,
  merge: PI.mergeInputsHash,
};

export { toHex };
