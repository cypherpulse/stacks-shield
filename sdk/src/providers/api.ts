// =============================================================================
// @stacks-shield/sdk -- public API provider
// =============================================================================
// Read-only protocol data + wallet authentication. Never sends secrets.

import { ApiError, AuthenticationError } from "../errors/index.js";
import { retry } from "../utils/retry.js";
import type { Logger } from "../utils/logger.js";
import type { Stats, HistoryEntry } from "../types/response.js";
import { validateAsset, type AssetInfo } from "../types/asset.js";

export interface EncryptedNoteRecord {
  commitment: string;
  ciphertext: string | null;
  root: string;
  txid: string;
  /** pending | confirmed | failed — on-chain confirmation state of the note. */
  status?: string;
  /** True once the note has been spent (its nullifier is on chain). */
  spent?: boolean;
}

export interface ApiProviderOptions {
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
}

export class ApiProvider {
  private token?: string;
  /** Supported assets are near-static (a new one needs on-chain registration),
   *  so they are cached briefly to avoid a fetch on every op's asset resolution. */
  private assetsCache?: { at: number; assets: AssetInfo[] };
  private static readonly ASSETS_TTL_MS = 60_000;
  constructor(private readonly opts: ApiProviderOptions) {}

  setToken(token: string | undefined): void {
    this.token = token;
  }
  get authenticated(): boolean {
    return !!this.token;
  }

  private async request<T>(path: string, init?: RequestInit & { auth?: boolean }): Promise<T> {
    return retry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        // Only advertise a JSON body when one is actually sent — a bodyless POST
        // (e.g. mark-spent, logout) with Content-Type: application/json is
        // rejected by Fastify ("Body cannot be empty").
        const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
        if (init?.body != null) headers["Content-Type"] = "application/json";
        if (init?.auth && this.token) headers["Authorization"] = `Bearer ${this.token}`;
        const res = await fetch(`${this.opts.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 401) throw new AuthenticationError((body as any)?.message ?? "unauthorized");
          throw new ApiError((body as any)?.message ?? `API ${path} -> ${res.status}`, res.status);
        }
        return body as T;
      } finally {
        clearTimeout(timer);
      }
    }, { shouldRetry: (e) => !(e instanceof AuthenticationError) });
  }

  // ---- public reads ----
  getStats(): Promise<Stats> {
    return this.request<Stats>("/stats");
  }

  /** The unified list of supported assets (native STX + registered SIP-10),
   *  validated and cached. On an unreachable/legacy API that lacks /assets,
   *  falls back to native STX only so existing STX flows never break. */
  async getAssets(force = false): Promise<AssetInfo[]> {
    if (!force && this.assetsCache && Date.now() - this.assetsCache.at < ApiProvider.ASSETS_TTL_MS) {
      return this.assetsCache.assets;
    }
    let assets: AssetInfo[];
    try {
      const r = await this.request<{ results: unknown[] }>("/assets");
      assets = (r.results ?? []).map(validateAsset);
      if (!assets.some((a) => a.native)) throw new Error("/assets returned no native STX asset");
    } catch (e) {
      // Backward compatibility: an older API (no /assets) still serves STX.
      this.opts.logger.warn?.("assets unavailable; falling back to native STX", { e: String(e) });
      assets = [];
    }
    this.assetsCache = { at: Date.now(), assets };
    return assets;
  }
  async getLatestRoot(): Promise<string | null> {
    try {
      const r = await this.request<{ root: string }>("/roots/latest");
      return r.root;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }
  async getAggregation(domainId: number, aggregationId: number): Promise<unknown | null> {
    void domainId;
    try {
      return await this.request(`/aggregations/${aggregationId}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }
  async getEncryptedNotes(limit = 200, offset = 0): Promise<EncryptedNoteRecord[]> {
    const r = await this.request<{ results: EncryptedNoteRecord[] }>(`/notes/encrypted?limit=${limit}&offset=${offset}`);
    return r.results ?? [];
  }
  /** All on-chain commitments in leaf-index order — for rebuilding the tree. */
  async getCommitments(): Promise<{ commitment: string; leafIndex: number }[]> {
    const r = await this.request<{ results: { commitment: string; leafIndex: number }[] }>(`/commitments`);
    return r.results ?? [];
  }

  // ---- authentication ----
  async authNonce(wallet: string): Promise<{ nonce: string; message: string }> {
    return this.request(`/auth/nonce`, { method: "POST", body: JSON.stringify({ wallet }) });
  }
  async authVerify(wallet: string, publicKey: string, signature: string, message: string): Promise<{ token: string; expiresAt: string }> {
    return this.request(`/auth/verify`, { method: "POST", body: JSON.stringify({ wallet, publicKey, signature, message }) });
  }
  async logout(): Promise<void> {
    if (this.token) await this.request(`/auth/logout`, { method: "POST", auth: true }).catch(() => {});
    this.token = undefined;
  }

  // ---- authenticated ----
  getMe(): Promise<{ wallet: string; notes: number }> {
    return this.request(`/me`, { auth: true });
  }
  async getMyNotes(): Promise<EncryptedNoteRecord[]> {
    const r = await this.request<{ results: EncryptedNoteRecord[] }>(`/me/notes`, { auth: true });
    return r.results ?? [];
  }
  async getMyHistory(): Promise<HistoryEntry[]> {
    const r = await this.request<{ results: HistoryEntry[] }>(`/me/history`, { auth: true });
    return r.results ?? [];
  }
  async registerNote(commitment: string, ciphertext: string): Promise<void> {
    await this.request(`/me/notes`, { method: "POST", auth: true, body: JSON.stringify({ commitment, ciphertext }) });
  }
  async markSpent(commitment: string): Promise<void> {
    // Send the bare hex (no 0x) in the path; the API matches either form. Let
    // errors propagate so the caller can log a failed mark instead of silently
    // leaving a spent note looking spendable.
    const bare = commitment.startsWith("0x") ? commitment.slice(2) : commitment;
    await this.request(`/me/notes/${bare}/spent`, { method: "POST", auth: true });
  }
}
