// =============================================================================
// One-shot, idempotent migration: multi-asset (SIP-10) columns.
// =============================================================================
// Additive and backward-compatible with the native STX schema (all new columns
// are nullable / defaulted, existing rows are unaffected — NULL asset_id = STX).
// Mirrors migrate-status.ts (drizzle-kit push chokes on the whole schema).
//
//   DATABASE_URL=... pnpm --filter @stx-shield/api db:migrate:sip10
//   (or paste the SQL below into Neon's SQL editor.)

import postgres from "postgres";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { onnotice: () => {} });

try {
  // notes: per-commitment asset uid (NULL = native STX); root becomes nullable
  // (registry-only tree fills, e.g. SIP-10 split outputs, carry no root).
  await sql`ALTER TABLE notes ADD COLUMN IF NOT EXISTS asset_id integer`;
  await sql`ALTER TABLE notes ALTER COLUMN root DROP NOT NULL`;
  // transactions: per-operation asset uid (NULL = native STX) + index.
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS asset_id integer`;
  await sql`CREATE INDEX IF NOT EXISTS transactions_asset_idx ON transactions (asset_id)`;
  console.log("✓ notes.asset_id, notes.root nullable, transactions.asset_id (+ index) ensured");
} catch (e) {
  console.error("migration failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
