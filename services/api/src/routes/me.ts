// =============================================================================
// STX Shield API -- protected (authenticated) endpoints
// =============================================================================
//   GET  /me
//   GET  /me/notes        POST /me/notes   (register an encrypted note)
//   GET  /me/history
//   GET  /me/operations
//   POST /me/notes/:commitment/spent  (owner marks a note spent locally)
//
// The wallet is the ONLY identity. The API stores opaque ciphertext supplied by
// the owner; it never sees amounts, keys, nullifiers or Merkle paths.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as q from "../services/queries.js";

const registerBody = z.object({
  commitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "commitment must be 32-byte hex"),
  ciphertext: z.string().min(1).max(8192),
});

export const registerMeRoutes = (app: FastifyInstance): void => {
  const guard = { onRequest: [app.authenticate] };

  app.get("/me", guard, async (req) => {
    const notes = await q.getWalletNotes(req.wallet!);
    return { wallet: req.wallet, notes: notes.length };
  });

  app.get("/me/notes", guard, async (req) => ({ results: await q.getWalletNotes(req.wallet!) }));

  app.get("/me/history", guard, async (req) => ({ results: await q.getWalletHistory(req.wallet!) }));

  app.get("/me/operations", guard, async (req) => {
    const history = await q.getWalletHistory(req.wallet!);
    const byType: Record<string, number> = {};
    for (const h of history) byType[h.type] = (byType[h.type] ?? 0) + 1;
    return { total: history.length, byType };
  });

  app.post("/me/notes", guard, async (req, reply) => {
    const parsed = registerBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", message: parsed.error.issues[0]?.message });
    const res = await q.registerWalletNote(req.wallet!, parsed.data);
    return reply.status(res.updated ? 200 : 202).send({ ok: true, indexed: res.updated });
  });

  app.post<{ Params: { commitment: string } }>("/me/notes/:commitment/spent", guard, async (req, reply) => {
    // Accept the commitment with or without the 0x prefix, and tolerate values
    // that are not zero-padded to 64 hex -- the store matches both forms.
    if (!/^(0x)?[0-9a-fA-F]{1,64}$/.test(req.params.commitment)) {
      return reply.status(400).send({ error: "invalid_request", message: "bad commitment" });
    }
    const updated = await q.markWalletNoteSpent(req.wallet!, req.params.commitment);
    return reply.send({ ok: true, updated });
  });
};
