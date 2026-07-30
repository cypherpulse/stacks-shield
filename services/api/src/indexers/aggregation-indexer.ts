// =============================================================================
// STX Shield API -- aggregation indexer
// =============================================================================
// Tracks zkVerify aggregation roots posted on chain via zk-verifier's
// `aggregation-posted` event, plus the `proof-verified` marker.

import type { DecodedEvent } from "./decode.js";
import { asHex, asInt, asBig } from "./decode.js";
import { upsertAggregation, upsertRoot, recordTransaction } from "./store.js";

export const AGGREGATION_EVENTS = new Set(["aggregation-posted", "proof-verified"]);

/** Handle an aggregation-related event. Returns true if it was one. */
export const handleAggregationEvent = async (ev: DecodedEvent, txid: string): Promise<boolean> => {
  const f = ev.fields;
  if (ev.event === "aggregation-posted") {
    const aggregationId = asBig(f["aggregation-id"]);
    const domainId = asInt(f["domain-id"]);
    const root = asHex(f["root"]);
    const leafCount = asInt(f["leaf-count"]);
    const height = asInt(f["height"]);
    if (aggregationId != null && domainId != null && root && leafCount != null) {
      await upsertAggregation({ aggregationId, domainId, root, leafCount, height, txid });
      await upsertRoot(root, { height, txid, aggregationId });
      await recordTransaction({ txid, type: "aggregation", height, aggregationId });
    }
    return true;
  }
  if (ev.event === "proof-verified") {
    // Marker only -- the operation tx itself is indexed by the note indexer.
    return true;
  }
  return false;
};
