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
  // ZKVERIFY_USE_API: true = connect through the custom ZKVERIFY_ENDPOINT (e.g.
  // an Ankr API-key RPC); false = ignore it and use the built-in public Volta.
  zkVerifyUseApi: boolean;
  // ZKVERIFY_USE_SUBSCRIPTIONS: true = try live event subscriptions; false =
  // poll only (Volta's public RPC does not expose the subscription API).
  zkVerifyUseSubscriptions: boolean;
  zkVerifySeed?: string;
  zkVerifyDomainIds: number[];
  pollZkVerifyMs: number; // 10_000
  publishRoots: boolean;

  // POST /submit (proof submitter for the frontend)
  corsOrigins: string[] | true;
  submitTimeoutMs: number; // 300_000
  submitRateMax: number; // 20
  submitRateWindowMs: number; // 60_000

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
    // On Render/hosted platforms the port is injected as $PORT; prefer the
    // explicit RELAYER_PORT, then fall back to PORT, then the local default.
    port: num("RELAYER_PORT", num("PORT", 8787)),
    redisUrl: process.env["REDIS_URL"],

    senderKey: need("RELAYER_PRIVATE_KEY"),
    address: need("RELAYER_ADDRESS"),
    deployer: need("CONTRACT_DEPLOYER"),
    txFeeMicroStx: num("RELAYER_TX_FEE", 10_000),
    treasuryAddress: process.env["TREASURY_ADDRESS"],

    retries: num("RELAYER_RETRIES", 3),
    pollMs: num("RELAYER_POLL_MS", 30_000),
    timeoutMs: num("RELAYER_TIMEOUT_MS", 900_000),

    zkVerifyEndpoint: process.env["ZKVERIFY_ENDPOINT"]?.trim() || undefined,
    // Default: use the API endpoint if one is provided, otherwise built-in Volta.
    zkVerifyUseApi:
      str("ZKVERIFY_USE_API", process.env["ZKVERIFY_ENDPOINT"]?.trim() ? "true" : "false") !== "false",
    zkVerifyUseSubscriptions: str("ZKVERIFY_USE_SUBSCRIPTIONS", "false") === "true",
    zkVerifySeed: process.env["ZKVERIFY_SEED_PHRASE"],
    zkVerifyDomainIds: str("ZKVERIFY_DOMAIN_ID", "0")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n)),
    pollZkVerifyMs: num("ZKVERIFY_POLL_MS", 10_000),
    publishRoots: str("RELAYER_PUBLISH_ROOTS", "true") !== "false",

    // POST /submit (browser-facing proof submitter)
    corsOrigins: parseCorsOrigins(),
    submitTimeoutMs: num("SUBMIT_TIMEOUT_MS", 300_000),
    submitRateMax: num("SUBMIT_RATE_MAX", 20),
    submitRateWindowMs: num("SUBMIT_RATE_WINDOW_MS", 60_000),

    peers: parsePeers(),
    relayerId: str("RELAYER_ID", str("RELAYER_ADDRESS", "relayer")),
  };
};

/** CORS allow-list for /submit. Blank/`*` reflects any origin (public dApp);
 *  a CSV of origins locks it down. */
const parseCorsOrigins = (): string[] | true => {
  const raw = process.env["CORS_ORIGINS"];
  if (!raw || !raw.trim() || raw.trim() === "*") return true;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
};
