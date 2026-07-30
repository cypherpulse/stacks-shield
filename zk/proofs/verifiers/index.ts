// =============================================================================
// zk/proofs/verifiers -- pre-submission proof validation
// =============================================================================
// Validates a GeneratedProof end to end before it is submitted on chain:
//   1. structural: proof length matches the registered vkey length
//   2. binding: the proof-id equals the recomputed attestation message
//   3. cryptographic: UltraHonk verification passes locally
// A proof that fails any check would be rejected on chain, so this saves gas
// and surfaces client bugs early.

import { LocalVerifier } from "../../barretenberg/verification/verifier.js";
import { attestationMessage } from "../../../sdk/attestations/index.js";
import { bytesEqual } from "../../../sdk/utilities/crypto.js";
import type { GeneratedProof } from "../../../sdk/types.js";

export interface PreflightResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export async function preflightProof(
  proof: GeneratedProof,
  verifier: LocalVerifier,
  expectedProofLength: number,
): Promise<PreflightResult> {
  if (proof.proof.length !== expectedProofLength)
    return { ok: false, reason: `proof length ${proof.proof.length} != ${expectedProofLength}` };

  const recomputedId = attestationMessage({
    proofType: proof.proofType,
    circuitVersion: proof.circuitVersion,
    vkeyHash: proof.vkeyHash,
    publicInputsHash: proof.publicInputsHash,
    proof: proof.proof,
  });
  if (!bytesEqual(recomputedId, proof.proofId))
    return { ok: false, reason: "proof-id mismatch" };

  const verified = await verifier.verify(proof.proof, proof.publicInputs);
  if (!verified) return { ok: false, reason: "local UltraHonk verification failed" };

  return { ok: true };
}
