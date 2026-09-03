// =============================================================================
// STX Shield -- SIP-10 deployment: shared library
// =============================================================================
// Reuses the existing deployment engine (../deployer.ts) and .env loading
// (../config.ts). Adds SIP-10-specific configuration, env validation, and
// Clarity-argument helpers. Every SIP-10 deploy/configure/verify script imports
// from here so there is one implementation of each concern.
//
// Secrets: the deployer mnemonic is read from .env.v2.deploy (NEW_DEPLOYER_MNEMONIC,
// override the file with DEPLOY_ENV_FILE) and never logged. The SIP-10 contracts
// reference `.privacy-registry` and `.note-manager`, which resolve under the SAME
// deploying account -- so those two must already be deployed under whatever
// account this mnemonic derives (set NEW_DEPLOYER_ADDRESS to that account).

import { Cl, type ClarityValue } from "@stacks/transactions";
import { loadEnv, type ContractName } from "../config.js";
import { Deployer, signerFromMnemonic } from "../deployer.js";

// ---- SIP-10 contracts, in mandatory dependency order (mocks NEVER deployed) --
export const SIP10_CONTRACTS = [
  "sip-010-trait",
  "asset-registry",
  "sip10-protocol-fees",
  "sip10-zk-verifier",
  "sip10-pool",
] as const;
export type Sip10Contract = (typeof SIP10_CONTRACTS)[number];

export const POOL = "sip10-pool";
export const VERIFIER = "sip10-zk-verifier";
export const ASSET_REGISTRY = "asset-registry";
export const FEES = "sip10-protocol-fees";
export const REGISTRY = "privacy-registry"; // frozen, already deployed
export const SIP10_CIRCUIT_VERSION = 2;
// UltraHonk (bb, evm target) proof byte length — the same value the STX registry
// uses. Note: raw proofs are NOT submitted on chain (verification is by zkVerify
// aggregation + Merkle inclusion of the public-inputs leaf), so proof-length is
// stored registry metadata validated as `> 0 && <= MAX-PROOF-LENGTH`, not matched
// against submitted bytes. Kept equal to the STX value for registry consistency.
export const PROOF_LEN = 7872;

/** Circuit -> proof type, env-var prefix for its key material, and the nargo
 *  package name (its compiled ACIR lands at
 *  zk/circuits/sip10/<dir>/target/<pkg>.json). */
export const CIRCUITS = [
  { name: "shield", proofType: 1, prefix: "SHIELD", dir: "shield", pkg: "sip10_shield_note" },
  { name: "transfer", proofType: 2, prefix: "TRANSFER", dir: "transfer", pkg: "sip10_transfer_note" },
  { name: "withdraw", proofType: 3, prefix: "WITHDRAW", dir: "withdraw", pkg: "sip10_withdraw_note" },
  { name: "split", proofType: 4, prefix: "SPLIT", dir: "split", pkg: "sip10_split_note" },
  { name: "merge", proofType: 5, prefix: "MERGE", dir: "merge", pkg: "sip10_merge_note" },
] as const;

export const EXPECTED_DEPLOYER = "ST18XMPE0PS5VNEEKB82BPW7NRZRHXEPH16JK8NN6";

// ---- environment ------------------------------------------------------------

export const env = (): Record<string, string> => loadEnv(process.env["DEPLOY_ENV_FILE"] ?? ".env.v2.deploy");

/** Throws a descriptive error listing every missing key BEFORE any broadcast. */
export const requireEnvVars = (e: Record<string, string>, keys: string[]): void => {
  const missing = keys.filter((k) => !e[k] || e[k]!.trim() === "");
  if (missing.length > 0) {
    throw new Error(
      `Missing required .env.v2.deploy variables:\n  - ${missing.join("\n  - ")}\n` +
        `Fill them in .env.v2.deploy before running this step.`,
    );
  }
};

/** Build a testnet Deployer from .env.v2.deploy, asserting the derived address is
 *  the expected deployer (NEW_DEPLOYER_ADDRESS). Never logs the mnemonic. */
export const getDeployer = async (): Promise<Deployer> => {
  const e = env();
  requireEnvVars(e, ["NEW_DEPLOYER_MNEMONIC"]);
  const signer = await signerFromMnemonic(e["NEW_DEPLOYER_MNEMONIC"]!, "testnet");
  const expected = e["NEW_DEPLOYER_ADDRESS"] || EXPECTED_DEPLOYER;
  if (signer.address !== expected) {
    throw new Error(
      `Deployer address mismatch: mnemonic derives ${signer.address}, expected ${expected}. ` +
        `Refusing to deploy under the wrong account.`,
    );
  }
  return new Deployer("testnet", signer, e["CORE_API_URL"]);
};

// ---- Clarity argument helpers ----------------------------------------------

/** A 0x-prefixed (or bare) 32-byte hex string -> Clarity buffer. */
export const buff32 = (hex: string): ClarityValue => {
  const clean = hex.replace(/^0x/, "");
  if (clean.length !== 64) throw new Error(`expected a 32-byte hex value, got ${clean.length / 2} bytes: ${hex}`);
  return Cl.bufferFromHex(clean);
};

/** "ST....contract-name" -> a contract-principal Clarity value (SIP-10 token trait arg). */
export const contractPrincipalArg = (id: string): ClarityValue => {
  const [addr, name] = id.split(".");
  if (!addr || !name) throw new Error(`not a contract principal "addr.name": ${id}`);
  return Cl.contractPrincipal(addr, name);
};

/** Cast a SIP-10 contract name to the engine's ContractName (it only uses the
 *  string to read contracts/<name>.clar and to build call targets). */
export const asContract = (name: string): ContractName => name as ContractName;

/** True when THIS module is the process entrypoint. Robust across tsx + WSL,
 *  where `import.meta.url === file://${process.argv[1]}` is unreliable (differing
 *  slash counts / transpiled paths), which silently no-op'd standalone scripts.
 *  Compares basenames: run directly they match; imported they differ. */
export const isEntrypoint = (importMetaUrl: string): boolean => {
  const argBase = process.argv[1]?.replace(/\\/g, "/").split("/").pop();
  const urlBase = importMetaUrl.replace(/\\/g, "/").split("/").pop();
  return !!argBase && argBase === urlBase;
};

export { Cl };
