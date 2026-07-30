// =============================================================================
// zk/barretenberg/verification -- local UltraHonk verification
// =============================================================================
// Verifies a proof against a circuit's verification key BEFORE it is submitted
// on chain (fail fast, save gas) and inside each attestor before signing. A
// thin wrapper over the UltraHonkProver's verify path so callers never touch
// bb.js directly.

import { UltraHonkProver } from "../proving/prover.js";
import type { Bytes } from "../../../sdk/types.js";

export class LocalVerifier {
  constructor(private readonly prover: UltraHonkProver) {}

  /** True iff the proof verifies against this circuit's vkey. */
  async verify(proof: Bytes, publicInputs: readonly string[]): Promise<boolean> {
    return this.prover.verify(proof, publicInputs);
  }

  /** The vkey hash (== on-chain vkey-hash) this verifier checks against. */
  vkeyHash(): Promise<Bytes> {
    return this.prover.vkeyHash();
  }
}
