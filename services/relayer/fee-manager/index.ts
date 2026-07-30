// =============================================================================
// STX Shield relayer -- fee manager
// =============================================================================
// A relayer spends its own STX on transaction fees, so it needs a policy for
// which jobs are worth submitting and a guard against being drained.
//
// IMPORTANT: the relayer cannot deduct its fee from the user's shielded value
// — amounts are bound in the proof and the relayer cannot alter them. Relayer
// compensation is therefore an out-of-band arrangement (a prepaid balance, a
// subscription, a public-good subsidy, or the protocol's own RELAYER fee type
// once wired). The policy here is about SPEND CONTROL, not extraction.

import { RelayError } from "../types/index.js";

export interface FeePolicy {
  /** micro-STX the relayer pays per Stacks transaction. */
  txFeeMicroStx: number;
  /** Refuse new work below this balance so the relayer never strands jobs. */
  minBalanceMicroStx: bigint;
  /** Cap on transactions per rolling window, per client. */
  maxPerWindow: number;
  windowMs: number;
}

export const DEFAULT_POLICY: FeePolicy = {
  txFeeMicroStx: 10_000,
  minBalanceMicroStx: 1_000_000n,
  maxPerWindow: 30,
  windowMs: 60_000,
};

export class FeeManager {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly policy: FeePolicy = DEFAULT_POLICY) {}

  get txFee(): number {
    return this.policy.txFeeMicroStx;
  }

  /** Reject when the relayer can no longer fund submissions. Failing here is
   *  strictly better than accepting a job and silently never sending it. */
  assertFunded(balance: bigint): void {
    if (balance < this.policy.minBalanceMicroStx) {
      throw new RelayError(
        "relayer_underfunded",
        "relayer balance is too low to accept work; try another relayer",
        503,
      );
    }
  }

  /** Per-client rate limit. Cheap DoS protection — a relayer pays real STX
   *  for every submission, so unbounded intake is a funding attack. */
  assertWithinRate(clientKey: string): void {
    const now = Date.now();
    const window = now - this.policy.windowMs;
    const recent = (this.hits.get(clientKey) ?? []).filter((t) => t > window);
    if (recent.length >= this.policy.maxPerWindow) {
      throw new RelayError("rate_limited", "too many requests; try another relayer", 429);
    }
    recent.push(now);
    this.hits.set(clientKey, recent);
  }
}
