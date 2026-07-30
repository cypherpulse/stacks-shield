// =============================================================================
// zk/attestations/aggregation -- signature aggregation & dedup
// =============================================================================
// Aggregates committee attestations into the exact list the contract accepts:
// distinct signers, each signature valid over the proof's attestation message,
// truncated to the threshold. Mirrors zk-verifier's on-chain tally, which
// counts a signer at most once (first occurrence) and only when the signature
// verifies — so a duplicate or invalid signature can never inflate the count.

import { verifySignature } from "../signatures/index.js";
import type { Attestation, Bytes32 } from "../../../sdk/types.js";

export interface AggregationResult {
  readonly attestations: readonly Attestation[];
  readonly validCount: number;
  readonly meetsThreshold: boolean;
}

/** Keep distinct, valid signatures over `message`, in submission order, up to
 *  `threshold`. Returns whether the threshold is met. */
export function aggregate(
  message: Bytes32,
  candidates: readonly Attestation[],
  threshold: number,
): AggregationResult {
  const kept: Attestation[] = [];
  const seen = new Set<string>();

  for (const att of candidates) {
    const signerHex = Buffer.from(att.signer).toString("hex");
    if (seen.has(signerHex)) continue; // first-occurrence only, like the contract
    if (!verifySignature(message, att.signature, att.signer)) continue;
    seen.add(signerHex);
    kept.push(att);
    if (kept.length >= threshold) break;
  }

  return {
    attestations: kept,
    validCount: kept.length,
    meetsThreshold: kept.length >= threshold,
  };
}
