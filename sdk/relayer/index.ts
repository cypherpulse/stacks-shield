// =============================================================================
// STX Shield SDK -- relayer client
// =============================================================================
// Submits an operation through a relayer so the user's address never appears
// on chain. Supports several relayers with automatic failover:
//
//   await protocol.transfer({ relayer: "random" })   // pick one at random
//   await protocol.transfer({ relayer: "R1" })       // pin a specific relayer
//   await protocol.transfer()                        // default policy
//
// Failover is what makes censorship a non-issue: if R1 refuses or is down,
// the SDK moves to R2, then R3. Because every operation parameter is bound
// into the zkVerify statement, ANY relayer submits the identical transaction —
// there is nothing for one to gain by tampering, and nothing lost by
// switching.

export interface RelayerEndpoint {
  /** Stable name used by `{ relayer: "R1" }`. */
  name: string;
  url: string;
  /** Lower is preferred in "ordered" mode. */
  priority?: number;
}

export type RelayerSelection = "random" | "ordered" | (string & {});

export interface RelayerClientConfig {
  relayers: RelayerEndpoint[];
  /** Default selection strategy. */
  selection?: RelayerSelection;
  /** Per-relayer timeout before failing over. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RelaySubmission {
  jobId: string;
  operation: string;
  state: string;
  /** Which relayer accepted it — useful for status polling and diagnostics. */
  relayer: string;
}

export class NoRelayerAvailableError extends Error {
  readonly attempts: { relayer: string; error: string }[];
  constructor(attempts: { relayer: string; error: string }[]) {
    super(
      `no relayer accepted the operation (tried ${attempts.length}): ` +
        attempts.map((a) => `${a.relayer}: ${a.error}`).join("; "),
    );
    this.attempts = attempts;
  }
}

export class RelayerClient {
  private readonly relayers: RelayerEndpoint[];
  private readonly selection: RelayerSelection;
  private readonly timeoutMs: number;
  private readonly http: typeof fetch;

  constructor(cfg: RelayerClientConfig) {
    if (cfg.relayers.length === 0) throw new Error("at least one relayer is required");
    this.relayers = [...cfg.relayers];
    this.selection = cfg.selection ?? "random";
    this.timeoutMs = cfg.timeoutMs ?? 20_000;
    this.http = cfg.fetchImpl ?? fetch;
  }

  /** Candidate order for this attempt, honouring an explicit pin. */
  private order(selection: RelayerSelection): RelayerEndpoint[] {
    if (selection !== "random" && selection !== "ordered") {
      const pinned = this.relayers.find((r) => r.name === selection);
      if (!pinned) throw new Error(`unknown relayer "${selection}"`);
      // Still fall back to the others: pinning expresses a preference, not a
      // dependency. A pinned relayer that is down must not strand the user.
      return [pinned, ...this.relayers.filter((r) => r.name !== selection)];
    }
    const rest = [...this.relayers];
    if (selection === "ordered") {
      return rest.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    }
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i]!, rest[j]!] = [rest[j]!, rest[i]!];
    }
    return rest;
  }

  /** Submit, failing over until one relayer accepts. */
  async submit(
    operation: string,
    body: unknown,
    selection: RelayerSelection = this.selection,
  ): Promise<RelaySubmission> {
    const attempts: { relayer: string; error: string }[] = [];

    for (const relayer of this.order(selection)) {
      try {
        const res = await this.post(`${relayer.url}/${operation}`, body);
        if (res.ok) {
          const accepted = (await res.json()) as Omit<RelaySubmission, "relayer">;
          return { ...accepted, relayer: relayer.name };
        }
        const err = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        // A request the CHAIN would reject (bad root, spent nullifier) fails
        // identically everywhere — failing over just wastes time, so stop.
        if (res.status === 400 || res.status === 409) {
          throw new NoRelayerAvailableError([
            { relayer: relayer.name, error: err.message ?? err.error ?? `http ${res.status}` },
          ]);
        }
        attempts.push({
          relayer: relayer.name,
          error: err.message ?? err.error ?? `http ${res.status}`,
        });
      } catch (e) {
        if (e instanceof NoRelayerAvailableError) throw e;
        attempts.push({ relayer: relayer.name, error: (e as Error).message });
      }
    }
    throw new NoRelayerAvailableError(attempts);
  }

  async status(relayerName: string, jobId: string): Promise<unknown> {
    const relayer = this.relayers.find((r) => r.name === relayerName);
    if (!relayer) throw new Error(`unknown relayer "${relayerName}"`);
    const res = await this.http(`${relayer.url}/status/${jobId}`);
    return res.json();
  }

  /** Relayers currently reachable and accepting work. */
  async available(): Promise<RelayerEndpoint[]> {
    const checks = await Promise.all(
      this.relayers.map(async (r) => {
        try {
          const res = await this.http(`${r.url}/info`);
          if (!res.ok) return null;
          const info = (await res.json()) as { accepting?: boolean };
          return info.accepting === false ? null : r;
        } catch {
          return null;
        }
      }),
    );
    return checks.filter((r): r is RelayerEndpoint => r !== null);
  }

  private async post(url: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.http(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
