// =============================================================================
// STX Shield API -- data access (read-only)
// =============================================================================
// Returns plain JSON-safe objects (no BigInt) for the routes.

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { aggregations, notes, roots, stats, transactions, fees } from "../db/schema.js";

const MICRO = 1_000_000;

// A pending, never-confirmed note this old is treated as failed (its tx almost
// certainly reverted or was dropped).
const STALE_PENDING_MS = 45 * 60 * 1000;
const deriveStatus = (status: string, root: string, createdAt: Date): string => {
  if (status !== "pending") return status;
  if (!root && Date.now() - createdAt.getTime() > STALE_PENDING_MS) return "failed";
  return "pending";
};

export const clampLimit = (v: unknown, def = 50, max = 200): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
};
export const clampOffset = (v: unknown): number => {
  const n = Number(v);
  return !Number.isFinite(n) || n < 0 ? 0 : Math.floor(n);
};

export const getStats = async () => {
  const [row] = await db.select().from(stats).where(eq(stats.id, "global"));
  const [feeRow] = await db.select().from(fees).where(eq(fees.id, "global"));
  return {
    shielded: row ? Number(row.shieldedStx) / MICRO : 0,
    notes: row?.notes ?? 0,
    operations: row?.operations ?? 0,
    users: row?.users ?? 0,
    fees: feeRow ? Number(feeRow.totalFees) / MICRO : 0,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
};

export const getFees = async () => {
  const [feeRow] = await db.select().from(fees).where(eq(fees.id, "global"));
  const micro = feeRow ? feeRow.totalFees : 0n;
  return { totalFeesMicroStx: micro.toString(), totalFeesStx: Number(micro) / MICRO };
};

/** Public encrypted-note feed for local trial-decryption (never reveals owners). */
export const getEncryptedNotes = async (limit: number, offset: number) => {
  const rows = await db
    .select({ commitment: notes.commitment, ciphertext: notes.ciphertext, root: notes.root, txid: notes.txid, status: notes.status, createdAt: notes.createdAt })
    .from(notes)
    .where(isNotNull(notes.ciphertext))
    .orderBy(desc(notes.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({ ...r, status: deriveStatus(r.status, r.root, r.createdAt), createdAt: r.createdAt.toISOString() }));
};

export const getRoots = async (limit: number, offset: number) => {
  const rows = await db.select().from(roots).orderBy(desc(roots.createdAt)).limit(limit).offset(offset);
  return rows.map(mapRoot);
};
export const getLatestRoot = async () => {
  const [row] = await db.select().from(roots).orderBy(desc(roots.createdAt)).limit(1);
  return row ? mapRoot(row) : null;
};
const mapRoot = (r: typeof roots.$inferSelect) => ({
  root: r.root,
  aggregationId: r.aggregationId != null ? r.aggregationId.toString() : null,
  height: r.height,
  txid: r.txid,
  createdAt: r.createdAt.toISOString(),
});

export const getAggregations = async (limit: number, offset: number) => {
  const rows = await db.select().from(aggregations).orderBy(desc(aggregations.createdAt)).limit(limit).offset(offset);
  return rows.map(mapAgg);
};
export const getAggregation = async (aggregationId: bigint) => {
  const [row] = await db.select().from(aggregations).where(eq(aggregations.aggregationId, aggregationId)).limit(1);
  return row ? mapAgg(row) : null;
};
const mapAgg = (a: typeof aggregations.$inferSelect) => ({
  aggregationId: a.aggregationId.toString(),
  domainId: a.domainId,
  root: a.root,
  leafCount: a.leafCount,
  published: a.published,
  height: a.height,
  txid: a.txid,
  createdAt: a.createdAt.toISOString(),
});

export const getTransactions = async (limit: number, offset: number, type?: string) => {
  const base = db.select().from(transactions).$dynamic();
  const rows = await (type ? base.where(eq(transactions.type, type)) : base)
    .orderBy(desc(transactions.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map(mapTx);
};
export const getTransaction = async (txid: string) => {
  // Accept the txid with or without the 0x prefix (txids are stored as Hiro
  // returns them, which is 0x-prefixed).
  const bare = txid.startsWith("0x") ? txid.slice(2) : txid;
  const [row] = await db
    .select()
    .from(transactions)
    .where(inArray(transactions.txid, [bare, "0x" + bare]))
    .limit(1);
  return row ? mapTx(row) : null;
};
const mapTx = (t: typeof transactions.$inferSelect) => ({
  txid: t.txid,
  type: t.type,
  aggregationId: t.aggregationId != null ? t.aggregationId.toString() : null,
  height: t.height,
  createdAt: t.createdAt.toISOString(),
});

// ---- per-wallet (authenticated) ----
export const getWalletNotes = async (wallet: string) => {
  const rows = await db
    .select({ commitment: notes.commitment, ciphertext: notes.ciphertext, root: notes.root, txid: notes.txid, type: notes.type, status: notes.status, spent: notes.spent, createdAt: notes.createdAt })
    .from(notes)
    .where(eq(notes.wallet, wallet))
    .orderBy(desc(notes.createdAt));
  return rows.map((r) => ({ ...r, status: deriveStatus(r.status, r.root, r.createdAt), createdAt: r.createdAt.toISOString() }));
};

export const getWalletHistory = async (wallet: string) => {
  // History is the wallet's own registered notes joined to their tx type.
  const rows = await db
    .select({ txid: notes.txid, type: notes.type, commitment: notes.commitment, createdAt: notes.createdAt })
    .from(notes)
    .where(eq(notes.wallet, wallet))
    .orderBy(desc(notes.createdAt));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
};

/** SDK registers an encrypted note it owns (authenticated). Idempotent per commitment. */
export const registerWalletNote = async (
  wallet: string,
  v: { commitment: string; ciphertext: string },
): Promise<{ updated: boolean }> => {
  const res = await db
    .update(notes)
    .set({ wallet, ciphertext: v.ciphertext })
    .where(and(eq(notes.commitment, v.commitment)))
    .returning({ id: notes.id });
  if (res.length > 0) return { updated: true };
  // Not yet indexed on chain -- store as a pending owner-supplied row.
  await db
    .insert(notes)
    .values({ commitment: v.commitment, ciphertext: v.ciphertext, wallet, root: "", txid: "", type: "shield", status: "pending" })
    .onConflictDoUpdate({ target: notes.commitment, set: { wallet, ciphertext: v.ciphertext } });
  return { updated: false };
};

export const markWalletNoteSpent = async (wallet: string, commitment: string): Promise<void> => {
  await db.update(notes).set({ spent: true }).where(and(eq(notes.wallet, wallet), eq(notes.commitment, commitment)));
};
