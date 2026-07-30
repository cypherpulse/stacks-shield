// =============================================================================
// STX Shield SDK -- nullifiers
// =============================================================================
// nullifier = Poseidon(note_commitment, owner_sk). Deterministic per note, so
// the same note always produces the same nullifier (double-spend detection),
// and only the owner (who knows owner_sk) can produce it.

import { bytes32ToField, poseidonHash2 } from "../utilities/crypto.js";
import { type Bytes32, type Note } from "../types.js";

export function computeNullifier(note: Note): Bytes32 {
  return poseidonHash2(bytes32ToField(note.commitment), note.ownerSk);
}
