// =============================================================================
// @stacks-shield/sdk -- commitments & nullifiers (Poseidon)
// =============================================================================
// Matches the circuits and every proven e2e flow EXACTLY.
//
//   native STX (privacy pool, zk/circuits/*):
//     commitment      = Poseidon4(amount, ownerPkX, ownerPkY, blinding)
//   SIP-10 (sip10-pool, zk/circuits/sip10/*): the note commitment BINDS the
//   asset, as a nested Poseidon (the arities the STX lib already uses):
//     inner           = Poseidon4(amount, ownerPkX, ownerPkY, blinding)
//     commitment      = Poseidon2(inner, assetField)
//   where assetField = fePrincipal(tokenPrincipal) (the same asset_id public
//   input the circuit and sip10-pool bind). A proof for asset A can never verify
//   for asset B: the commitment (and thus nullifier + tree membership) is a
//   function of assetField.
//
//   ownerCommitment = Poseidon2(ownerPkX, ownerPkY)   (asset-agnostic)
//   nullifier       = Poseidon2(commitment, ownerSk)  (asset-bound via commitment)
//
// Owner keys are GRUMPKIN and are derived by the proof engine (not here), since
// key derivation requires the embedded-curve operation the circuit checks.

import { poseidon2, poseidon4 } from "poseidon-lite";
import type { NoteSecret } from "../types/note.js";
import { fePrincipal, bytesToBig } from "./field.js";

/**
 * Note commitment. Pass `assetField` for a SIP-10 asset to get the asset-bound
 * nested commitment; omit it (or pass 0) for native STX — byte-for-byte the
 * original Poseidon4 form, so existing STX commitments are unchanged.
 */
export const commitmentOf = (s: {
  amount: bigint; ownerPkX: bigint; ownerPkY: bigint; blinding: bigint; assetField?: bigint;
}): bigint => {
  const inner = BigInt(poseidon4([s.amount, s.ownerPkX, s.ownerPkY, s.blinding]));
  return s.assetField ? BigInt(poseidon2([inner, s.assetField])) : inner;
};

/** The circuit/contract asset_id field element for a SIP-10 token principal. */
export const assetFieldOf = (tokenPrincipal: string): bigint => bytesToBig(fePrincipal(tokenPrincipal));

export const ownerCommitmentOf = (s: { ownerPkX: bigint; ownerPkY: bigint }): bigint =>
  BigInt(poseidon2([s.ownerPkX, s.ownerPkY]));

export const nullifierOf = (commitment: bigint, ownerSk: bigint): bigint =>
  BigInt(poseidon2([commitment, ownerSk]));

export const commitmentOfSecret = (amount: bigint, s: NoteSecret & { assetField?: bigint }): bigint =>
  commitmentOf({ amount, ownerPkX: s.ownerPkX, ownerPkY: s.ownerPkY, blinding: s.blinding, assetField: s.assetField });

/** A cryptographically-random blinding factor below the BN254 field modulus.
 *  Uses the Web Crypto API, available in browsers and Node >= 18. */
export const randomBlinding = (): bigint => {
  const bytes = new Uint8Array(31); // < 2^248 < p, always a valid field element
  globalThis.crypto.getRandomValues(bytes);
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x + 1n;
};
