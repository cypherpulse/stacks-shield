// =============================================================================
// STX Shield SDK -- commitments
// =============================================================================
// Note construction: builds a fully-specified Note (commitment + owner
// commitment) from an amount and an owner key. The commitment formula MUST
// match circuits/lib (Poseidon-4 over amount, owner_pk_x, owner_pk_y, blinding).

import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  bytes32ToField,
  poseidonHash2,
  poseidonHash4,
  randomField,
  bytes32ToField as toField,
} from "../utilities/crypto.js";
import { type Bytes32, type Note, ShieldError } from "../types.js";

/** An owner keypair. `sk` is the spending secret; `pkX/pkY` are the public
 *  point coordinates used inside the commitment. */
export interface OwnerKey {
  readonly sk: bigint;
  readonly pkX: bigint;
  readonly pkY: bigint;
}

/** Derive an owner key from a 32-byte secret (e.g. from the wallet). */
export function ownerKeyFromSecret(secret: Bytes32): OwnerKey {
  const sk = bytes32ToField(secret);
  if (sk === 0n) throw new ShieldError("BAD_SECRET", "owner secret is zero");
  const point = secp256k1.Point.BASE.multiply(sk);
  const affine = point.toAffine();
  return { sk, pkX: affine.x, pkY: affine.y };
}

/** Build a fresh note for `amount` uSTX owned by `owner`, with a random
 *  blinding. Deterministic given the blinding (pass one to reconstruct). */
export function createNote(
  amount: bigint,
  owner: OwnerKey,
  blinding: bigint = randomField(),
): Note {
  if (amount <= 0n) throw new ShieldError("BAD_AMOUNT", "note amount must be positive");
  if (amount >= 1n << 64n)
    throw new ShieldError("BAD_AMOUNT", "note amount exceeds 64 bits");
  const commitment = poseidonHash4(amount, owner.pkX, owner.pkY, blinding);
  const ownerCommitment = poseidonHash2(owner.pkX, owner.pkY);
  return {
    amount,
    ownerPkX: owner.pkX,
    ownerPkY: owner.pkY,
    ownerSk: owner.sk,
    blinding,
    commitment,
    ownerCommitment,
  };
}

/** The field-element view of a note commitment (for witness building). */
export const noteLeafField = (note: Note): bigint => toField(note.commitment);
