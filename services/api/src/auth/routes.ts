// =============================================================================
// STX Shield API -- authentication routes
// =============================================================================
//   POST /auth/nonce   { wallet }              -> { nonce, message }
//   POST /auth/verify  { wallet, publicKey, signature, message } -> { token, expiresAt }
//   POST /auth/logout  (auth)                  -> { ok }

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { authNonces, sessions, users } from "../db/schema.js";
import { config } from "../config.js";
import { buildAuthMessage, generateNonce } from "./message.js";
import { verifyWalletSignature } from "./verify.js";

const walletRe = /^S[TP][0-9A-Z]{38,40}$/; // Stacks c32 address
const nonceBody = z.object({ wallet: z.string().regex(walletRe, "invalid Stacks address") });
const verifyBody = z.object({
  wallet: z.string().regex(walletRe),
  publicKey: z.string().min(1),
  signature: z.string().min(1),
  message: z.string().min(1),
});

const extractNonce = (message: string): string | null => message.match(/Nonce:\n([0-9a-f]{64})/)?.[1] ?? null;

export const registerAuthRoutes = (app: FastifyInstance): void => {
  app.post("/auth/nonce", async (req, reply) => {
    const parsed = nonceBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", message: parsed.error.issues[0]?.message });
    const { wallet } = parsed.data;

    const nonce = generateNonce();
    const dateISO = new Date().toISOString();
    const message = buildAuthMessage(wallet, nonce, dateISO);
    await db.insert(authNonces).values({
      wallet,
      nonce,
      expiresAt: new Date(Date.now() + config.authNonceTtlMs),
    });
    return reply.send({ nonce, message });
  });

  app.post("/auth/verify", async (req, reply) => {
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", message: parsed.error.issues[0]?.message });
    const { wallet, publicKey, signature, message } = parsed.data;

    const nonce = extractNonce(message);
    if (!nonce) return reply.status(400).send({ error: "invalid_request", message: "no nonce in message" });

    const [row] = await db
      .select()
      .from(authNonces)
      .where(and(eq(authNonces.nonce, nonce), eq(authNonces.wallet, wallet), eq(authNonces.used, false)));
    if (!row || row.expiresAt.getTime() < Date.now()) {
      return reply.status(401).send({ error: "unauthorized", message: "nonce invalid or expired" });
    }

    if (!verifyWalletSignature({ message, signature, publicKey, wallet })) {
      return reply.status(401).send({ error: "unauthorized", message: "signature verification failed" });
    }

    // Consume the nonce (single use).
    await db.update(authNonces).set({ used: true }).where(eq(authNonces.id, row.id));

    // Upsert the user.
    await db
      .insert(users)
      .values({ wallet })
      .onConflictDoUpdate({ target: users.wallet, set: { lastLogin: sql`now()` } });

    // Issue a session-backed JWT.
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + config.jwtTtlSeconds * 1000);
    await db.insert(sessions).values({ wallet, jwtId: jti, expiresAt });
    const token = await reply.jwtSign({ wallet, jti });

    return reply.send({ token, expiresAt: expiresAt.toISOString() });
  });

  app.post("/auth/logout", { onRequest: [app.authenticate] }, async (req, reply) => {
    const jti = req.user.jti;
    await db.update(sessions).set({ revoked: true }).where(eq(sessions.jwtId, jti));
    return reply.send({ ok: true });
  });
};
