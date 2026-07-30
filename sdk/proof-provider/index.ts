// =============================================================================
// STX Shield SDK -- Proof provider
// =============================================================================
// A proof provider turns a witness into something the Stacks contracts will
// accept. Users never see this layer: `shield()`, `transfer()`, `split()`,
// `merge()`, and `withdraw()` are unchanged.
//
// v1 ships ZkVerifyProvider: circuits are compiled with Noir, proved with
// Barretenberg (UltraHonk), verified by zkVerify, and accepted on Stacks via
// a Merkle inclusion path against a published aggregation root.
//
// The interface exists so a future trustless provider -- one whose proof the
// Clarity verifier checks directly -- can be swapped in without touching the
// SDK's public API or any contract other than zk-verifier.

import type { ProofType } from "../types.js";

/** What the contracts need in order to accept an operation. Deliberately
 *  provider-agnostic: a future on-chain-verification provider would populate
 *  the same shape from different machinery. */
export interface InclusionProof {
  /** zkVerify domain the statement was aggregated under. */
  domainId: number;
  /** Aggregation (batch) id within that domain. */
  aggregationId: number;
  /** Sibling hashes from the statement leaf up to the aggregation root. */
  merklePath: Uint8Array[];
  /** Index of the statement leaf within the aggregation tree. */
  leafIndex: number;
  /** The statement leaf itself — keccak256(vkeyHash ‖ publicInputsHash).
   *  Recomputed on chain; carried here for client-side pre-checks. */
  leaf: Uint8Array;
}

export interface ProveRequest {
  proofType: ProofType;
  circuitVersion: number;
  /** Circuit inputs (private + public), already formatted for the circuit. */
  witness: Record<string, unknown>;
  /** The operation binding the contracts will recompute. The provider must
   *  ensure the accepted statement commits to exactly this value. */
  publicInputsHash: Uint8Array;
}

export interface ProofProvider {
  readonly name: string;
  /** Produce whatever the contracts need to accept this operation. Resolves
   *  only once the result is usable on Stacks. */
  prove(request: ProveRequest): Promise<InclusionProof>;
}

export { ZkVerifyProvider } from "./zkverify-provider.js";
export type { ZkVerifyProviderConfig } from "./zkverify-provider.js";
