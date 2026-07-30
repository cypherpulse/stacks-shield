// =============================================================================
// zk/barretenberg/configuration -- Barretenberg / UltraHonk runtime config
// =============================================================================
// Central knobs for the proving backend, per environment. Kept separate so
// production and test runs share one prover implementation with different
// resource settings.

export interface BarretenbergConfig {
  /** worker threads for proof generation (0 = auto = hardwareConcurrency). */
  readonly threads: number;
  /** UltraHonk with keccak-flavored transcript for on-chain-friendly hashing. */
  readonly flavor: "ultra_honk" | "ultra_keccak_honk";
  /** enable the CRS (structured reference string) download cache path. */
  readonly crsPath?: string;
  /** memory ceiling hint (MiB) for the wasm heap. */
  readonly memoryLimitMb: number;
}

export const PRODUCTION_CONFIG: BarretenbergConfig = {
  threads: 0,
  flavor: "ultra_keccak_honk",
  memoryLimitMb: 4096,
};

export const TEST_CONFIG: BarretenbergConfig = {
  threads: 1,
  flavor: "ultra_keccak_honk",
  memoryLimitMb: 1024,
};

/** UltraHonk proof byte length is fixed per circuit; registered on-chain as
 *  the vkey `proof-length`. Filled from `bb` after the first proof and pinned
 *  here so the SDK and verifier agree without a round-trip. */
export const EXPECTED_PROOF_LENGTHS: Readonly<Record<string, number>> = {
  // populated by `bb prove` output during deployment; placeholder until then
  "shield-note": 0,
  "transfer-note": 0,
  "withdraw-note": 0,
  "split-note": 0,
  "merge-note": 0,
};
