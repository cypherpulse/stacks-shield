// =============================================================================
// STX Shield -- Attestation Service HTTP server
// =============================================================================
// Minimal, dependency-free Node HTTP server exposing the committee endpoint
// POST /attest that the SDK's AttestationClient calls. Framework-agnostic so
// operators can drop it behind their own gateway / TLS / rate limiter.
//
// Threshold configurations supported by the protocol (set on-chain via
// zk-verifier.set-attestation-threshold): 1-of-1, 2-of-3, 3-of-5, 5-of-7,
// 7-of-10. Each committee member runs one instance of this server with its
// own signing key.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AttestationService, type AttestRequest } from "./service.js";

export interface ServerOptions {
  readonly port: number;
  readonly service: AttestationService;
  /** simple per-IP token-bucket rate limit (requests/second). */
  readonly rateLimitRps?: number;
}

export function startAttestationServer(opts: ServerOptions): ReturnType<typeof createServer> {
  const limiter = new RateLimiter(opts.rateLimitRps ?? 20);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { status: "ok", signer: hex(opts.service.publicKey) });
    }
    if (req.method !== "POST" || req.url !== "/attest") {
      return json(res, 404, { error: "not found" });
    }
    if (!limiter.allow(req.socket.remoteAddress ?? "unknown")) {
      return json(res, 429, { error: "rate limited" });
    }

    collectBody(req)
      .then(async (body) => {
        const parsed = JSON.parse(body) as AttestRequest;
        const attestation = await opts.service.attest(parsed);
        json(res, 200, attestation);
      })
      .catch((e: unknown) => {
        // Verification failures are 422 (client's proof is bad), not 500.
        json(res, 422, { error: e instanceof Error ? e.message : "attestation failed" });
      });
  });

  server.listen(opts.port);
  return server;
}

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) reject(new Error("payload too large")); // proofs are ~16 KiB
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");

/** Fixed-window token bucket, per client key. */
class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; ts: number }>();
  constructor(private readonly rps: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.rps, ts: now };
    const elapsed = (now - b.ts) / 1000;
    b.tokens = Math.min(this.rps, b.tokens + elapsed * this.rps);
    b.ts = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}
