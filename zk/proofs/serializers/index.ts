// =============================================================================
// zk/proofs/serializers -- proof (de)serialization
// =============================================================================
// Canonical wire format for a generated proof, for transport between the
// prover, the attestation service, and the submitting wallet. Hex strings so
// it is JSON-safe; round-trips losslessly.

import {
  ProofType,
  type Bytes,
  type GeneratedProof,
} from "../../../sdk/types.js";

const toHex = (b: Bytes) => "0x" + Buffer.from(b).toString("hex");
const fromHex = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));

export interface SerializedProof {
  readonly proofType: ProofType;
  readonly circuitVersion: number;
  readonly proof: string;
  readonly publicInputs: readonly string[];
  readonly publicInputsHash: string;
  readonly vkeyHash: string;
  readonly proofId: string;
}

export function serializeProof(p: GeneratedProof): SerializedProof {
  return {
    proofType: p.proofType,
    circuitVersion: p.circuitVersion,
    proof: toHex(p.proof),
    publicInputs: [...p.publicInputs],
    publicInputsHash: toHex(p.publicInputsHash),
    vkeyHash: toHex(p.vkeyHash),
    proofId: toHex(p.proofId),
  };
}

export function deserializeProof(s: SerializedProof): GeneratedProof {
  return {
    proofType: s.proofType,
    circuitVersion: s.circuitVersion,
    proof: fromHex(s.proof),
    publicInputs: [...s.publicInputs],
    publicInputsHash: fromHex(s.publicInputsHash),
    vkeyHash: fromHex(s.vkeyHash),
    proofId: fromHex(s.proofId),
  };
}
