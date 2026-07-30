// =============================================================================
// STX Shield -- Attestation Service
// =============================================================================
// A committee member runs this service. It is the off-chain root of trust in
// v1: it independently verifies each UltraHonk proof with Barretenberg against
// the REGISTERED verification key, then signs the exact attestation message
// the zk-verifier contract will check. The contract accepts a proof only with
// >= threshold distinct valid committee signatures.
//
// Security duties (each independently sufficient to reject a proof):
//   1. proof type + circuit version are known and enabled
//   2. the submitted vkey hash matches the member's trusted vkey for that
//      (type, version) — a member NEVER signs against an unknown vkey
//   3. the public inputs are well-formed (non-zero inputs hash)
//   4. Barretenberg verifyProof(proof, publicInputs) succeeds against the vkey
//   5. the proof-id (attestation message) has not been signed before by this
//      member (per-member replay protection, in addition to on-chain)
//
// The signing key is a secp256k1 private key registered on-chain via
// zk-verifier.add-attestor. Signatures use prehash:false so they verify under
// Clarity's secp256k1-verify.

import { createHash } from "node:crypto";
import {
  buildAttestationMessage,
  committeePublicKey,
  signAttestation,
} from "../signatures/index.js";

type Bytes = Uint8Array;
const sha256 = (b: Bytes): Bytes => new Uint8Array(createHash("sha256").update(b).digest());
const toHex = (b: Bytes) => "0x" + Buffer.from(b).toString("hex");
const fromHex = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));

/** A verification key the member trusts for one (proof type, circuit version). */
export interface TrustedVKey {
  readonly proofType: number;
  readonly circuitVersion: number;
  readonly vkeyHash: Bytes; // sha256 of the serialized vk, == on-chain vkey-hash
  readonly enabled: boolean;
  /** Verify a proof against this key. Injected so the service is testable
   *  and the heavy Barretenberg dependency stays at the edge. */
  verify(proof: Bytes, publicInputs: readonly string[]): Promise<boolean>;
}

export interface AttestRequest {
  readonly proofType: number;
  readonly circuitVersion: number;
  readonly vkeyHash: string; // hex
  readonly publicInputsHash: string; // hex
  readonly publicInputs: readonly string[];
  readonly proof: string; // hex
}

export interface AttestResponse {
  readonly signature: string; // hex, 64-byte compact
  readonly signer: string; // hex, 33-byte compressed
}

export class AttestationService {
  private readonly signer: Bytes; // 33-byte compressed public key
  private readonly signed = new Set<string>(); // proof-ids this member has signed

  constructor(
    private readonly privateKey: Bytes,
    private readonly vkeys: ReadonlyMap<string, TrustedVKey>, // key: `${type}:${version}`
  ) {
    this.signer = committeePublicKey(privateKey);
  }

  get publicKey(): Bytes {
    return this.signer;
  }

  /** Independently verify a proof and, if valid, return a committee signature. */
  async attest(req: AttestRequest): Promise<AttestResponse> {
    const vkey = this.vkeys.get(`${req.proofType}:${req.circuitVersion}`);
    if (!vkey) throw new Error("unknown (proof type, circuit version)");
    if (!vkey.enabled) throw new Error("vkey disabled");

    // (2) never sign against a vkey we do not trust
    const submittedVkeyHash = fromHex(req.vkeyHash);
    if (toHex(submittedVkeyHash) !== toHex(vkey.vkeyHash))
      throw new Error("vkey hash mismatch");

    // (3) reject malformed public inputs
    const pih = fromHex(req.publicInputsHash);
    if (pih.length !== 32 || pih.every((b) => b === 0))
      throw new Error("invalid public inputs hash");

    const proof = fromHex(req.proof);

    // (4) THE cryptographic check: Barretenberg verification against the vkey
    const ok = await vkey.verify(proof, req.publicInputs);
    if (!ok) throw new Error("proof verification failed");

    // reconstruct the attestation message exactly as the contract does
    const message = this.attestationMessage({
      proofType: req.proofType,
      circuitVersion: req.circuitVersion,
      vkeyHash: vkey.vkeyHash,
      publicInputsHash: pih,
      proof,
    });

    // (5) per-member replay protection
    const proofId = toHex(message);
    if (this.signed.has(proofId)) throw new Error("already attested (replay)");
    this.signed.add(proofId);

    const signature = signAttestation(message, this.privateKey);
    return { signature: toHex(signature), signer: toHex(this.signer) };
  }

  /** The 32-byte attestation message == the on-chain proof-id, built with the
   *  shared byte-identical serializer so the service, SDK, and zk-verifier
   *  contract always agree. */
  private attestationMessage(o: {
    proofType: number;
    circuitVersion: number;
    vkeyHash: Bytes;
    publicInputsHash: Bytes;
    proof: Bytes;
  }): Bytes {
    return buildAttestationMessage({
      proofType: o.proofType,
      circuitVersion: o.circuitVersion,
      vkeyHash: o.vkeyHash,
      publicInputsHash: o.publicInputsHash,
      proofHash: sha256(o.proof),
    });
  }
}
