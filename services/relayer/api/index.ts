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
//   POST /submit              submit a bb.js proof to zkVerify -> aggregation
//                             inclusion (browser-facing; CORS + rate limited)
//
// There is deliberately no /shield: shielding moves STX *from* the caller, so
// the depositor must sign it. Relaying it would mean handing the relayer your
// funds, and a deposit is public regardless.

import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { OPERATIONS, RelayError, type Operation } from "../types/index.js";
import type { RelayerService } from "../services/relayer-service.js";
import type { ProofSubmitter } from "../submitter/index.js";
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

/** Tiny in-memory fixed-window rate limiter (per client key). */
const makeRateLimiter = (max: number, windowMs: number) => {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const e = hits.get(key);
    if (!e || now > e.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (e.count >= max) return false;
    e.count += 1;
    return true;
  };
};

const submitSchema = z.object({
  proof: z.string().min(2).max(200_000),
  publicInputs: z.array(z.string().max(200)).min(1).max(2_048),
  vk: z.string().min(2).max(2_000_000),
  domainId: z.number().int().nonnegative().max(65_535).optional(),
});

export interface ServerOptions {
  submitter?: ProofSubmitter;
  submitRate?: { max: number; windowMs: number };
}

export const registerRoutes = (
  app: FastifyInstance,
  service: RelayerService,
  opts: ServerOptions = {},
): void => {
  app.get("/health", async () => ({ ok: true }));

  app.get("/ready", async (_req, reply) => {
    const r = await service.ready();
    return reply.status(r.ready ? 200 : 503).send(r);
  });

  app.get("/info", async () => ({
    ...service.info(),
    submit: Boolean(opts.submitter?.isConfigured()),
  }));

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

  // ---- POST /submit --------------------------------------------------------
  // Browser-facing: the SDK posts a bb.js proof here so end users never hold a
  // funded zkVerify account. Rate limited (each submission costs the relayer's
  // zkVerify gas), body-validated, and the verify variant is fixed server-side.
  if (opts.submitter) {
    const submitter = opts.submitter;
    const rate = opts.submitRate ?? { max: 20, windowMs: 60_000 };
    const allow = makeRateLimiter(rate.max, rate.windowMs);

    app.post("/submit", async (req, reply) => {
      if (!submitter.isConfigured()) {
        return reply
          .status(503)
          .send({ error: "unavailable", message: "proof submission is not enabled on this relayer" });
      }
      if (!allow(clientKey(req))) {
        return reply.status(429).send({ error: "rate_limited", message: "too many submissions; retry shortly" });
      }
      const parsed = submitSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid_request", message: "malformed proof payload" });
      }
      try {
        const inclusion = await submitter.submit(parsed.data);
        return reply.send(inclusion);
      } catch (e) {
        return fail(reply, e);
      }
    });
  }
};

export const buildServer = async (
  service: RelayerService,
  opts: ServerOptions & { corsOrigins?: string[] | true } = {},
): Promise<FastifyInstance> => {
  const { default: Fastify } = await import("fastify");
  const app = Fastify({ logger: false, bodyLimit: 4_194_304 });

  // CORS is required so browsers can reach POST /submit cross-origin.
  const { default: cors } = await import("@fastify/cors");
  await app.register(cors, {
    origin: opts.corsOrigins ?? true,
    methods: ["GET", "POST"],
    maxAge: 86_400,
  });

  registerRoutes(app, service, opts);
  return app;
};
