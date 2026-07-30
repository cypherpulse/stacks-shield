// =============================================================================
// STX Shield API -- idempotent write helpers for indexers
// =============================================================================
// Every write is idempotent (unique constraints + onConflictDoNothing) so the
// indexer can safely re-scan overlapping event windows without double counting.

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes, roots, aggregations, transactions, fees } from "../db/schema.js";

/** Upsert a historical root (first writer wins for aggregation/height/txid). */
export const upsertRoot = async (
  root: string,
  opts: { height?: number | null; txid?: string | null; aggregationId?: bigint | null } = {},
): Promise<void> => {
  await db
    .insert(roots)
    .values({
      root,
      height: opts.height ?? null,
      txid: opts.txid ?? null,
      aggregationId: opts.aggregationId ?? null,
    })
    .onConflictDoNothing({ target: roots.root });
};

/** Insert a note/commitment row (indexer never sets wallet/ciphertext). */
export const insertNote = async (v: {
  commitment: string;
  root: string;
  txid: string;
  leafIndex: number | null;
  type: "shield" | "transfer" | "split" | "merge";
}): Promise<void> => {
  // The commitment is now an on-chain fact. If an owner pre-registered it while
  // pending, fill in root/txid/leafIndex and flip it to confirmed -- WITHOUT
  // touching their ciphertext/wallet. If it already exists confirmed, this is a
  // harmless idempotent re-set.
  await db
    .insert(notes)
    .values({ ...v, status: "confirmed" })
    .onConflictDoUpdate({
      target: notes.commitment,
      set: { root: v.root, txid: v.txid, leafIndex: v.leafIndex, type: v.type, status: "confirmed" },
    });
};

/**
 * Record a transaction exactly once. On first insert, add its fee to the
 * running fees total (idempotent because subsequent inserts conflict).
 * Returns true if this was a new transaction.
 */
export const recordTransaction = async (v: {
  txid: string;
  type: string;
  height: number | null;
  feeMicro?: bigint | null;
  aggregationId?: bigint | null;
}): Promise<boolean> => {
  const inserted = await db
    .insert(transactions)
    .values({
      txid: v.txid,
      type: v.type,
      height: v.height,
      aggregationId: v.aggregationId ?? null,
    })
    .onConflictDoNothing({ target: transactions.txid })
    .returning({ id: transactions.id });

  const isNew = inserted.length > 0;
  if (isNew && v.feeMicro && v.feeMicro > 0n) {
    await db
      .insert(fees)
      .values({ id: "global", totalFees: v.feeMicro })
      .onConflictDoUpdate({
        target: fees.id,
        set: { totalFees: sql`${fees.totalFees} + ${v.feeMicro}`, updatedAt: sql`now()` },
      });
  }
  return isNew;
};

/** Upsert a zkVerify aggregation whose root was posted on chain. */
export const upsertAggregation = async (v: {
  aggregationId: bigint;
  domainId: number;
  root: string;
  leafCount: number;
  height: number | null;
  txid: string | null;
}): Promise<void> => {
  await db
    .insert(aggregations)
    .values({ ...v, published: true })
    .onConflictDoNothing({ target: [aggregations.domainId, aggregations.aggregationId] });
};
