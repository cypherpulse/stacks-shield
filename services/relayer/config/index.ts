// =============================================================================
// STX Shield relayer -- configuration (Phase 10)
// =============================================================================

const num = (k: string, def: number): number => {
  const v = process.env[k];
  const n = v == null ? def : Number(v);
  return Number.isFinite(n) ? n : def;
};
const str = (k: string, def?: string): string => process.env[k] ?? def ?? "";

export interface RelayerConfig {
  network: "mainnet" | "testnet";
  apiUrl: string;
  port: number;
  redisUrl?: string;

  senderKey: string;
  address: string;
  deployer: string;
  txFeeMicroStx: number;
  treasuryAddress?: string;

  // Transaction manager
  retries: number; // 3
  pollMs: number; // 30_000
  timeoutMs: number; // 900_000 (15 min)

  // zkVerify root-publication poller
  zkVerifyEndpoint?: string;
  zkVerifySeed?: string;
  zkVerifyDomainIds: number[];
  pollZkVerifyMs: number; // 10_000
  publishRoots: boolean;

  // Multi-relayer failover
  peers: string[]; // other relayer base URLs
  relayerId: string;
}

/** Parse peer relayer URLs from STX_SHIELD_RELAYERS or RELAYER_1..N. */
const parsePeers = (): string[] => {
  const csv = process.env["STX_SHIELD_RELAYERS"];
  if (csv && csv.trim()) return csv.split(",").map((s) => s.trim()).filter(Boolean);
  const peers: string[] = [];
  for (let i = 1; i <= 16; i++) {
    const v = process.env[`RELAYER_${i}`];
    if (v && v.trim()) peers.push(v.trim());
  }
  return peers;
};

export const loadConfig = (): RelayerConfig => {
  const network = (str("STACKS_NETWORK", "testnet") as "mainnet" | "testnet");
  const apiUrl =
    str("STACKS_API_URL") ||
    (network === "mainnet" ? "https://api.hiro.so" : "https://api.testnet.hiro.so");

  const need = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`missing required environment variable ${k}`);
    return v;
  };

  return {
    network,
    apiUrl,
    port: num("RELAYER_PORT", 8787),
    redisUrl: process.env["REDIS_URL"],

    senderKey: need("RELAYER_PRIVATE_KEY"),
    address: need("RELAYER_ADDRESS"),
    deployer: need("CONTRACT_DEPLOYER"),
    txFeeMicroStx: num("RELAYER_TX_FEE", 10_000),
    treasuryAddress: process.env["TREASURY_ADDRESS"],

    retries: num("RELAYER_RETRIES", 3),
    pollMs: num("RELAYER_POLL_MS", 30_000),
    timeoutMs: num("RELAYER_TIMEOUT_MS", 900_000),

    zkVerifyEndpoint: process.env["ZKVERIFY_ENDPOINT"],
    zkVerifySeed: process.env["ZKVERIFY_SEED_PHRASE"],
    zkVerifyDomainIds: str("ZKVERIFY_DOMAIN_ID", "0")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n)),
    pollZkVerifyMs: num("ZKVERIFY_POLL_MS", 10_000),
    publishRoots: str("RELAYER_PUBLISH_ROOTS", "true") !== "false",

    peers: parsePeers(),
    relayerId: str("RELAYER_ID", str("RELAYER_ADDRESS", "relayer")),
  };
};
