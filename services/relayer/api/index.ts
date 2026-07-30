// =============================================================================
// STX Shield relayer -- HTTP API (Fastify)
// =============================================================================
//   GET  /health              liveness
//   GET  /info                address, fees, supported operations
//   POST /transfer            queue a private transfer
//   POST /withdraw            queue a private withdrawal
//   POST /split               queue a note split
//   POST /merge               queue a note merge
//   GET  /status/:jobId       job progress
//
// There is deliberately no /shield: shielding moves STX *from* the caller, so
// the depositor must sign it. Relaying it would mean handing the relayer your
// funds, and a deposit is public regardless.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { OPERATIONS, RelayError, type Operation } from "../types/index.js";
import type { RelayerService } from "../services/relayer-service.js";
import { metrics } from "../metrics/index.js";

/** Client key for rate limiting. Note this is the ONLY thing the relayer
 *  records about a caller, it is never persisted, and it is never linked to
 *  the operation contents. */
const clientKey = (req: FastifyRequest): string => req.ip ?? "anonymous";

const fail = (reply: FastifyReply, e: unknown) => {
  if (e instanceof RelayError) {
    return reply.status(e.status).send({ error: e.code, message: e.message });
  }
  req_log(e);
  return reply.status(500).send({ error: "internal_error", message: "unexpected failure" });
};

const req_log = (e: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[relayer]", e instanceof Error ? e.stack : e);
};

export const registerRoutes = (app: FastifyInstance, service: RelayerService): void => {
  app.get("/health", async () => ({ ok: true }));

  app.get("/ready", async (_req, reply) => {
    const r = await service.ready();
    return reply.status(r.ready ? 200 : 503).send(r);
  });

  app.get("/info", async () => service.info());

  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", "text/plain; version=0.0.4");
    return metrics.prometheus();
  });

  app.get("/dead-letter", async () => ({ results: await service.queue.deadLetter() }));

  for (const op of OPERATIONS) {
    app.post(`/${op}`, async (req, reply) => {
      try {
        const accepted = await service.accept(op as Operation, req.body, clientKey(req));
        return reply.status(202).send(accepted);
      } catch (e) {
        return fail(reply, e);
      }
    });
  }

  app.get<{ Params: { jobId: string } }>("/status/:jobId", async (req, reply) => {
    const job = await service.status(req.params.jobId);
    if (!job) {
      return reply.status(404).send({ error: "not_found", message: "unknown job" });
    }
    // Only the operation's own status is exposed — never the request body,
    // so a relayer's status endpoint cannot be mined for user data.
    return reply.send({
      jobId: job.id,
      operation: job.operation,
      state: job.state,
      txid: job.txid,
      error: job.error,
      attempts: job.attempts,
    });
  });
};

export const buildServer = async (service: RelayerService): Promise<FastifyInstance> => {
  const { default: Fastify } = await import("fastify");
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  registerRoutes(app, service);
  return app;
};
