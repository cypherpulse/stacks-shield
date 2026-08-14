// =============================================================================
// @stacks-shield/sdk -- operation response types
// =============================================================================

import type { ShieldNote } from "./note.js";

export type OperationStatus = "confirmed" | "pending" | "failed";

interface BaseResponse {
  /** Stacks transaction id of the operation. */
  txid: string;
  /** Final (or last-known) status. */
  status: OperationStatus;
  /** Unix milliseconds when the SDK observed completion. */
  timestamp: number;
}

/** Result of `shield(amount)`. Returns the freshly created note. */
export interface ShieldResponse extends BaseResponse {
  note: ShieldNote;
}

/** Result of `transfer(amount, recipient)`. The recipient's note is theirs to
 *  discover; the sender may receive a change note if the amount was partial. */
export interface TransferResponse extends BaseResponse {
  change?: ShieldNote;
}

/** Result of `split(note, amounts)`. Returns the new notes. */
export interface SplitResponse extends BaseResponse {
  notes: ShieldNote[];
}

/** Result of `merge(notes)`. Returns the single merged note. */
export interface MergeResponse extends BaseResponse {
  note: ShieldNote;
}

/** Result of `withdraw(note)`. Funds land at `recipient` (transparent). */
export interface WithdrawResponse extends BaseResponse {
  recipient: string;
  /** Amount received after the protocol withdraw fee, in micro-STX. */
  amountReceived: bigint;
}

/** Protocol statistics from the public API. */
export interface Stats {
  shielded: number;
  notes: number;
  operations: number;
  users: number;
  fees: number;
}

/** A single history entry for the authenticated wallet. */
export interface HistoryEntry {
  txid: string;
  type: "shield" | "transfer" | "split" | "merge" | "withdraw";
  commitment?: string;
  createdAt: string;
}
