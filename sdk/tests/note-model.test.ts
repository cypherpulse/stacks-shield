// =============================================================================
// @stx-shield/sdk -- Phase 2: asset-aware note model tests
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  generateViewingKeyPair, encryptNote, tryDecryptNote,
  encodeEncryptedNote, decodeEncryptedNote, type NotePayload,
} from "../src/crypto/encryption.js";
import { isNativeRef } from "../src/types/asset.js";
import type { ShieldNote } from "../src/types/note.js";

const commitment = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const basePayload = (assetId?: number): NotePayload => ({
  version: 1, amount: 12_345n, blinding: 999n, ownerSk: 7n, nonce: 42n, commitment, treePosition: 3, assetId,
});

describe("note payload serialization", () => {
  it("round-trips a native STX note (no asset id)", () => {
    const vk = generateViewingKeyPair();
    const p = basePayload(undefined);
    const dec = tryDecryptNote(encryptNote(p, vk.publicKey), vk.secretKey);
    expect(dec).not.toBeNull();
    expect(dec!.amount).toBe(12_345n);
    expect(dec!.assetId).toBeUndefined(); // native
  });

  it("round-trips a SIP-10 note carrying its asset id", () => {
    const vk = generateViewingKeyPair();
    const dec = tryDecryptNote(encryptNote(basePayload(2), vk.publicKey), vk.secretKey);
    expect(dec).not.toBeNull();
    expect(dec!.assetId).toBe(2);
    expect(dec!.amount).toBe(12_345n);
  });

  it("is unreadable by a different viewing key", () => {
    const mine = generateViewingKeyPair(), other = generateViewingKeyPair();
    expect(tryDecryptNote(encryptNote(basePayload(1), mine.publicKey), other.secretKey)).toBeNull();
  });

  it("wire encoding is reversible", () => {
    const vk = generateViewingKeyPair();
    const enc = encryptNote(basePayload(1), vk.publicKey);
    const round = decodeEncryptedNote(encodeEncryptedNote(enc));
    expect(round.ephemeralPublicKey).toEqual(enc.ephemeralPublicKey);
    expect(round.ciphertext).toEqual(enc.ciphertext);
    expect(tryDecryptNote(round, vk.secretKey)!.assetId).toBe(1);
  });
});

describe("ShieldNote backward compatibility", () => {
  it("an existing STX note without an asset field is treated as native", () => {
    // Shape of a pre-multi-asset note: no `asset`, secret has no `assetId`.
    const stxNote: ShieldNote = {
      commitment: "0x" + "aa".repeat(32), ciphertext: "0x", root: "0x", txid: "0x",
      amount: 1_000_000n, spent: false,
      secret: { ownerSk: 1n, ownerPkX: 2n, ownerPkY: 3n, blinding: 4n },
    };
    expect(stxNote.asset).toBeUndefined();
    expect(isNativeRef(stxNote.asset)).toBe(true);
    expect(stxNote.secret.assetId).toBeUndefined();
  });
});
