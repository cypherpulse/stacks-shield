// =============================================================================
// One-shot: reset the indexer so it re-indexes the chain from scratch.
// =============================================================================
// Needed after a TESTNET RESET: the indexer cursor persists the last processed
// height from the OLD chain (e.g. 4058099), which is far above the fresh chain's
// tip — so the indexer thinks it is already caught up and indexes nothing, and
// the DB still serves stale old-chain commitments/roots. This clears the indexed
// tables and the cursor so the running indexer re-scans from INDEXER_START_HEIGHT
// on its next tick (or on restart). Auth (users/sessions) is left intact.
//
//   DATABASE_URL=... pnpm --filter @stx-shield/api db:reset-indexer
//   (or: cd services/api && tsx --env-file-if-exists=.env scripts/reset-indexer.ts)

import postgres from "postgres";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { onnotice: () => {} });

try {
  // Indexed chain state (safe to rebuild). Owner ciphertexts in `notes` are also
  // cleared — post-reset they reference dead-chain commitments and are re-created
  // by clients on their next sync.
  await sql`TRUNCATE notes, roots, aggregations, transactions, fees, stats RESTART IDENTITY`;
  await sql`DELETE FROM indexer_cursors`;
  console.log("✓ indexer reset: cleared notes/roots/aggregations/transactions/fees/stats + cursor.");
  console.log("  The indexer will re-scan from INDEXER_START_HEIGHT on its next tick / restart.");
} catch (e) {
  console.error("reset failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
