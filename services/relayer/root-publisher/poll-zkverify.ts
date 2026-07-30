// =============================================================================
// STX Shield relayer -- zkVerify polling (root publication driver)
// =============================================================================
// Watches zkVerify for newly finalized aggregation receipts on the configured
// domain(s) and publishes their roots to zk-verifier.clar (idempotently, so
// multiple relayers coexist). This is the relayer's core liveness duty.
//
//   1. Fetch latest aggregation receipts.
//   2. Compare against on-chain state (publishRoot checks get-aggregation).
//   3. Publish missing roots.
//   4. Track processed ids to avoid rework.
//
// zkverifyjs is imported lazily so the relayer can run with root publication
// disabled (RELAYER_PUBLISH_ROOTS=false) and no zkVerify account.

import type { RelayerConfig } from "../config/index.js";
import type { TransactionManager } from "../transaction-manager/index.js";
import { publishRoot, type AggregationRoot } from "./publish-root.js";
import { metrics, M } from "../metrics/index.js";

type Logger = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };

/** Normalize a zkverifyjs aggregation receipt into our on-chain publish shape. */
const toAggregationRoot = (domainId: number, ev: Record<string, unknown>): AggregationRoot | null => {
  const aggregationId = Number(ev["aggregationId"] ?? ev["id"] ?? ev["aggregation_id"]);
  const root = (ev["receipt"] ?? ev["root"] ?? ev["aggregationRoot"]) as string | undefined;
  const leafCount = Number(ev["leaves"] ?? ev["numberOfLeaves"] ?? ev["size"] ?? 1);
  if (!Number.isFinite(aggregationId) || !root) return null;
  return {
    domainId,
    aggregationId,
    root: root.startsWith("0x") ? root : "0x" + root,
    leafCount: Number.isFinite(leafCount) && leafCount > 0 ? leafCount : 1,
  };
};

export class ZkVerifyPoller {
  private session: unknown;
  private stopped = false;
  private readonly seen = new Set<string>();

  constructor(
    private readonly cfg: RelayerConfig,
    private readonly txm: TransactionManager,
    private readonly log: Logger,
  ) {}

  private async publish(agg: AggregationRoot): Promise<void> {
    const key = `${agg.domainId}:${agg.aggregationId}`;
    if (this.seen.has(key)) return;
    try {
      const res = await publishRoot(this.txm, this.cfg.apiUrl, this.cfg.deployer, agg);
      this.seen.add(key);
      if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
      if (res.published) this.log.info({ ...agg, txid: res.txid }, "root published");
    } catch (e) {
      metrics.inc(M.zkverifyPollErrors);
      this.log.warn({ agg, err: String(e) }, "root publication failed");
    }
  }

  async start(): Promise<void> {
    if (!this.cfg.publishRoots) {
      this.log.info({}, "root publication disabled (RELAYER_PUBLISH_ROOTS=false)");
      return;
    }
    let zk: typeof import("zkverifyjs");
    try {
      zk = await import("zkverifyjs");
    } catch (e) {
      this.log.warn({ err: String(e) }, "zkverifyjs unavailable; root publication idle");
      return;
    }

    try {
      // zkverifyjs' fluent builder types vary across versions; drive it loosely.
      const start = zk.zkVerifySession.start() as unknown as Record<string, (...a: unknown[]) => unknown>;
      // Use the custom API endpoint only when ZKVERIFY_USE_API is on.
      const ep = this.cfg.zkVerifyUseApi ? this.cfg.zkVerifyEndpoint : undefined;
      const builder = (
        ep ? start["Custom"]?.({ websocket: ep }) : start["Volta"]?.()
      ) as Record<string, (...a: unknown[]) => Promise<unknown>>;
      this.session = this.cfg.zkVerifySeed
        ? await builder["withAccount"]!(this.cfg.zkVerifySeed)
        : await (builder["readOnly"] ? builder["readOnly"]() : builder["withAccount"]!());
    } catch (e) {
      this.log.warn({ err: String(e) }, "zkVerify session failed; root publication idle");
      return;
    }

    // Prefer event subscription when available; fall back to interval polling.
    const session = this.session as {
      subscribeToNewAggregationReceipts?: (
        cb: (ev: Record<string, unknown>) => void,
        filter?: { domainId?: number },
      ) => void;
      close?: () => Promise<void>;
    };

    if (this.cfg.zkVerifyUseSubscriptions && typeof session.subscribeToNewAggregationReceipts === "function") {
      for (const domainId of this.cfg.zkVerifyDomainIds) {
        session.subscribeToNewAggregationReceipts((ev) => {
          const agg = toAggregationRoot(domainId, ev);
          if (agg) void this.publish(agg);
        }, { domainId });
      }
      this.log.info({ domains: this.cfg.zkVerifyDomainIds }, "zkVerify: subscribed to aggregation receipts");
    } else {
      const why = this.cfg.zkVerifyUseSubscriptions ? "subscription API unavailable" : "subscriptions disabled";
      this.log.info({ everyMs: this.cfg.pollZkVerifyMs, why }, "zkVerify: polling for aggregation roots");
      void this.pollLoop();
    }
  }

  /** Fallback poll loop (interval-based) for zkverifyjs builds without events. */
  private async pollLoop(): Promise<void> {
    const session = this.session as {
      getLatestAggregationReceipts?: (domainId: number) => Promise<Record<string, unknown>[]>;
    };
    while (!this.stopped) {
      if (typeof session.getLatestAggregationReceipts === "function") {
        for (const domainId of this.cfg.zkVerifyDomainIds) {
          try {
            const receipts = await session.getLatestAggregationReceipts(domainId);
            for (const ev of receipts) {
              const agg = toAggregationRoot(domainId, ev);
              if (agg) await this.publish(agg);
            }
          } catch (e) {
            metrics.inc(M.zkverifyPollErrors);
            this.log.warn({ domainId, err: String(e) }, "zkVerify poll failed");
          }
        }
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollZkVerifyMs));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const session = this.session as { close?: () => Promise<void> } | undefined;
    if (session?.close) await session.close().catch(() => {});
  }
}
