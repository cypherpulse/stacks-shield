// =============================================================================
// STX Shield API -- root indexer
// =============================================================================
// Tracks every historical commitment-tree root observed on chain. Roots appear
// as `new-root` in note events and as `root` in aggregation-posted events; the
// note and aggregation indexers already upsert those. This module additionally
// backfills any root-carrying event and exposes a direct handler.

import type { DecodedEvent } from "./decode.js";
import { asHex, asInt } from "./decode.js";
import { upsertRoot } from "./store.js";

/** Upsert a root from any event that carries `new-root` or `root`. */
export const handleRootFromEvent = async (ev: DecodedEvent, txid: string): Promise<void> => {
  const height = asInt(ev.fields["height"]);
  const newRoot = asHex(ev.fields["new-root"]);
  if (newRoot) await upsertRoot(newRoot, { height, txid });
  // aggregation-posted carries `root`; handled by the aggregation indexer with
  // its aggregation id, so we do not duplicate it here.
};
