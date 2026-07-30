// =============================================================================
// STX Shield API -- server bootstrap (Phase 9)
// =============================================================================
// A read-only public API + indexers. It NEVER holds keys, proves, verifies,
// signs, spends, or decrypts notes.

import Fastify, { type FastifyBaseLogger } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { closeDb } from "./db/client.js";
import { registerAuth } from "./auth/plugin.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerMeRoutes } from "./routes/me.js";
import { startBlockIndexer } from "./indexers/block-indexer.js";

const build = async () => {
  // Cast the pino logger to FastifyBaseLogger so its Logger generic does not
  // leak into the app type (and thus the route registrars, which take the
  // default instance type).
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  await app.register(cors, { origin: config.corsOrigins });
  await app.register(rateLimit, { max: config.rateLimitMax, timeWindow: config.rateLimitWindow });
  await registerAuth(app);

  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerPublicRoutes(app);
  registerMeRoutes(app);

  return app;
};

const main = async () => {
  const app = await build();
  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port, network: config.network, deployer: config.deployer }, "api: listening");

  const stopIndexer = config.indexerEnabled ? startBlockIndexer() : (() => {});

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "api: shutting down");
    stopIndexer();
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
};

main().catch((e) => {
  logger.error({ err: e instanceof Error ? e.stack : String(e) }, "api: fatal");
  process.exit(1);
});

export { build };
