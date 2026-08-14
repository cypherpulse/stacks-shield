// =============================================================================
// STX Shield relayer -- root publication
// =============================================================================
//   zkVerify -> Aggregation -> Root -> Relayer -> zk-verifier.clar + sip10-zk-verifier.clar
//
// A published aggregation may contain native STX proofs (verified by
// zk-verifier) AND/OR SIP-10 proofs (verified by sip10-zk-verifier). The
// root-publisher polls zkVerify aggregations and does NOT know which proof types
// a given aggregation carries, so it publishes each root to BOTH verifiers. Each
// verifier keeps its own aggregations map; a proof only verifies against the
// verifier its pool calls, so the matching root must be present there.
//
// Publishing is IDEMPOTENT and multi-relayer safe: before submitting to a
// verifier we check whether the aggregation is already posted there
// (get-aggregation) and skip if so. This is what lets "Relayer A offline ->
// Relayer B publishes" work without coordination or double-posting.

import { Cl, cvToHex, cvToJSON, hexToCV } from "@stacks/transactions";
import type { TransactionManager } from "../transaction-manager/index.js";
import { metrics, M } from "../metrics/index.js";

const buf = (hex: string) => Cl.buffer(Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex")));

/** The verifiers a root is published to (native + SIP-10). */
export const VERIFIERS = ["zk-verifier", "sip10-zk-verifier"] as const;

export interface AggregationRoot {
  domainId: number;
  aggregationId: number;
  root: string; // 0x-prefixed 32-byte hex
  leafCount: number;
}

/** True if `verifier` already has this aggregation posted. */
export const isAggregationPosted = async (
  apiUrl: string,
  deployer: string,
  domainId: number,
  aggregationId: number,
  verifier: string = "zk-verifier",
): Promise<boolean> => {
  try {
    const res = await fetch(`${apiUrl}/v2/contracts/call-read/${deployer}/${verifier}/get-aggregation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: deployer,
        arguments: [cvToHex(Cl.uint(domainId)), cvToHex(Cl.uint(aggregationId))],
      }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { okay: boolean; result?: string };
    if (!body.okay || !body.result) return false;
    const j = cvToJSON(hexToCV(body.result)) as { value?: unknown };
    // (some { ... }) -> value present; (none) -> value null
    return j.value != null;
  } catch {
    return false;
  }
};

/**
 * Publish one aggregation root to BOTH verifiers, each idempotently. Returns
 * whether anything was published and the last txid.
 */
export const publishRoot = async (
  txm: TransactionManager,
  apiUrl: string,
  deployer: string,
  agg: AggregationRoot,
): Promise<{ published: boolean; txid?: string; skipped?: boolean }> => {
  let published = false;
  let txid: string | undefined;
  for (const verifier of VERIFIERS) {
    if (await isAggregationPosted(apiUrl, deployer, agg.domainId, agg.aggregationId, verifier)) {
      metrics.inc(M.rootsSkipped);
      continue;
    }
    try {
      txid = await txm.submitRaw(verifier, "submit-aggregation", [
        Cl.uint(agg.domainId),
        Cl.uint(agg.aggregationId),
        buf(agg.root),
        Cl.uint(agg.leafCount),
      ]);
      metrics.inc(M.rootsPublished);
      published = true;
    } catch (e) {
      // Already posted there (ERR-AGGREGATION-EXISTS u562) -> fine, keep going.
      // Any other error on one verifier must not block the other.
      if (!/u562|AGGREGATION-EXISTS/.test(e instanceof Error ? e.message : String(e))) {
        metrics.inc(M.rootsSkipped);
      }
    }
  }
  return { published, txid, skipped: !published };
};
