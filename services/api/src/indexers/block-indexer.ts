// =============================================================================
// STX Shield API -- block indexer (orchestrator)
// =============================================================================
// Polls the Hiro tip every BLOCK_POLL_MS. On a new tip it scans recent print
// events from the protocol contracts and dispatches them to the note, root and
// aggregation indexers, then refreshes statistics. All writes are idempotent,
// so overlapping re-scans never double count.

import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { indexerCursors } from "../db/schema.js";
import { config } from "../config.js";
import { getTipHeight, getContractEvents } from "../utils/hiro.js";
import { logger } from "../utils/logger.js";
import { decodeEvent, asInt } from "./decode.js";
import { handleNoteEvent } from "./note-indexer.js";
import { handleAggregationEvent } from "./aggregation-indexer.js";
import { handleRootFromEvent } from "./root-indexer.js";
import { refreshStats } from "./stats-indexer.js";

const CURSOR_ID = "block";
const PAGE = 50;
const MAX_PAGES = 40; // safety bound per contract per scan
const OVERLAP = 3; // re-scan a few blocks for ordering/reorg safety

const CONTRACTS = () => [config.contracts.privacyPool, config.contracts.splitMerge, config.contracts.zkVerifier];

const getCursor = async (): Promise<number> => {
  const [row] = await db.select().from(indexerCursors).where(eq(indexerCursors.id, CURSOR_ID));
  return row?.lastHeight ?? config.indexerStartHeight;
};

const setCursor = async (height: number): Promise<void> => {
  await db
    .insert(indexerCursors)
    .values({ id: CURSOR_ID, lastHeight: height })
    .onConflictDoUpdate({ target: indexerCursors.id, set: { lastHeight: height, updatedAt: sql`now()` } });
};

const dispatch = async (valueHex: string, txid: string): Promise<number | null> => {
  const decoded = decodeEvent(valueHex);
  if (!decoded) return null;
  await handleRootFromEvent(decoded, txid);
  if (!(await handleNoteEvent(decoded, txid))) {
    await handleAggregationEvent(decoded, txid);
  }
  return asInt(decoded.fields["height"]);
};

/** Scan one contract's recent events down to `sinceHeight`. Returns max height seen. */
const scanContract = async (contractId: string, sinceHeight: number): Promise<number> => {
  let maxHeight = sinceHeight;
  for (let page = 0; page < MAX_PAGES; page++) {
    const events = await getContractEvents(contractId, PAGE, page * PAGE);
    if (events.length === 0) break;
    let pageMin = Number.POSITIVE_INFINITY;
    for (const ev of events) {
      const h = await dispatch(ev.valueHex, ev.txId);
      if (h != null) {
        pageMin = Math.min(pageMin, h);
        maxHeight = Math.max(maxHeight, h);
      }
    }
    // Once an entire page is at or below what we already processed, stop.
    if (pageMin <= sinceHeight) break;
    if (events.length < PAGE) break;
  }
  return maxHeight;
};

/** One full scan across all protocol contracts. */
export const scanOnce = async (): Promise<{ tip: number; processedTo: number }> => {
  const tip = await getTipHeight();
  const cursor = await getCursor();
  const since = Math.max(0, cursor - OVERLAP);

  let processedTo = cursor;
  for (const contractId of CONTRACTS()) {
    try {
      const seen = await scanContract(contractId, since);
      processedTo = Math.max(processedTo, seen);
    } catch (e) {
      logger.warn({ contractId, err: String(e) }, "indexer: contract scan failed");
    }
  }

  await refreshStats();
  const newCursor = Math.max(cursor, Math.min(processedTo, tip));
  await setCursor(newCursor);
  return { tip, processedTo: newCursor };
};

/** Start the polling loop. Returns a stop() function. */
export const startBlockIndexer = (): (() => void) => {
  let stopped = false;
  let lastTip = -1;

  const tick = async () => {
    if (stopped) return;
    try {
      const tip = await getTipHeight();
      if (tip !== lastTip) {
        lastTip = tip;
        const res = await scanOnce();
        logger.debug({ tip: res.tip, processedTo: res.processedTo }, "indexer: scan complete");
      }
    } catch (e) {
      logger.warn({ err: String(e) }, "indexer: tick failed");
    } finally {
      if (!stopped) timer = setTimeout(tick, config.blockPollMs);
    }
  };

  let timer = setTimeout(tick, 0);
  logger.info({ everyMs: config.blockPollMs }, "indexer: started");
  return () => {
    stopped = true;
    clearTimeout(timer);
    logger.info("indexer: stopped");
  };
};
