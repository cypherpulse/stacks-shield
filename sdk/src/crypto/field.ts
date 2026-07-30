// =============================================================================
// @stx-shield/sdk -- canonical field encoding
// =============================================================================
// Re-exports the ONE canonical public-input encoding proven byte-identical
// across circuits, contracts, SDK and zkVerify. Never re-implement these.

export { feUint, fePrincipal, OP } from "../../public-inputs/index.js";

/** bigint -> 0x-prefixed 32-byte hex. */
export const toHex32 = (x: bigint): string => "0x" + x.toString(16).padStart(64, "0");

/** 0x-hex -> bigint. */
export const fromHex = (h: string): bigint => BigInt(h.startsWith("0x") ? h : "0x" + h);

// Browser- and Node-safe byte<->hex helpers (no Node `Buffer`).
export const bytesToHex = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
};
export const hexToBytes = (h: string): Uint8Array => {
  const raw = h.startsWith("0x") ? h.slice(2) : h;
  const s = raw.length % 2 ? "0" + raw : raw;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
export const bytesToBig = (b: Uint8Array): bigint => BigInt("0x" + (bytesToHex(b) || "0"));
