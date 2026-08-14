import { MICRO_PER_STX } from "@/shared/constants/protocol";
import type { ShieldNote } from "@/shared/types/shield";

/** Normalizes a note amount (bigint µSTX or number STX) into STX. */
export function toStx(amount: bigint | number | undefined | null): number {
  if (amount === undefined || amount === null) return 0;
  if (typeof amount === "bigint") return Number(amount) / MICRO_PER_STX;
  // Numbers coming back from the SDK are STX already unless they are huge.
  return amount >= MICRO_PER_STX ? amount / MICRO_PER_STX : amount;
}

// --- Asset-aware helpers (multi-asset: STX, sBTC, USDCx …) -------------------
// A note's `amount` is in its asset's base units (bigint); different assets have
// different decimals (STX/USDCx = 6, sBTC = 8), so denomination MUST go through
// the note's asset — never the STX-only `toStx` heuristic.

/** Base units (bigint, or a number already in base units) → display value. */
export function unitsToDisplay(
  amount: bigint | number | undefined | null,
  decimals: number,
): number {
  if (amount === undefined || amount === null) return 0;
  const n = typeof amount === "bigint" ? Number(amount) : amount;
  return n / 10 ** decimals;
}

/** The asset a note holds (defaults to native STX for legacy/undefined). */
export function noteAsset(note: Pick<ShieldNote, "asset">): { symbol: string; decimals: number } {
  return { symbol: note.asset?.symbol ?? "STX", decimals: note.asset?.decimals ?? 6 };
}

/** A note's value as a display number, denominated in its own asset. */
export function noteDisplay(note: ShieldNote): number {
  return unitsToDisplay(note.amount, noteAsset(note).decimals);
}

/** Format a display value with an asset symbol, e.g. "200,000 sBTC". */
export function amountLabel(value: number, symbol: string, digits = 8): string {
  return `${(value || 0).toLocaleString(undefined, { maximumFractionDigits: digits })} ${symbol}`;
}

/** A note's value formatted with its own asset symbol. */
export function noteLabel(note: ShieldNote): string {
  const { symbol, decimals } = noteAsset(note);
  return amountLabel(noteDisplay(note), symbol, Math.min(decimals, 8));
}

/** Do two notes hold the same asset? (both undefined ⇒ native STX ⇒ true) */
export function sameAsset(a: Pick<ShieldNote, "asset">, b: Pick<ShieldNote, "asset">): boolean {
  return noteAsset(a).symbol === noteAsset(b).symbol;
}

/** Format a USD value in full, e.g. "$12,627,600,000.00" (never abbreviated). */
export function formatUsd(value: number | undefined | null): string {
  return (value ?? 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export function formatStx(amount: bigint | number | undefined | null, digits = 6): string {
  const value = toStx(amount);
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })} STX`;
}

/** Format a value that is ALREADY in STX (e.g. a computed net/fee, or a value
 *  that already went through `toStx`). Unlike `formatStx`, it does NOT re-apply
 *  the µSTX heuristic, so amounts ≥ 1,000,000 STX are not wrongly divided. */
export function stxLabel(value: number, digits = 6): string {
  return `${(value || 0).toLocaleString(undefined, { maximumFractionDigits: digits })} STX`;
}

export function formatNumber(value: number | undefined | null): string {
  return (value ?? 0).toLocaleString();
}

export function truncate(value: string | undefined | null, head = 6, tail = 4): string {
  if (!value) return "—";
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatDate(value: string | number | undefined | null): string {
  if (!value) return "—";
  const date = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(value: string | number | undefined | null): string {
  if (!value) return "—";
  const date = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  const diff = Date.now() - date.getTime();
  if (Number.isNaN(diff)) return "—";
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function noteKey(
  note: { id?: string; commitment?: string; amount: bigint | number },
  index = 0,
): string {
  return note.id ?? note.commitment ?? `note-${index}-${String(note.amount)}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong. Please try again.";
}
