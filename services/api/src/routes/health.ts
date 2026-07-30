// =============================================================================
// STX Shield API -- health & readiness
// =============================================================================

import type { FastifyInstance } from "fastify";
import { dbHealthy } from "../db/client.js";
import { config } from "../config.js";

export const registerHealthRoutes = (app: FastifyInstance): void => {
  app.get("/health", async () => ({ ok: true, service: "stx-shield-api", version: config.version }));

  app.get("/ready", async (_req, reply) => {
    const db = await dbHealthy();
    const ready = db;
    return reply.status(ready ? 200 : 503).send({ ready, checks: { database: db } });
  });
};
