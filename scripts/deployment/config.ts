// =============================================================================
// STX Shield -- deployment configuration
// =============================================================================
// Ordered contract list (dependency order — later contracts reference earlier
// ones), plus per-network parameters. Used by the deploy / wire / verify /
// validate scripts. Nothing here is secret; the deployer mnemonic is supplied
// via .env.testnet at run time and never committed.

import { readFileSync } from "node:fs";

export type Network = "mainnet" | "testnet" | "devnet";

/** Contracts in mandatory deployment order. */
export const CONTRACT_ORDER = [
  "privacy-registry",
  "note-manager",
  "protocol-fees",
  "zk-verifier",
  "privacy-pool",
  "split-merge-manager",
] as const;

export type ContractName = (typeof CONTRACT_ORDER)[number];

/** Contracts the registry must authorize as protocol callers (they perform
 *  protected writes): the pool, the note-manager, and the split-merge-manager. */
export const AUTHORIZED_CALLERS: ContractName[] = [
  "privacy-pool",
  "note-manager",
  "split-merge-manager",
];

/** The native STX circuit version bound into proofs and vkey registration.
 *  Must equal privacy-registry's CIRCUIT-VERSION (the value get-circuit-version
 *  returns, which the pool passes to zk-verifier.verify-proof). */
export const STX_CIRCUIT_VERSION = 2;

/** Circuit → proof type mapping for vkey registration. */
export const CIRCUITS = [
  { name: "shield-note", proofType: 1 },
  { name: "transfer-note", proofType: 2 },
  { name: "withdraw-note", proofType: 3 },
  { name: "split-note", proofType: 4 },
  { name: "merge-note", proofType: 5 },
] as const;

export interface NetworkConfig {
  readonly network: Network;
  readonly coreApiUrl: string;
  /** micro-STX fee cap per deploy tx. */
  readonly maxDeployFee: number;
  /** genesis (empty-tree) Merkle root, computed by the SDK's MerkleTree. */
  readonly genesisRootHex: string;
  /** zkVerify aggregation domain whose roots this deployment consumes. */
  readonly zkVerifyDomainId: number;
  /** zkVerify endpoint the SDK submits proofs to. */
  readonly zkVerifyEndpoint: string;
  /** production owner (multisig/timelock) to hand ownership to post-deploy. */
  readonly finalOwner?: string;
}

export const NETWORKS: Record<Network, NetworkConfig> = {
  devnet: {
    network: "devnet",
    coreApiUrl: "http://localhost:3999",
    maxDeployFee: 1_000_000,
    genesisRootHex: "0x" + "00".repeat(32), // devnet placeholder; set from SDK
    zkVerifyDomainId: 1,
    zkVerifyEndpoint: "wss://testnet-rpc.zkverify.io",
  },
  testnet: {
    network: "testnet",
    coreApiUrl: "https://api.testnet.hiro.so",
    maxDeployFee: 2_000_000,
    genesisRootHex: "0x" + "00".repeat(32),
    zkVerifyDomainId: 1,
    zkVerifyEndpoint: "wss://testnet-rpc.zkverify.io",
  },
  mainnet: {
    network: "mainnet",
    coreApiUrl: "https://api.hiro.so",
    maxDeployFee: 5_000_000,
    genesisRootHex: "0x" + "00".repeat(32),
    zkVerifyDomainId: 1,
    zkVerifyEndpoint: "wss://rpc.zkverify.io",
    // finalOwner: set to the production multisig before running wire
  },
};

/** Reads .env.testnet (or .env) without adding a dependency. */
export const loadEnv = (file = ".env.testnet"): Record<string, string> => {
  const out: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const candidate of [file, ".env"]) {
    try {
      const text = readFileSync(candidate, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const m = line.trim().match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!m) continue;
        const [, k, v] = m;
        if (out[k!] === undefined || out[k!] === "") {
          out[k!] = v!.trim().replace(/^["']|["']$/g, "");
        }
      }
    } catch {
      /* file absent — fall back to process.env */
    }
  }
  return out;
};

export const requireEnv = (env: Record<string, string>, key: string): string => {
  const v = env[key];
  if (!v) {
    throw new Error(
      `Missing required environment variable ${key}. ` +
        `Copy .env.testnet.example to .env.testnet and fill it in.`,
    );
  }
  return v;
};

/**
 * Reads the deployer mnemonic straight out of Clarinet's own settings file
 * (settings/Testnet.toml or settings/Mainnet.toml), the file `clarinet
 * deployments apply` itself uses. This is the credential of record for
 * anyone driving deployment through the Clarinet CLI — no need to duplicate
 * the seed phrase into a second .env file just to run the wiring/validation
 * scripts afterward. Returns undefined if the file is absent or the mnemonic
 * field is still a placeholder/encrypted value.
 */
export const loadClarinetMnemonic = (network: Network): string | undefined => {
  const file = `settings/${network === "mainnet" ? "Mainnet" : "Testnet"}.toml`;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  // crude but sufficient: pull the mnemonic under [accounts.deployer]
  const section = text.split(/\[accounts\.deployer\]/)[1];
  if (!section) return undefined;
  const m = section.match(/^\s*mnemonic\s*=\s*"([^"]+)"/m);
  if (!m) return undefined;
  const value = m[1]!.trim();
  // an encrypted mnemonic (produced by `clarinet deployments encrypt`) is not
  // a raw 12/24-word phrase this script can derive keys from directly.
  if (value.split(/\s+/).length < 12) return undefined;
  return value;
};

/** stacks_node_rpc_address out of the same Clarinet settings file, so the API
 *  URL used for wiring matches whatever the CLI actually deployed against. */
export const loadClarinetApiUrl = (network: Network): string | undefined => {
  const file = `settings/${network === "mainnet" ? "Mainnet" : "Testnet"}.toml`;
  try {
    const text = readFileSync(file, "utf8");
    const m = text.match(/stacks_node_rpc_address\s*=\s*"([^"]+)"/);
    return m?.[1];
  } catch {
    return undefined;
  }
};

/** Resolves the deployer mnemonic from, in order: explicit env var,
 *  .env.testnet/.env, then Clarinet's own settings/<Network>.toml. Throws
 *  only if none of those has a usable value. */
export const resolveDeployerMnemonic = (
  env: Record<string, string>,
  network: Network,
): string => {
  // NEW_DEPLOYER_MNEMONIC is the v2 relaunch key (shared with the SIP-10 scripts,
  // which read the same .env.v2.deploy) and takes PRECEDENCE so a stale
  // DEPLOYER_MNEMONIC in .env / the shell can never deploy the STX core under a
  // different wallet than the SIP-10 stack. DEPLOYER_MNEMONIC is the legacy fallback.
  const fromEnv = env["NEW_DEPLOYER_MNEMONIC"] || env["DEPLOYER_MNEMONIC"];
  if (fromEnv) return fromEnv;
  const fromClarinet = loadClarinetMnemonic(network);
  if (fromClarinet) return fromClarinet;
  throw new Error(
    "No deployer mnemonic found. Set NEW_DEPLOYER_MNEMONIC (or DEPLOYER_MNEMONIC) in .env.v2.deploy, or " +
      `put a plaintext (unencrypted) mnemonic in settings/${network === "mainnet" ? "Mainnet" : "Testnet"}.toml ` +
      "under [accounts.deployer] — the same file `clarinet deployments apply` reads.",
  );
};
