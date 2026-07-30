// =============================================================================
// STX Shield API -- JWT plugin + `authenticate` guard
// =============================================================================
// 24h JWTs, no refresh, stored frontend-side only. Each token carries a jti
// backed by a `sessions` row so logout can revoke it server-side.

import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { config } from "../config.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    wallet?: string;
  }
}
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { wallet: string; jti: string };
    user: { wallet: string; jti: string };
  }
}

export const registerAuth = async (app: FastifyInstance): Promise<void> => {
  await app.register(fastifyJwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: `${config.jwtTtlSeconds}s` },
  });

  // Guard: valid JWT + a live (non-revoked, non-expired) session row.
  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.status(401).send({ error: "unauthorized", message: "invalid or missing token" });
    }
    const { wallet, jti } = req.user;
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.jwtId, jti), eq(sessions.revoked, false)));
    if (!session || session.expiresAt.getTime() < Date.now()) {
      return reply.status(401).send({ error: "unauthorized", message: "session expired or revoked" });
    }
    req.wallet = wallet;
  });
};
