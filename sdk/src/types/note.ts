// =============================================================================
// @stx-shield/sdk -- note model
// =============================================================================

/**
 * A shielded note as seen by a developer. `amount` is decrypted LOCALLY from
 * the ciphertext and never leaves the device; the API only ever stores the
 * opaque `ciphertext`. The `secret` bag holds the material needed to spend the
 * note and MUST NOT be transmitted or logged -- the SDK keeps it in memory.
 */
export interface ShieldNote {
  /** On-chain commitment (Poseidon hash). Public. */
  commitment: string;
  /** Opaque encrypted payload stored by the API. Only the owner can read it. */
  ciphertext: string;
  /** Merkle root the note is anchored under. Public. */
  root: string;
  /** Transaction that created the note. Public. */
  txid: string;
  /** The note's value in micro-STX, decrypted locally. Private. */
  amount: bigint;
  /** True once the note has been spent (transfer/split/merge/withdraw). */
  spent: boolean;
  /** Secret material for spending. Local-only; never serialized to the wire. */
  readonly secret: NoteSecret;
}

/** Spendable secret material. Held only in memory; never sent anywhere. */
export interface NoteSecret {
  /** Owner spending secret (Grumpkin scalar). */
  ownerSk: bigint;
  /** Owner public point coordinates (Grumpkin). */
  ownerPkX: bigint;
  ownerPkY: bigint;
  /** Commitment blinding factor. */
  blinding: bigint;
  /** Leaf index in the commitment tree, when known. */
  leafIndex?: number;
}

/** A recipient of a private transfer: a viewing address the SDK can derive a
 *  note owner-key for. In practice this is a Stacks address or an exported
 *  STX Shield viewing key. */
export type Recipient = string;
