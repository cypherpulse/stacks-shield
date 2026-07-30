// =============================================================================
// zk/attestations/threshold -- committee threshold policy
// =============================================================================
// The supported M-of-N committee configurations and helpers to validate a
// threshold against a committee size. The on-chain threshold is set via
// zk-verifier.set-attestation-threshold and enforced in verify-proof; this
// module keeps the off-chain committee and the chain in agreement.

export interface ThresholdPolicy {
  readonly threshold: number; // M
  readonly committeeSize: number; // N
  readonly label: string; // e.g. "3-of-5"
}

export const SUPPORTED_POLICIES: readonly ThresholdPolicy[] = [
  { threshold: 1, committeeSize: 1, label: "1-of-1" },
  { threshold: 2, committeeSize: 3, label: "2-of-3" },
  { threshold: 3, committeeSize: 5, label: "3-of-5" },
  { threshold: 5, committeeSize: 7, label: "5-of-7" },
  { threshold: 7, committeeSize: 10, label: "7-of-10" },
];

export function policyFor(committeeSize: number): ThresholdPolicy {
  const p = SUPPORTED_POLICIES.find((x) => x.committeeSize === committeeSize);
  if (!p) throw new Error(`no supported threshold policy for committee size ${committeeSize}`);
  return p;
}

/** A threshold is valid iff 1 <= M <= N (matching the contract's guard). */
export function isValidThreshold(threshold: number, committeeSize: number): boolean {
  return threshold >= 1 && threshold <= committeeSize;
}
