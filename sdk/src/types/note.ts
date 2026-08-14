// =============================================================================
// @stacks-shield/sdk -- note model
// =============================================================================

import type { AssetInfo } from "./asset.js";

/**
 * A shielded note as seen by a developer. `amount` is decrypted LOCALLY from
 * the ciphertext and never leaves the device; the API only ever stores the
 * opaque `ciphertext`. The `secret` bag holds the material needed to spend the
 * note and MUST NOT be transmitted or logged -- the SDK keeps it in memory.
 *
 * Multi-asset: a note carries its `asset`. For native STX notes `asset` is
 * undefined (or the STX AssetInfo) and `amount` is micro-STX; for SIP-10 notes
 * `asset` is the token's AssetInfo and `amount` is in that token's base units.
 * Existing STX notes (no asset field) remain valid and are treated as native.
 */
export interface ShieldNote {
  /** On-chain commitment (Poseidon hash, asset-bound for SIP-10). Public. */
  commitment: string;
  /** Opaque encrypted payload stored by the API. Only the owner can read it. */
  ciphertext: string;
  /** Merkle root the note is anchored under. Public. */
  root: string;
  /** Transaction that created the note. Public. */
  txid: string;
  /** The note's value in the asset's base units (micro-STX for native), decrypted locally. Private. */
  amount: bigint;
  /** The asset this note holds. Undefined ⇒ native STX (backward compatible). */
  asset?: AssetInfo;
  /** True once the note has been spent (transfer/split/merge/withdraw). */
  spent: boolean;
  /** On-chain confirmation state: "pending" | "confirmed" | "failed".
   *  Undefined for locally-created notes not yet re-fetched from the API. */
  status?: string;
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
  /** SIP-10 asset uid this note belongs to (matches the encrypted payload).
   *  Undefined ⇒ native STX. */
  assetId?: number;
  /** The circuit asset_id field element (= fePrincipal(token)) for recomputing
   *  this note's ASSET-BOUND commitment/nullifier when spending. Undefined ⇒
   *  native STX (plain Poseidon4). */
  assetField?: bigint;
}

/** A recipient of a private transfer: a viewing address the SDK can derive a
 *  note owner-key for. In practice this is a Stacks address or an exported
 *  STX Shield viewing key. */
export type Recipient = string;
