// =============================================================================
// STX Shield SDK -- fee calculation
// =============================================================================
// Mirrors protocol-fees.calculate-fee exactly (flat + percentage clamped to
// the registry's live max-fee-bps, floor rounding). Read live config from the
// chain, then compute quotes locally without a round-trip.

import { FeeType } from "../types.js";

export const BPS_DENOMINATOR = 10_000n;

export interface FeeConfig {
  readonly bps: bigint;
  readonly flat: bigint;
  readonly enabled: boolean;
}

/** The fee charged for `amount` under `config`, given the live registry
 *  ceiling `maxFeeBps`. Matches the contract's floor-rounded arithmetic. */
export function calculateFee(
  config: FeeConfig,
  amount: bigint,
  maxFeeBps: bigint,
): bigint {
  if (!config.enabled) return 0n;
  const effectiveBps = config.bps > maxFeeBps ? maxFeeBps : config.bps;
  return config.flat + (amount * effectiveBps) / BPS_DENOMINATOR;
}

/** Net amount a withdrawal recipient receives after the withdrawal fee. */
export function withdrawalNet(
  amount: bigint,
  withdrawalConfig: FeeConfig,
  maxFeeBps: bigint,
): bigint {
  const fee = calculateFee(withdrawalConfig, amount, maxFeeBps);
  if (fee >= amount) throw new Error("fee exceeds withdrawal amount");
  return amount - fee;
}

export { FeeType };
