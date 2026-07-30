// =============================================================================
// zk/attestations/signatures -- committee signing primitives
// =============================================================================
// secp256k1 signing/verification for committee attestations, and the shared
// attestation-message builder that MUST be byte-identical across the SDK
// client, the attestation service, and the zk-verifier contract. Signatures
// use prehash:false so they verify under Clarity's secp256k1-verify.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Cl, serializeCVBytes } from "@stacks/transactions";
import { createHash } from "node:crypto";
import { ATTESTATION_DOMAIN, type Bytes, type Bytes32 } from "../../../sdk/types.js";

const sha256 = (b: Bytes): Bytes32 =>
  new Uint8Array(createHash("sha256").update(b).digest());

/** THE canonical attestation message (== on-chain proof-id). Reproduces
 *  zk-verifier's attestation-message: sha256(to-consensus-buff? {...}). */
export function buildAttestationMessage(o: {
  domain?: string;
  proofType: number;
  circuitVersion: number;
  vkeyHash: Bytes;
  publicInputsHash: Bytes;
  proofHash: Bytes;
}): Bytes32 {
  return sha256(
    serializeCVBytes(
      Cl.tuple({
        domain: Cl.stringAscii(o.domain ?? ATTESTATION_DOMAIN),
        "proof-type": Cl.uint(o.proofType),
        "circuit-version": Cl.uint(o.circuitVersion),
        "vkey-hash": Cl.buffer(o.vkeyHash),
        "public-inputs-hash": Cl.buffer(o.publicInputsHash),
        "proof-hash": Cl.buffer(o.proofHash),
      }),
    ),
  );
}

/** Compact 64-byte (r||s) signature over a 32-byte message hash. */
export function signAttestation(message: Bytes32, privateKey: Bytes): Bytes {
  return secp256k1.sign(message, privateKey, { prehash: false }) as Bytes;
}

/** Verify a committee signature over a message. */
export function verifySignature(message: Bytes32, signature: Bytes, signer: Bytes): boolean {
  try {
    return secp256k1.verify(signature, message, signer, { prehash: false });
  } catch {
    return false;
  }
}

/** Derive the compressed committee public key from a signing secret. */
export function committeePublicKey(privateKey: Bytes): Bytes {
  return secp256k1.getPublicKey(privateKey, true);
}
