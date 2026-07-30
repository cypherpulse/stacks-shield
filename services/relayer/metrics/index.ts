// =============================================================================
// STX Shield relayer -- metrics (in-process counters, Prometheus text format)
// =============================================================================

class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }
  set(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  snapshot(): { counters: Record<string, number>; gauges: Record<string, number> } {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
    };
  }

  /** Prometheus exposition format. */
  prometheus(): string {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`# TYPE ${k} counter`, `${k} ${v}`);
    for (const [k, v] of this.gauges) lines.push(`# TYPE ${k} gauge`, `${k} ${v}`);
    return lines.join("\n") + "\n";
  }
}

export const metrics = new Metrics();

export const M = {
  jobsAccepted: "relayer_jobs_accepted_total",
  jobsConfirmed: "relayer_jobs_confirmed_total",
  jobsFailed: "relayer_jobs_failed_total",
  jobsDeadLettered: "relayer_jobs_dead_lettered_total",
  txSubmitted: "relayer_tx_submitted_total",
  txRebroadcast: "relayer_tx_rebroadcast_total",
  rootsPublished: "relayer_roots_published_total",
  rootsSkipped: "relayer_roots_skipped_total",
  zkverifyPollErrors: "relayer_zkverify_poll_errors_total",
  relayerBalanceMicroStx: "relayer_balance_microstx",
} as const;
