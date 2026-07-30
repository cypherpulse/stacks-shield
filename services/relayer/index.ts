// =============================================================================
// STX Shield relayer -- entry point (Phase 10)
// =============================================================================
//   pnpm --filter @stx-shield/relayer dev   (or: node dist/index.js)
//
// A trustless liveness component. It publishes zkVerify aggregation roots and
// submits user operations from its own account (so the user never appears on
// chain). It NEVER verifies proofs, holds user secrets, owns notes, or censors:
// every operation parameter is bound into the zkVerify statement the contracts
// re-derive, so tampering makes the transaction revert.

import { pino } from "pino";
import { buildServer } from "./api/index.js";
import { RelayerService } from "./services/relayer-service.js";
import { createBullQueue, MemoryQueue } from "./queue/index.js";
import { loadConfig } from "./config/index.js";
import { ZkVerifyPoller } from "./root-publisher/poll-zkverify.js";
import { ProofSubmitter } from "./submitter/index.js";

const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: { service: "stx-shield-relayer" },
  transport:
    process.env["NODE_ENV"] === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } },
});

const main = async (): Promise<void> => {
  const cfg = loadConfig();
  const queue = cfg.redisUrl ? await createBullQueue(cfg.redisUrl) : new MemoryQueue(cfg.retries);

  const service = new RelayerService({
    network: cfg.network,
    apiUrl: cfg.apiUrl,
    senderKey: cfg.senderKey,
    address: cfg.address,
    deployer: cfg.deployer,
    txFee: cfg.txFeeMicroStx,
    queue,
  });

  // Root-publication poller shares the service's transaction manager so ops and
  // root submissions consume ONE serialized nonce sequence.
  const poller = new ZkVerifyPoller(cfg, service.transactionManager, logger);
  // Small startup jitter when multiple relayers are configured, so they do not
  // all race to publish the same root (publishRoot is idempotent regardless).
  const jitterMs = cfg.peers.length > 0 ? Math.floor(Math.random() * 3_000) : 0;
  setTimeout(() => void poller.start(), jitterMs);

  // Browser-facing zkVerify proof submitter (POST /submit). Only functional
  // when the relayer holds a zkVerify account (ZKVERIFY_SEED_PHRASE).
  const submitter = new ProofSubmitter(cfg, logger, cfg.submitTimeoutMs);

  const app = await buildServer(service, {
    submitter,
    corsOrigins: cfg.corsOrigins,
    submitRate: { max: cfg.submitRateMax, windowMs: cfg.submitRateWindowMs },
  });
  await app.listen({ port: cfg.port, host: "0.0.0.0" });

  const info = service.info();
  logger.info(
    {
      port: cfg.port,
      network: info.network,
      address: info.address,
      queue: queue.name,
      operations: info.operations,
      publishRoots: cfg.publishRoots,
      peers: cfg.peers.length,
    },
    "relayer: listening",
  );

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "relayer: shutting down");
    await poller.stop();
    await submitter.stop();
    await app.close();
    await queue.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
};

main().catch((e) => {
  logger.error({ err: e instanceof Error ? e.stack : String(e) }, "relayer: fatal");
  process.exit(1);
});
