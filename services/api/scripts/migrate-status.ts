h// =============================================================================
// One-shot, idempotent migration: add notes.status (+ index).
// =============================================================================
// `drizzle-kit push` tries to reconcile the whole schema and chokes on the
// primary-key columns (Postgres error 42P16). This applies just the one change
// we need, safely re-runnable.
//
//   DATABASE_URL=... pnpm --filter @stx-shield/api db:migrate:status
//   (or run it against Neon's SQL editor — see the SQL below.)

import postgres from "postgres";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { onnotice: () => {} });

try {
  await sql`ALTER TABLE notes ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'confirmed'`;
  await sql`CREATE INDEX IF NOT EXISTS notes_status_idx ON notes (status)`;
  console.log("✓ notes.status column + notes_status_idx ensured");
} catch (e) {
  console.error("migration failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
