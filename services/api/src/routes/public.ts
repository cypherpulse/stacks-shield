// =============================================================================
// STX Shield API -- public (unauthenticated) endpoints
// =============================================================================
//   GET /stats
//   GET /notes/encrypted
//   GET /roots            GET /roots/latest
//   GET /aggregations     GET /aggregations/:id
//   GET /transactions     GET /transactions/:txid
//   GET /fees  GET /treasury  GET /version

import type { FastifyInstance } from "fastify";
import { cvToJSON, hexToCV } from "@stacks/transactions";
import { config } from "../config.js";
import { callReadOnly } from "../utils/hiro.js";
import * as q from "../services/queries.js";
import { getAssets } from "../services/assets.js";

const pagination = (query: unknown) => {
  const qq = (query ?? {}) as { limit?: string; offset?: string };
  return { limit: q.clampLimit(qq.limit), offset: q.clampOffset(qq.offset) };
};

export const registerPublicRoutes = (app: FastifyInstance): void => {
  // Aggregate protocol stats, plus a per-asset breakdown (shielded + fees for
  // STX / sBTC / USDCx …). The top-level `shielded`/`fees` stay STX for
  // backward compatibility; `byAsset` carries every asset in its own units.
  app.get("/stats", async () => {
    const [base, byAsset] = await Promise.all([q.getStats(), q.getAssetStats()]);
    return { ...base, byAsset };
  });

  // Unified multi-asset registry: native STX + every registered SIP-10 asset,
  // each tagged with the pool/verifier it routes to. Single source of truth for
  // clients so they never hardcode a pool. Sourced from the on-chain registry.
  app.get("/assets", async () => ({ results: await getAssets() }));

  app.get("/notes/encrypted", async (req) => {
    const { limit, offset } = pagination(req.query);
    return { results: await q.getEncryptedNotes(limit, offset), limit, offset };
  });

  // ALL commitments in leaf-index order — clients rebuild the commitment tree
  // from this to build spend membership proofs.
  app.get("/commitments", async () => ({ results: await q.getAllCommitments() }));

  app.get("/roots", async (req) => {
    const { limit, offset } = pagination(req.query);
    return { results: await q.getRoots(limit, offset), limit, offset };
  });
  app.get("/roots/latest", async (_req, reply) => {
    const root = await q.getLatestRoot();
    return root ? root : reply.status(404).send({ error: "not_found", message: "no roots indexed yet" });
  });

  app.get("/aggregations", async (req) => {
    const { limit, offset } = pagination(req.query);
    return { results: await q.getAggregations(limit, offset), limit, offset };
  });
  app.get<{ Params: { id: string } }>("/aggregations/:id", async (req, reply) => {
    let id: bigint;
    try {
      id = BigInt(req.params.id);
    } catch {
      return reply.status(400).send({ error: "invalid_request", message: "aggregation id must be an integer" });
    }
    const agg = await q.getAggregation(id);
    return agg ? agg : reply.status(404).send({ error: "not_found", message: "unknown aggregation" });
  });

  app.get("/transactions", async (req) => {
    const { limit, offset } = pagination(req.query);
    const type = (req.query as { type?: string })?.type;
    return { results: await q.getTransactions(limit, offset, type), limit, offset };
  });
  app.get<{ Params: { txid: string } }>("/transactions/:txid", async (req, reply) => {
    const tx = await q.getTransaction(req.params.txid);
    return tx ? tx : reply.status(404).send({ error: "not_found", message: "unknown transaction" });
  });

  app.get("/fees", async () => q.getFees());

  app.get("/treasury", async () => {
    // Best-effort: resolve the treasury principal from the fees contract, then
    // read its transparent STX balance. Never fails the request.
    let address: string | null = null;
    try {
      const hex = await callReadOnly(config.contracts.protocolFees, "get-treasury");
      if (hex) {
        const j = cvToJSON(hexToCV(hex)) as { value?: unknown };
        if (typeof j.value === "string") address = j.value;
      }
    } catch {
      /* ignore */
    }
    let balanceMicroStx: string | null = null;
    if (address) {
      try {
        const res = await fetch(`${config.hiroApiUrl}/extended/v1/address/${address}/balances`);
        if (res.ok) balanceMicroStx = (((await res.json()) as { stx?: { balance?: string } }).stx?.balance) ?? null;
      } catch {
        /* ignore */
      }
    }
    return { address, balanceMicroStx, balanceStx: balanceMicroStx ? Number(balanceMicroStx) / 1_000_000 : null };
  });

  app.get("/version", async () => ({
    api: config.version,
    network: config.network,
    deployer: config.deployer,
    contracts: config.contracts,
    protocol: "stx-shield-v1",
  }));
};
