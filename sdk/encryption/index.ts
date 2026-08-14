// =============================================================================
// STX Shield SDK -- encrypted note delivery
// =============================================================================
// A shielded note is only useful to its owner if they can find it. The chain
// stores an opaque commitment; the *contents* (amount, blinding, secret) must
// reach the receiver somehow. This module does that without any messaging
// channel, server, or link between sender and receiver.
//
//   sender knows receiver's viewing public key
//        -> ECDH to a shared secret (ephemeral key per note)
//        -> XChaCha20-Poly1305 encrypt the note payload
//        -> publish { ephemeralPk, ciphertext } alongside the commitment
//
//   receiver scans published payloads, trial-decrypts with their viewing key,
//   and recovers exactly the notes addressed to them.
//
// PRIVACY PROPERTIES
//   * The ephemeral public key is fresh per note, so two notes to the same
//     receiver share no on-chain value. Payloads are unlinkable to each other
//     and to the receiver.
//   * Trial decryption means the chain (and any observer) learns nothing about
//     who a payload is for. Only the holder of the viewing secret can tell.
//   * Failure to decrypt is silent and constant-shaped -- a wrong key yields
//     an auth failure, never a partial result.
//
// The viewing key is separate from the spending key: you can hand someone a
// viewing key to audit your notes without granting the ability to spend them.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "../utilities/crypto.js";
import type { Bytes, Bytes32 } from "../types.js";

/** Bytes of a serialized note payload, before encryption. */
export const NOTE_PAYLOAD_VERSION = 1;

/** Everything the receiver needs to own and later spend the note. */
export interface NotePayload {
  /** Payload format version, so the encoding can evolve. */
  version: number;
  /** micro-STX. */
  amount: bigint;
  /** Poseidon blinding factor. */
  blinding: bigint;
  /** The owner's spending secret for this note. */
  ownerSk: bigint;
  /** Per-note nonce, keeps two identical-value notes distinct. */
  nonce: bigint;
  /** The note commitment (the tree leaf), so the receiver can locate it. */
  commitment: Bytes32;
  /** Leaf index in the commitment tree, for Merkle proofs. */
  treePosition: number;
  /** SIP-10 asset uid this note belongs to. Absent/0 = native STX. Carried in
   *  the payload so a discovered note can rebuild its ASSET-BOUND commitment and
   *  nullifier. Additive within v1: legacy STX payloads omit it and decode as
   *  native, so existing notes stay fully readable. */
  assetId?: number;
}

/** A viewing keypair. X25519 — used ONLY for note discovery, never for spending. */
export interface ViewingKeyPair {
  secretKey: Bytes32;
  publicKey: Bytes32;
}

/** What gets published alongside the commitment. */
export interface EncryptedNote {
  /** Fresh per note; makes payloads mutually unlinkable. */
  ephemeralPublicKey: Bytes32;
  /** XChaCha20-Poly1305 nonce (24 bytes). */
  nonce: Bytes;
  /** Ciphertext + 16-byte Poly1305 tag. */
  ciphertext: Bytes;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export const generateViewingKeyPair = (secret?: Bytes32): ViewingKeyPair => {
  const secretKey = secret ?? x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
};

/** Derive the symmetric key. Hashing the raw ECDH output is required — the
 *  shared point is not uniformly random and must not be used as a key. */
const deriveKey = (shared: Bytes, ephemeralPk: Bytes32): Bytes32 => {
  const material = new Uint8Array(shared.length + ephemeralPk.length + 16);
  material.set(shared, 0);
  material.set(ephemeralPk, shared.length);
  material.set(enc.encode("stx-shield-note"), shared.length + ephemeralPk.length);
  return sha256(material);
};

const serialize = (p: NotePayload): Bytes =>
  enc.encode(
    JSON.stringify({
      v: p.version,
      a: p.amount.toString(),
      b: p.blinding.toString(),
      s: p.ownerSk.toString(),
      n: p.nonce.toString(),
      c: b2h(p.commitment),
      t: p.treePosition,
      // Only emit for SIP-10, so native STX payloads are byte-identical to v1.
      ...(p.assetId ? { i: p.assetId } : {}),
    }),
  );

const deserialize = (bytes: Bytes): NotePayload => {
  const o = JSON.parse(dec.decode(bytes)) as Record<string, string | number>;
  return {
    version: Number(o["v"]),
    amount: BigInt(o["a"] as string),
    blinding: BigInt(o["b"] as string),
    ownerSk: BigInt(o["s"] as string),
    nonce: BigInt(o["n"] as string),
    commitment: h2b(o["c"] as string),
    treePosition: Number(o["t"]),
    // Legacy STX payloads omit "i" -> undefined (native).
    assetId: o["i"] != null ? Number(o["i"]) : undefined,
  };
};

/**
 * Encrypt a note for `receiverViewingPk`. A fresh ephemeral key is generated
 * per call, so calling this twice for the same receiver produces two payloads
 * with nothing in common.
 */
export const encryptNote = (
  payload: NotePayload,
  receiverViewingPk: Bytes32,
  ephemeralSecret?: Bytes32,
): EncryptedNote => {
  const ephSk = ephemeralSecret ?? x25519.utils.randomSecretKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephSk);
  const shared = x25519.getSharedSecret(ephSk, receiverViewingPk);
  const key = deriveKey(shared, ephemeralPublicKey);

  // The AEAD nonce is derived from the ephemeral key, which is unique per
  // note — so key/nonce reuse cannot happen even if a caller reuses a secret.
  const nonce = sha256(ephemeralPublicKey).slice(0, 24);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(serialize(payload));
  return { ephemeralPublicKey, nonce, ciphertext };
};

/**
 * Try to decrypt. Returns null when the note is not ours — which is the normal
 * case while scanning, and must never throw or leak timing about *why*.
 */
export const tryDecryptNote = (
  note: EncryptedNote,
  viewingSecretKey: Bytes32,
): NotePayload | null => {
  try {
    const shared = x25519.getSharedSecret(viewingSecretKey, note.ephemeralPublicKey);
    const key = deriveKey(shared, note.ephemeralPublicKey);
    const plaintext = xchacha20poly1305(key, note.nonce).decrypt(note.ciphertext);
    const payload = deserialize(plaintext);
    if (payload.version !== NOTE_PAYLOAD_VERSION) return null;
    return payload;
  } catch {
    // Poly1305 auth failure: not addressed to us, or tampered with. Both are
    // "not ours" from the scanner's point of view.
    return null;
  }
};

/** Wire encoding: ephemeralPk (32) ‖ nonce (24) ‖ ciphertext. */
export const encodeEncryptedNote = (n: EncryptedNote): Bytes => {
  const out = new Uint8Array(32 + 24 + n.ciphertext.length);
  out.set(n.ephemeralPublicKey, 0);
  out.set(n.nonce, 32);
  out.set(n.ciphertext, 56);
  return out;
};

export const decodeEncryptedNote = (bytes: Bytes): EncryptedNote => {
  if (bytes.length < 57) throw new Error("encrypted note too short");
  return {
    ephemeralPublicKey: bytes.slice(0, 32),
    nonce: bytes.slice(32, 56),
    ciphertext: bytes.slice(56),
  };
};

// Browser- and Node-safe hex (no Node `Buffer`).
const b2h = (b: Bytes): string => {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
};
const h2b = (h: string): Bytes => {
  const s = h.length % 2 ? "0" + h : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const toHex = (b: Bytes): string => "0x" + b2h(b);
export const fromHex = (h: string): Bytes => h2b(h.replace(/^0x/, ""));
