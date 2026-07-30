// =============================================================================
// STX Shield SDK -- attestation client
// =============================================================================
// Client side of the attestation committee. Given a generated proof and its
// binding parameters, requests signatures from the committee endpoints and
// aggregates enough distinct valid ones to meet the on-chain threshold.
//
// The attestation MESSAGE reproduced here MUST match zk-verifier's
// attestation-message exactly (domain, proof type, circuit version, vkey hash,
// public-inputs hash, proof hash) — verified by the passing contract suite,
// which uses the identical construction.

import { Cl, serializeCVBytes } from "@stacks/transactions";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256, toHex, fromHex, bytesEqual } from "../utilities/crypto.js";
import {
  ATTESTATION_DOMAIN,
  type Attestation,
  type Bytes,
  type Bytes32,
  ProofType,
  ShieldError,
} from "../types.js";

/** The 32-byte attestation-message hash == the on-chain proof-id. */
export function attestationMessage(o: {
  proofType: ProofType;
  circuitVersion: number;
  vkeyHash: Bytes32;
  publicInputsHash: Bytes32;
  proof: Bytes;
}): Bytes32 {
  return sha256(
    serializeCVBytes(
      Cl.tuple({
        domain: Cl.stringAscii(ATTESTATION_DOMAIN),
        "proof-type": Cl.uint(o.proofType),
        "circuit-version": Cl.uint(o.circuitVersion),
        "vkey-hash": Cl.buffer(o.vkeyHash),
        "public-inputs-hash": Cl.buffer(o.publicInputsHash),
        "proof-hash": Cl.buffer(sha256(o.proof)),
      }),
    ),
  );
}

/** Verify one attestation signature against a message (client-side pre-check
 *  so we never submit signatures the chain would reject). */
export function verifyAttestation(message: Bytes32, att: Attestation): boolean {
  try {
    return secp256k1.verify(att.signature, message, att.signer, { prehash: false });
  } catch {
    return false;
  }
}

export interface AttestorEndpoint {
  readonly url: string;
  /** Optional pinned committee public key for this endpoint. */
  readonly publicKey?: Bytes;
}

export interface AttestationRequest {
  readonly proofType: ProofType;
  readonly circuitVersion: number;
  readonly vkeyHash: Bytes32;
  readonly publicInputsHash: Bytes32;
  readonly proof: Bytes;
}

/** Collects `threshold` distinct valid attestations from the committee. */
export class AttestationClient {
  constructor(
    private readonly endpoints: readonly AttestorEndpoint[],
    private readonly threshold: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (threshold < 1) throw new ShieldError("BAD_THRESHOLD", "threshold must be >= 1");
  }

  async collect(req: AttestationRequest): Promise<Attestation[]> {
    const message = attestationMessage(req);
    const collected: Attestation[] = [];
    const seen = new Set<string>();

    // query endpoints; keep distinct, valid signatures until threshold is met
    const results = await Promise.allSettled(
      this.endpoints.map((e) => this.request(e, req)),
    );
    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value) continue;
      const att = r.value;
      const signerHex = toHex(att.signer);
      if (seen.has(signerHex)) continue;
      if (!verifyAttestation(message, att)) continue;
      seen.add(signerHex);
      collected.push(att);
      if (collected.length >= this.threshold) break;
    }

    if (collected.length < this.threshold)
      throw new ShieldError(
        "INSUFFICIENT_ATTESTATIONS",
        `collected ${collected.length}/${this.threshold} valid attestations`,
      );
    return collected;
  }

  private async request(
    endpoint: AttestorEndpoint,
    req: AttestationRequest,
  ): Promise<Attestation | null> {
    const res = await this.fetchImpl(`${endpoint.url}/attest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proofType: req.proofType,
        circuitVersion: req.circuitVersion,
        vkeyHash: toHex(req.vkeyHash),
        publicInputsHash: toHex(req.publicInputsHash),
        proof: toHex(req.proof),
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { signature: string; signer: string };
    const att: Attestation = {
      signature: fromHex(body.signature),
      signer: fromHex(body.signer),
    };
    if (endpoint.publicKey && !bytesEqual(endpoint.publicKey, att.signer)) return null;
    return att;
  }
}

/** Clarity list-of-attestations argument for a verify-proof / pool call. */
export function attestationsToClarity(atts: readonly Attestation[]) {
  return Cl.list(
    atts.map((a) =>
      Cl.tuple({ signature: Cl.buffer(a.signature), signer: Cl.buffer(a.signer) }),
    ),
  );
}
