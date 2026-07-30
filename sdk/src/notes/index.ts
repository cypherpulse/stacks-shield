// =============================================================================
// @stx-shield/sdk -- note store, shield address, discovery
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
import { commitmentOfSecret } from "../crypto/commitments.js";
import { toHex32, bytesToHex, hexToBytes } from "../crypto/field.js";
import type { EncryptedNoteRecord } from "../providers/api.js";
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
    this.notes.set(note.commitment, note);
  }
  get(commitment: string): ShieldNote | undefined {
    return this.notes.get(commitment);
  }
  markSpent(commitment: string): void {
    const n = this.notes.get(commitment);
    if (n) this.notes.set(commitment, { ...n, spent: true });
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
): ShieldNote[] => {
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
    const secret: NoteSecret = {
      ownerSk: payload.ownerSk,
      ownerPkX: owner.pkX,
      ownerPkY: owner.pkY,
      blinding: payload.blinding,
      leafIndex: payload.treePosition,
    };
    // Confirm the decrypted secret actually reproduces the on-chain commitment.
    if (toHex32(commitmentOfSecret(payload.amount, secret)) !== normalize(r.commitment)) continue;
    out.push({ commitment: r.commitment, ciphertext: r.ciphertext, root: r.root, txid: r.txid, amount: payload.amount, spent: false, status: r.status, secret });
  }
  return out;
};

const normalize = (h: string) => (h.startsWith("0x") ? h : "0x" + h);
