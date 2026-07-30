// =============================================================================
// STX Shield relayer -- root publication
// =============================================================================
//   zkVerify -> Aggregation -> Root -> Relayer -> zk-verifier.clar
//
// Publishing is IDEMPOTENT and multi-relayer safe: before submitting we check
// whether the aggregation is already posted on chain (get-aggregation). If it
// is -- because this or another relayer already published it -- we skip. This
// is what lets "Relayer A offline -> Relayer B publishes" work without
// coordination or double-posting.

import { Cl, cvToHex, cvToJSON, hexToCV } from "@stacks/transactions";
import type { TransactionManager } from "../transaction-manager/index.js";
import { metrics, M } from "../metrics/index.js";

const buf = (hex: string) => Cl.buffer(Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex")));

export interface AggregationRoot {
  domainId: number;
  aggregationId: number;
  root: string; // 0x-prefixed 32-byte hex
  leafCount: number;
}

/** True if zk-verifier already has this aggregation posted. */
export const isAggregationPosted = async (
  apiUrl: string,
  deployer: string,
  domainId: number,
  aggregationId: number,
): Promise<boolean> => {
  try {
    const res = await fetch(`${apiUrl}/v2/contracts/call-read/${deployer}/zk-verifier/get-aggregation`, {
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
 * Publish one aggregation root if not already on chain. Returns whether it was
 * published and the txid if so.
 */
export const publishRoot = async (
  txm: TransactionManager,
  apiUrl: string,
  deployer: string,
  agg: AggregationRoot,
): Promise<{ published: boolean; txid?: string; skipped?: boolean }> => {
  if (await isAggregationPosted(apiUrl, deployer, agg.domainId, agg.aggregationId)) {
    metrics.inc(M.rootsSkipped);
    return { published: false, skipped: true };
  }
  const txid = await txm.submitRaw("zk-verifier", "submit-aggregation", [
    Cl.uint(agg.domainId),
    Cl.uint(agg.aggregationId),
    buf(agg.root),
    Cl.uint(agg.leafCount),
  ]);
  metrics.inc(M.rootsPublished);
  return { published: true, txid };
};
