// =============================================================================
// @stacks-shield/sdk -- note store, shield address, discovery
// =============================================================================

import { sha256 } from "@noble/hashes/sha2.js";
import type { OwnerKey } from "../proving/engine.js";
import type { NoteSecret, ShieldNote } from "../types/note.js";
import {
  generateViewingKeyPair,
  tryDecryptNote,
  decodeEncryptedNote,
  type ViewingKeyPair,
} from "../crypto/encryption.js";
import { commitmentOfSecret, assetFieldOf } from "../crypto/commitments.js";
import { toHex32, bytesToHex, hexToBytes } from "../crypto/field.js";
import type { EncryptedNoteRecord } from "../providers/api.js";
import type { AssetInfo } from "../types/asset.js";
import { InvalidNoteError } from "../errors/index.js";

/** A shareable STX Shield address: the owner public key + viewing public key.
 *  A sender needs it to create a note for, and encrypt it to, the recipient. */
export interface ShieldAddress {
  ownerPkX: bigint;
  ownerPkY: bigint;
  viewingPk: Uint8Array;
}

const hex = (b: Uint8Array) => bytesToHex(b);
const bytesFrom = (h: string) => hexToBytes(h);

/** Encode a shield address as a single portable string. */
export const encodeAddress = (a: ShieldAddress): string =>
  "stxsh1" + toHex32(a.ownerPkX).slice(2) + toHex32(a.ownerPkY).slice(2) + hex(a.viewingPk);

export const decodeAddress = (s: string): ShieldAddress => {
  if (!s.startsWith("stxsh1")) throw new InvalidNoteError("not an STX Shield address");
  const body = s.slice(6);
  if (body.length !== 64 + 64 + 64) throw new InvalidNoteError("malformed STX Shield address");
  return {
    ownerPkX: BigInt("0x" + body.slice(0, 64)),
    ownerPkY: BigInt("0x" + body.slice(64, 128)),
    viewingPk: bytesFrom(body.slice(128)),
  };
};

/** Deterministically derive the user's viewing keypair from the shield secret. */
export const viewingKeyFromSecret = (secret: Uint8Array): ViewingKeyPair =>
  generateViewingKeyPair(sha256(concat(secret, new TextEncoder().encode("stx-shield-viewing"))));

const concat = (a: Uint8Array, b: Uint8Array) => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a, 0);
  o.set(b, a.length);
  return o;
};

/** In-memory store of spendable note secrets. Never persisted or transmitted. */
export class NoteStore {
  private readonly notes = new Map<string, ShieldNote>();

  add(note: ShieldNote): void {
    // A note that is spent locally OR per the record stays spent — a lagging
    // re-discovery must never resurrect a spent note.
    const prev = this.notes.get(note.commitment);
    const spent = note.spent || Boolean(prev?.spent);
    this.notes.set(note.commitment, spent === note.spent ? note : { ...note, spent });
  }
  get(commitment: string): ShieldNote | undefined {
    return this.notes.get(commitment);
  }
  markSpent(commitment: string): void {
    const n = this.notes.get(commitment);
    if (n) this.notes.set(commitment, { ...n, spent: true });
  }
  /** Forget a note entirely — used to roll back an optimistic note whose
   *  on-chain transaction reverted (so it never masquerades as spendable). */
  remove(commitment: string): void {
    this.notes.delete(commitment);
  }
  unspent(): ShieldNote[] {
    return [...this.notes.values()].filter((n) => !n.spent);
  }
  all(): ShieldNote[] {
    return [...this.notes.values()];
  }
}

/**
 * Discover the notes owned by `viewing` among the API's encrypted records:
 * trial-decrypt each ciphertext, keep the ones that decrypt. Amounts are
 * recovered locally; the server learns nothing.
 */
export const discoverNotes = (
  records: EncryptedNoteRecord[],
  viewing: ViewingKeyPair,
  owner: OwnerKey,
  /** Supported assets, so a discovered note's `assetId` (from its payload)
   *  resolves to its asset. Omit for STX-only (backward compatible). */
  assets: AssetInfo[] = [],
): ShieldNote[] => {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out: ShieldNote[] = [];
  for (const r of records) {
    if (!r.ciphertext) continue;
    let payload;
    try {
      payload = tryDecryptNote(decodeEncryptedNote(bytesFrom(r.ciphertext.replace(/^0x/, ""))), viewing.secretKey);
    } catch {
      continue;
    }
    if (!payload) continue;
    // Resolve the note's asset from the payload. Native STX (no assetId) and any
    // SIP-10 asset both work; an unknown assetId means we cannot form the
    // asset-bound commitment, so skip it (it is not spendable by us anyway).
    const asset = payload.assetId ? byId.get(payload.assetId) : undefined;
    if (payload.assetId && !asset) continue;
    const assetField = asset && !asset.native ? assetFieldOf(asset.token as string) : undefined;
    const secret: NoteSecret = {
      // The note is owned by whoever is decrypting it, so the spend key is THIS
      // user's owner secret — not the (possibly zero) value the sender embedded.
      // This is what lets a recipient spend an incoming transfer.
      ownerSk: owner.sk,
      ownerPkX: owner.pkX,
      ownerPkY: owner.pkY,
      blinding: payload.blinding,
      leafIndex: payload.treePosition,
      assetId: asset?.native ? undefined : asset?.id,
      assetField,
    };
    // Confirm the decrypted secret actually reproduces the on-chain (asset-bound)
    // commitment. Wrong asset ⇒ wrong commitment ⇒ skipped.
    if (toHex32(commitmentOfSecret(payload.amount, secret)) !== normalize(r.commitment)) continue;
    out.push({ commitment: r.commitment, ciphertext: r.ciphertext, root: r.root, txid: r.txid, amount: payload.amount, asset, spent: Boolean(r.spent), status: r.status, secret });
  }
  return out;
};

const normalize = (h: string) => (h.startsWith("0x") ? h : "0x" + h);
