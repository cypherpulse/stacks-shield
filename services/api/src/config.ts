// =============================================================================
// STX Shield API -- configuration (env-driven, validated)
// =============================================================================

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(8888),
  API_HOST: z.string().default("0.0.0.0"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
  JWT_TTL_HOURS: z.coerce.number().int().positive().default(24),

  STACKS_NETWORK: z.enum(["mainnet", "testnet"]).default("testnet"),
  HIRO_API_URL: z.string().default("https://api.testnet.hiro.so"),
  HIRO_API_KEY: z.string().optional(),

  CONTRACT_DEPLOYER: z.string().min(1, "CONTRACT_DEPLOYER is required"),

  // Indexer knobs
  BLOCK_POLL_MS: z.coerce.number().int().positive().default(10_000),
  INDEXER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  INDEXER_START_HEIGHT: z.coerce.number().int().nonnegative().default(0),

  // CORS: comma-separated origins, or "*"
  CORS_ORIGINS: z.string().default("*"),

  AUTH_NONCE_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  // eslint-disable-next-line no-console
  console.error(`[api] invalid configuration:\n${issues}`);
  process.exit(1);
}
const e = parsed.data;

/** Contract identifiers derived from the deployer address (frozen protocol). */
const contract = (name: string) => `${e.CONTRACT_DEPLOYER}.${name}`;

export const config = {
  env: e.NODE_ENV,
  isProd: e.NODE_ENV === "production",
  port: e.API_PORT,
  host: e.API_HOST,

  databaseUrl: e.DATABASE_URL,
  dbPoolSize: e.DB_POOL_SIZE,

  jwtSecret: e.JWT_SECRET,
  jwtTtlSeconds: e.JWT_TTL_HOURS * 3600,

  network: e.STACKS_NETWORK,
  hiroApiUrl: e.HIRO_API_URL.replace(/\/$/, ""),
  hiroApiKey: e.HIRO_API_KEY,

  deployer: e.CONTRACT_DEPLOYER,
  contracts: {
    privacyPool: contract("privacy-pool"),
    splitMerge: contract("split-merge-manager"),
    zkVerifier: contract("zk-verifier"),
    privacyRegistry: contract("privacy-registry"),
    protocolFees: contract("protocol-fees"),
    // SIP-10 multi-asset extension (shares privacy-registry / note-manager with
    // the native pool; see indexers + /assets). Deployed under the same account.
    sip10Pool: contract("sip10-pool"),
    sip10ZkVerifier: contract("sip10-zk-verifier"),
    assetRegistry: contract("asset-registry"),
    sip10ProtocolFees: contract("sip10-protocol-fees"),
  },

  blockPollMs: e.BLOCK_POLL_MS,
  indexerEnabled: e.INDEXER_ENABLED,
  indexerStartHeight: e.INDEXER_START_HEIGHT,

  corsOrigins: e.CORS_ORIGINS === "*" ? true : e.CORS_ORIGINS.split(",").map((s) => s.trim()),
  authNonceTtlMs: e.AUTH_NONCE_TTL_MINUTES * 60_000,
  rateLimitMax: e.RATE_LIMIT_MAX,
  rateLimitWindow: e.RATE_LIMIT_WINDOW,

  version: "0.1.0",
} as const;

export type AppConfig = typeof config;
