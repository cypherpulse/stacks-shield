// =============================================================================
// STX Shield API -- Clarity print-event decoder
// =============================================================================
// Turns a serialized Clarity tuple (the `(print { event: ... })` payload) into
// a flat JS object. Only the frozen protocol's known event shapes are handled.

import { hexToCV, cvToJSON } from "@stacks/transactions";

export interface DecodedEvent {
  event: string;
  fields: Record<string, string | number | bigint | boolean | null>;
}

/** Recursively flatten a cvToJSON node into a primitive. */
const flatten = (node: unknown): string | number | bigint | boolean | null => {
  if (node == null) return null;
  const n = node as { type?: string; value?: unknown };
  if (n.value === undefined) return null;
  const t = n.type ?? "";
  if (t.startsWith("uint") || t.startsWith("int")) return BigInt(n.value as string);
  if (t.startsWith("(buff")) return n.value as string; // "0x..."
  if (t === "bool") return n.value as boolean;
  if (t.startsWith("principal")) return n.value as string;
  if (t.startsWith("(string")) return n.value as string;
  return typeof n.value === "object" ? JSON.stringify(n.value) : (n.value as string);
};

/**
 * Decode a serialized print tuple. Returns null if it is not an event tuple
 * (e.g. a non-print contract log) or does not carry an `event` string.
 */
export const decodeEvent = (valueHex: string): DecodedEvent | null => {
  let json: { type?: string; value?: Record<string, unknown> };
  try {
    json = cvToJSON(hexToCV(valueHex)) as typeof json;
  } catch {
    return null;
  }
  if (!json.value || typeof json.value !== "object" || Array.isArray(json.value)) return null;

  const raw = json.value as Record<string, unknown>;
  const eventNode = raw["event"] as { value?: unknown } | undefined;
  if (!eventNode || typeof eventNode.value !== "string") return null;

  const fields: DecodedEvent["fields"] = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "event") continue;
    fields[k] = flatten(v);
  }
  return { event: eventNode.value, fields };
};

/** Helpers to coerce decoded fields. */
export const asHex = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const asInt = (v: unknown): number | null =>
  typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : null;
export const asBig = (v: unknown): bigint | null =>
  typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : null;
