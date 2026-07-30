// =============================================================================
// @stx-shield/sdk -- relayer provider (with failover)
// =============================================================================
// Submits operations so they land on chain from the relayer's address -- the
// user never appears. Tries relayers in order until one accepts, so a single
// censoring/offline relayer cannot strand the user.

import { RelayerError } from "../errors/index.js";
import { retry } from "../utils/retry.js";
import type { Logger } from "../utils/logger.js";
import type { Inclusion } from "../proving/engine.js";

export type RelayOp = "transfer" | "withdraw" | "split" | "merge";

const inclusionBody = (i: Inclusion) => ({
  domainId: i.domainId,
  aggregationId: i.aggregationId,
  merklePath: i.merklePath.map((p) => (p.startsWith("0x") ? p : "0x" + p)),
  leafIndex: i.leafIndex,
});

export interface RelayerProviderOptions {
  urls: string[];
  timeoutMs: number;
  logger: Logger;
}

export class RelayerProvider {
  constructor(private readonly opts: RelayerProviderOptions) {}

  /** Submit an operation and wait for it to confirm on chain. Returns txid. */
  async submit(op: RelayOp, params: Record<string, unknown>, inclusion: Inclusion): Promise<string> {
    const body = JSON.stringify({ ...params, inclusion: inclusionBody(inclusion) });
    let lastError: unknown;
    for (const url of this.opts.urls) {
      try {
        // The relayer publishes aggregation roots asynchronously; retry a few
        // times if the root is not on chain yet.
        const jobId = await retry(() => this.accept(url, op, body), {
          retries: 5,
          baseDelayMs: 2000,
          shouldRetry: (e) => e instanceof RelayerError && e.relayerCode === "aggregation_not_published",
        });
        return await this.await(url, jobId);
      } catch (e) {
        lastError = e;
        this.opts.logger.warn(`relayer ${url} failed for ${op}, trying next`, { code: (e as RelayerError).relayerCode });
      }
    }
    throw lastError instanceof RelayerError ? lastError : new RelayerError(`no relayer accepted ${op}`, undefined, lastError);
  }

  private async accept(url: string, op: RelayOp, body: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(`${url}/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal });
      const j = (await res.json().catch(() => ({}))) as any;
      if (res.status !== 202) throw new RelayerError(j?.message ?? `relayer ${op} -> ${res.status}`, j?.error);
      return j.jobId as string;
    } finally {
      clearTimeout(timer);
    }
  }

  private async await(url: string, jobId: string, timeoutMs = 20 * 60_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`${url}/status/${jobId}`);
      if (res.ok) {
        const s = (await res.json()) as { state: string; txid?: string; error?: string };
        if (s.state === "confirmed" && s.txid) return s.txid;
        if (s.state === "failed") throw new RelayerError(s.error ?? "relayed operation failed on chain");
      }
      await new Promise((r) => setTimeout(r, 8000));
    }
    throw new RelayerError("relayed operation timed out");
  }

  /** Whether at least one relayer is healthy + accepting. */
  async available(): Promise<boolean> {
    for (const url of this.opts.urls) {
      try {
        const res = await fetch(`${url}/ready`);
        if (res.ok) return true;
      } catch {
        /* try next */
      }
    }
    return false;
  }
}
