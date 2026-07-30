// =============================================================================
// @stx-shield/sdk -- commitments & nullifiers (Poseidon)
// =============================================================================
// Matches the circuits and every proven e2e flow EXACTLY:
//   commitment      = Poseidon4(amount, ownerPkX, ownerPkY, blinding)
//   ownerCommitment = Poseidon2(ownerPkX, ownerPkY)
//   nullifier       = Poseidon2(commitment, ownerSk)
// Owner keys are GRUMPKIN and are derived by the proof engine (not here), since
// key derivation requires the embedded-curve operation the circuit checks.

import { poseidon2, poseidon4 } from "poseidon-lite";
import type { NoteSecret } from "../types/note.js";

export const commitmentOf = (s: { amount: bigint; ownerPkX: bigint; ownerPkY: bigint; blinding: bigint }): bigint =>
  BigInt(poseidon4([s.amount, s.ownerPkX, s.ownerPkY, s.blinding]));

export const ownerCommitmentOf = (s: { ownerPkX: bigint; ownerPkY: bigint }): bigint =>
  BigInt(poseidon2([s.ownerPkX, s.ownerPkY]));

export const nullifierOf = (commitment: bigint, ownerSk: bigint): bigint =>
  BigInt(poseidon2([commitment, ownerSk]));

export const commitmentOfSecret = (amount: bigint, s: NoteSecret): bigint =>
  commitmentOf({ amount, ownerPkX: s.ownerPkX, ownerPkY: s.ownerPkY, blinding: s.blinding });

/** A cryptographically-random blinding factor below the BN254 field modulus.
 *  Uses the Web Crypto API, available in browsers and Node >= 18. */
export const randomBlinding = (): bigint => {
  const bytes = new Uint8Array(31); // < 2^248 < p, always a valid field element
  globalThis.crypto.getRandomValues(bytes);
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x + 1n;
};
