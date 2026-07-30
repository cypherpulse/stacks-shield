// =============================================================================
// @stx-shield/sdk -- public API provider
// =============================================================================
// Read-only protocol data + wallet authentication. Never sends secrets.

import { ApiError, AuthenticationError } from "../errors/index.js";
import { retry } from "../utils/retry.js";
import type { Logger } from "../utils/logger.js";
import type { Stats, HistoryEntry } from "../types/response.js";

export interface EncryptedNoteRecord {
  commitment: string;
  ciphertext: string | null;
  root: string;
  txid: string;
}

export interface ApiProviderOptions {
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
}

export class ApiProvider {
  private token?: string;
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
        const headers: Record<string, string> = { "Content-Type": "application/json", ...(init?.headers as Record<string, string>) };
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
    await this.request(`/me/notes/${commitment}/spent`, { method: "POST", auth: true }).catch(() => {});
  }
}
