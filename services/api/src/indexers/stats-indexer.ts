// =============================================================================
// STX Shield API -- statistics indexer
// =============================================================================
// Recomputes the single stats snapshot from authoritative sources: total
// shielded STX from the pool contract (read-only), and counts from the DB.
// Never derives per-note amounts.

import { sql } from "drizzle-orm";
import { cvToJSON, hexToCV } from "@stacks/transactions";
import { db } from "../db/client.js";
import { notes, transactions, users, stats } from "../db/schema.js";
import { config } from "../config.js";
import { callReadOnly } from "../utils/hiro.js";
import { logger } from "../utils/logger.js";

const readPoolBalance = async (): Promise<bigint> => {
  try {
    const hex = await callReadOnly(config.contracts.privacyPool, "get-pool-balance");
    if (!hex) return 0n;
    const j = cvToJSON(hexToCV(hex)) as { value?: string };
    return j.value != null ? BigInt(j.value) : 0n;
  } catch (e) {
    logger.warn({ err: String(e) }, "stats: pool balance read failed");
    return 0n;
  }
};

const count = async (table: typeof notes | typeof transactions | typeof users): Promise<number> => {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
  return r?.n ?? 0;
};

/** Recompute and persist the global stats row. */
export const refreshStats = async (): Promise<void> => {
  const shielded = await readPoolBalance();
  const noteCount = await count(notes);
  const opCount = await count(transactions);
  const userCount = await count(users);

  await db
    .insert(stats)
    .values({
      id: "global",
      shieldedStx: shielded,
      notes: noteCount,
      operations: opCount,
      users: userCount,
    })
    .onConflictDoUpdate({
      target: stats.id,
      set: {
        shieldedStx: shielded,
        notes: noteCount,
        operations: opCount,
        users: userCount,
        updatedAt: sql`now()`,
      },
    });
};
