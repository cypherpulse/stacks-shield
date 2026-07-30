// =============================================================================
// STX Shield SDK -- crypto utilities
// =============================================================================
// Poseidon (BN254) hashing, field arithmetic, and byte/hex/field conversions.
// Poseidon MUST match the Noir circuits' std::hash::poseidon::bn254 and the
// on-chain note construction, so the SDK, circuits, and attestors all agree.

import { poseidon2, poseidon4 } from "poseidon-lite";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256.js";
import { BN254_FIELD_MODULUS, type Bytes, type Bytes32, type Hex } from "../types.js";

// @noble/hashes is isomorphic (Node + browser) and byte-identical to Node's
// crypto.createHash("sha256"), so the SDK runs unchanged in the browser.
export const sha256 = (data: Bytes): Bytes32 => new Uint8Array(nobleSha256(data));

/** keccak256 — the hash zkVerify's aggregation Merkle trees use, and the one
 *  `zk-verifier.clar` uses for statement leaves and path verification.
 *  NOT interchangeable with Node's `sha3-256`. */
export const keccak256 = (data: Bytes): Bytes32 =>
  new Uint8Array(keccak_256(data));

// Browser- and Node-safe hex helpers (no Node `Buffer`). Byte-identical output.
const bytesToHexStr = (b: Bytes): string => {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
};
const hexToBytesArr = (h: string): Bytes => {
  const s = h.length % 2 ? "0" + h : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const toHex = (b: Bytes): Hex => "0x" + bytesToHexStr(b);

export const fromHex = (h: Hex): Bytes => hexToBytesArr(h.replace(/^0x/, ""));

/** A field element as a big-endian 32-byte buffer. */
export const fieldToBytes32 = (f: bigint): Bytes32 => {
  const m = ((f % BN254_FIELD_MODULUS) + BN254_FIELD_MODULUS) % BN254_FIELD_MODULUS;
  return hexToBytesArr(m.toString(16).padStart(64, "0"));
};

export const bytes32ToField = (b: Bytes32): bigint =>
  BigInt("0x" + bytesToHexStr(b)) % BN254_FIELD_MODULUS;

/** Poseidon-2 over field elements, returned as a 32-byte value. */
export const poseidonHash2 = (a: bigint, b: bigint): Bytes32 =>
  fieldToBytes32(poseidon2([a, b]));

/** Poseidon-4 over field elements, returned as a 32-byte value. */
export const poseidonHash4 = (a: bigint, b: bigint, c: bigint, d: bigint): Bytes32 =>
  fieldToBytes32(poseidon4([a, b, c, d]));

/** Cryptographically random field element (for note blindings / secrets). */
export const randomField = (): bigint => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytes32ToField(bytes);
};

/** Constant-time-ish equality for 32-byte values. */
export const bytesEqual = (a: Bytes, b: Bytes): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
};

export const ZERO_HASH: Bytes32 = new Uint8Array(32);
