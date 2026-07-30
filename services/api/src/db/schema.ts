// =============================================================================
// STX Shield API -- Drizzle schema (Phase 9)
// =============================================================================
// PRIVACY BOUNDARY: this database stores ONLY public chain facts plus opaque,
// client-supplied ciphertext. It never stores note amounts (for
// transfer/split/merge these never touch the chain), secrets, private keys,
// nullifier->commitment links, or Merkle paths. Shield/withdraw amounts are
// transparent on-chain values used only for aggregate statistics.

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

const now = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

/** A wallet that has authenticated at least once (message signing -> JWT). */
export const users = pgTable("users", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  wallet: text("wallet").notNull().unique(),
  createdAt: now(),
  lastLogin: timestamp("last_login", { withTimezone: true }).defaultNow().notNull(),
});

/** A one-time nonce a wallet must sign to authenticate. */
export const authNonces = pgTable(
  "auth_nonces",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    wallet: text("wallet").notNull(),
    nonce: text("nonce").notNull().unique(),
    used: boolean("used").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: now(),
  },
  (t) => [index("auth_nonces_wallet_idx").on(t.wallet)],
);

/** An issued JWT session; jwtId lets us revoke on logout. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    wallet: text("wallet").notNull(),
    jwtId: text("jwt_id").notNull().unique(),
    revoked: boolean("revoked").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: now(),
  },
  (t) => [index("sessions_wallet_idx").on(t.wallet)],
);

/**
 * An on-chain commitment. `wallet` and `ciphertext` are OPTIONAL and only ever
 * populated by the note's owner via an authenticated submission -- the indexer
 * never sets them, because the chain does not reveal who owns a commitment.
 */
export const notes = pgTable(
  "notes",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    commitment: text("commitment").notNull().unique(),
    ciphertext: text("ciphertext"),
    wallet: text("wallet"),
    root: text("root").notNull(),
    txid: text("txid").notNull(),
    leafIndex: integer("leaf_index"),
    type: text("type").notNull(), // shield | transfer | split | merge
    // pending  = owner registered the note but it is not yet observed on chain
    // confirmed = the indexer has seen the commitment on chain (root/txid filled)
    // failed    = a pending note whose tx never landed (derived when stale)
    // Default confirmed: indexer inserts are on-chain facts; only owner-supplied
    // pre-confirmation rows override this to "pending".
    status: text("status").notNull().default("confirmed"),
    spent: boolean("spent").notNull().default(false),
    createdAt: now(),
  },
  (t) => [
    index("notes_wallet_idx").on(t.wallet),
    index("notes_root_idx").on(t.root),
    index("notes_type_idx").on(t.type),
    index("notes_status_idx").on(t.status),
  ],
);

/** A historical commitment-tree root observed on chain. */
export const roots = pgTable("roots", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  root: text("root").notNull().unique(),
  aggregationId: bigint("aggregation_id", { mode: "bigint" }),
  height: integer("height"),
  txid: text("txid"),
  createdAt: now(),
});

/** A zkVerify aggregation whose root was posted on chain via zk-verifier. */
export const aggregations = pgTable(
  "aggregations",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    aggregationId: bigint("aggregation_id", { mode: "bigint" }).notNull(),
    domainId: integer("domain_id").notNull(),
    root: text("root").notNull(),
    leafCount: integer("leaf_count").notNull(),
    published: boolean("published").notNull().default(true),
    height: integer("height"),
    txid: text("txid"),
    createdAt: now(),
  },
  (t) => [uniqueIndex("aggregations_domain_agg_idx").on(t.domainId, t.aggregationId)],
);

/** A protocol transaction observed on chain. */
export const transactions = pgTable(
  "transactions",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    txid: text("txid").notNull().unique(),
    type: text("type").notNull(), // shield | transfer | split | merge | withdraw | aggregation
    aggregationId: bigint("aggregation_id", { mode: "bigint" }),
    height: integer("height"),
    createdAt: now(),
  },
  (t) => [index("transactions_type_idx").on(t.type)],
);

/** Running total of protocol fees (single row, id = "global"). */
export const fees = pgTable("fees", {
  id: text("id").primaryKey().default("global"),
  totalFees: bigint("total_fees", { mode: "bigint" }).notNull().default(sql`0`),
  createdAt: now(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Snapshot of protocol statistics (single row, id = "global"). */
export const stats = pgTable("stats", {
  id: text("id").primaryKey().default("global"),
  shieldedStx: bigint("shielded_stx", { mode: "bigint" }).notNull().default(sql`0`),
  notes: integer("notes").notNull().default(0),
  operations: integer("operations").notNull().default(0),
  users: integer("users").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Bookkeeping: last Stacks block height each indexer has processed. */
export const indexerCursors = pgTable("indexer_cursors", {
  id: text("id").primaryKey(), // e.g. "block"
  lastHeight: integer("last_height").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type NoteRow = typeof notes.$inferSelect;
export type AggregationRow = typeof aggregations.$inferSelect;
export type RootRow = typeof roots.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
