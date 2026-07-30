// =============================================================================
// STX Shield SDK -- Barretenberg / UltraHonk backend
// =============================================================================
// Thin, production wrapper around Noir + Barretenberg (bb.js) for witness
// solving, UltraHonk proof generation, verification-key derivation, and proof
// verification. One compiled circuit artifact per proof type.
//
// Circuit artifacts (compiled with `nargo compile`) are loaded by name and
// paired with a persistent UltraHonk backend. Verifying keys are hashed with
// sha256 to produce the on-chain `vkey-hash` registered in zk-verifier.
//
// This module isolates every native dependency (@aztec/bb.js, @noir-lang/*),
// so the rest of the SDK is pure TypeScript and unit-testable without a prover.

import { sha256 } from "../../../sdk/utilities/crypto.js";
import { ProofType, type Bytes, type Bytes32, ShieldError } from "../../../sdk/types.js";

// bb.js / noir_js are heavy native deps; import lazily so environments that
// only build transactions (e.g. a relayer) never pay for them.
type NoirModule = typeof import("@noir-lang/noir_js");
type BackendModule = typeof import("@aztec/bb.js");

export interface CircuitArtifact {
  readonly proofType: ProofType;
  readonly circuitVersion: number;
  /** The compiled Noir program JSON (bytecode + ABI). */
  readonly program: unknown;
}

export interface ProveResult {
  readonly proof: Bytes;
  readonly publicInputs: readonly string[];
  readonly vkeyHash: Bytes32;
}

/** One UltraHonk backend bound to one compiled circuit. */
export class UltraHonkProver {
  private noir?: InstanceType<NoirModule["Noir"]>;
  private backend?: InstanceType<BackendModule["UltraHonkBackend"]>;
  private vkeyHashCache?: Bytes32;

  constructor(private readonly artifact: CircuitArtifact) {}

  private async init(): Promise<void> {
    if (this.noir && this.backend) return;
    const { Noir } = await import("@noir-lang/noir_js");
    const { UltraHonkBackend } = await import("@aztec/bb.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const program = this.artifact.program as any;
    this.noir = new Noir(program);
    this.backend = new UltraHonkBackend(program.bytecode);
  }

  /** Solve the witness and produce an UltraHonk proof. */
  async prove(witnessInputs: Record<string, unknown>): Promise<ProveResult> {
    await this.init();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { witness } = await this.noir!.execute(witnessInputs as any);
    const { proof, publicInputs } = await this.backend!.generateProof(witness);
    return {
      proof,
      publicInputs,
      vkeyHash: await this.vkeyHash(),
    };
  }

  /** Verify a proof locally (used before submitting on chain). */
  async verify(proof: Bytes, publicInputs: readonly string[]): Promise<boolean> {
    await this.init();
    return this.backend!.verifyProof({
      proof,
      publicInputs: publicInputs as string[],
    });
  }

  /** sha256 of the serialized verification key == the on-chain vkey-hash. */
  async vkeyHash(): Promise<Bytes32> {
    if (this.vkeyHashCache) return this.vkeyHashCache;
    await this.init();
    const vk = await this.backend!.getVerificationKey();
    this.vkeyHashCache = sha256(vk);
    return this.vkeyHashCache;
  }

  async proofLength(sampleWitness: Record<string, unknown>): Promise<number> {
    const { proof } = await this.prove(sampleWitness);
    return proof.length;
  }
}

/** Load a compiled circuit artifact from disk (target/*.json from nargo). */
export async function loadArtifact(
  proofType: ProofType,
  circuitVersion: number,
  programJson: unknown,
): Promise<CircuitArtifact> {
  if (!programJson)
    throw new ShieldError("NO_ARTIFACT", `missing circuit artifact for type ${proofType}`);
  return { proofType, circuitVersion, program: programJson };
}
