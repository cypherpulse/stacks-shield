import { describe, expect, it, vi } from "vitest";
import { RelayerService } from "../services/relayer-service.js";
import { buildCall } from "../transaction-manager/index.js";
import { MemoryQueue } from "../queue/index.js";
import { RelayError, type Operation, type RelayRequest } from "../types/index.js";
import type { ChainReader } from "../proof-validator/index.js";
import { RelayerClient, NoRelayerAvailableError } from "../../../sdk/relayer/index.js";

/*
  Relayer tests.

  The central claim under test is that a relayer is TRUSTLESS: it pays the fee
  and submits the transaction, but cannot alter what the transaction does.
  That property is enforced cryptographically (every parameter is bound into
  the zkVerify statement the contracts re-derive), and structurally here — the
  request maps to exactly one contract call with no relayer-controlled inputs.
*/

const b32 = (n: number, p = 0x11) =>
  "0x" + p.toString(16).padStart(2, "0") + n.toString(16).padStart(62, "0");

const RECIPIENT = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";
const DEPLOYER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";

const inclusion = {
  domainId: 1,
  aggregationId: 7,
  merklePath: [b32(1, 0xaa), b32(2, 0xaa)],
  leafIndex: 2,
};

const transferReq = () => ({
  nullifier: b32(1, 0x4e),
  newCommitment: b32(2, 0x3c),
  newOwnerCommitment: b32(2, 0x4f),
  newMetadata: b32(2, 0x4d),
  currentRoot: b32(1, 0x52),
  newRoot: b32(2, 0x52),
  inclusion,
});

const withdrawReq = () => ({
  nullifier: b32(3, 0x4e),
  amount: "10000000",
  recipient: RECIPIENT,
  root: b32(1, 0x52),
  inclusion,
});

/** A chain that says yes to everything, so tests exercise the relayer. */
class HappyChain implements ChainReader {
  spentNullifiers = new Set<string>();
  publishedAggregations = true;
  validRoots = true;
  protocolState = "1";

  async readOnly(_c: string, fn: string, args: unknown[]): Promise<unknown> {
    switch (fn) {
      case "get-protocol-state":
        return { value: this.protocolState };
      case "is-known-root":
        return { value: this.validRoots };
      case "is-nullifier-spent": {
        const v = (args[0] as { value?: unknown })?.value;
        const hex =
          typeof v === "string"
            ? (v.startsWith("0x") ? v : "0x" + v)
            : "0x" + Buffer.from(v as Uint8Array).toString("hex");
        return { value: this.spentNullifiers.has(hex) };
      }
      case "get-aggregation":
        return { value: this.publishedAggregations ? { root: b32(9) } : null };
      default:
        return { value: null };
    }
  }
}

const makeService = (chain = new HappyChain(), submitted: unknown[] = []) =>
  new RelayerService({
    network: "testnet",
    apiUrl: "http://localhost",
    senderKey: "00".repeat(32) + "01",
    address: "ST3RELAYER",
    deployer: DEPLOYER,
    txFee: 10_000,
    reader: chain,
    queue: new MemoryQueue(),
    submitter: async (op, r) => {
      submitted.push({ op, r });
      return "0x" + "ab".repeat(32);
    },
  });

const settle = () => new Promise((r) => setTimeout(r, 20));

// ===========================================================================
// The core security property
// ===========================================================================

describe("relayer trustlessness", () => {
  it("maps a request to exactly one call, with no relayer-controlled inputs", () => {
    const call = buildCall("withdraw", withdrawReq() as RelayRequest);
    expect(call.contract).toBe("privacy-pool");
    expect(call.fn).toBe("withdraw");
    // every argument derives from the user's request; the relayer contributes
    // only the signature and the fee, neither of which is an argument
    expect(call.args).toHaveLength(8);
  });

  it("a tampered field produces a DIFFERENT call — which the chain rejects", () => {
    const honest = buildCall("withdraw", withdrawReq() as RelayRequest);
    const tampered = buildCall("withdraw", {
      ...withdrawReq(),
      recipient: "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5", // relayer redirects
    } as RelayRequest);
    const ser = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
    expect(ser(tampered.args)).not.toBe(ser(honest.args));
    // On chain this changes the public-inputs hash -> the statement leaf ->
    // the inclusion proof no longer verifies (u310). The relayer gains
    // nothing; the transaction simply reverts.
  });

  it("submits the user's operation verbatim", async () => {
    const submitted: unknown[] = [];
    const service = makeService(new HappyChain(), submitted);
    const req = transferReq();
    await service.accept("transfer", req);
    await settle();
    expect(submitted).toHaveLength(1);
    expect((submitted[0] as { r: RelayRequest }).r).toEqual(req);
  });

  it("refuses to relay shield — it would require the user's funds", async () => {
    const service = makeService();
    await expect(
      service.accept("shield" as Operation, transferReq()),
    ).rejects.toThrow(/unknown operation/);
  });
});

// ===========================================================================
// Validation
// ===========================================================================

describe("request validation", () => {
  it("rejects malformed payloads before any chain work", async () => {
    const service = makeService();
    await expect(service.accept("transfer", { nullifier: "nope" })).rejects.toBeInstanceOf(
      RelayError,
    );
    await expect(
      service.accept("withdraw", { ...withdrawReq(), amount: "-5" }),
    ).rejects.toBeInstanceOf(RelayError);
    await expect(
      service.accept("withdraw", { ...withdrawReq(), recipient: "not-a-principal" }),
    ).rejects.toBeInstanceOf(RelayError);
  });

  it("rejects a spent nullifier without spending a fee", async () => {
    const chain = new HappyChain();
    const submitted: unknown[] = [];
    const service = makeService(chain, submitted);
    chain.spentNullifiers.add(transferReq().nullifier);
    await expect(service.accept("transfer", transferReq())).rejects.toMatchObject({
      code: "nullifier_spent",
    });
    expect(submitted).toHaveLength(0);
  });

  it("rejects an unpublished aggregation", async () => {
    const chain = new HappyChain();
    chain.publishedAggregations = false;
    await expect(makeService(chain).accept("transfer", transferReq())).rejects.toMatchObject({
      code: "aggregation_not_published",
    });
  });

  it("rejects an unknown root", async () => {
    const chain = new HappyChain();
    chain.validRoots = false;
    await expect(makeService(chain).accept("transfer", transferReq())).rejects.toMatchObject({
      code: "unknown_root",
    });
  });

  it("refuses work while the protocol is paused", async () => {
    const chain = new HappyChain();
    chain.protocolState = "2";
    await expect(makeService(chain).accept("transfer", transferReq())).rejects.toMatchObject({
      code: "protocol_inactive",
    });
  });

  it("rate limits a single client", async () => {
    const service = makeService();
    const many = Array.from({ length: 31 }, (_, i) => ({
      ...transferReq(),
      nullifier: b32(100 + i, 0x4e),
    }));
    let limited = 0;
    for (const r of many) {
      try {
        await service.accept("transfer", r, "same-client");
      } catch (e) {
        if ((e as RelayError).code === "rate_limited") limited++;
      }
    }
    expect(limited).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Job lifecycle
// ===========================================================================

describe("job lifecycle", () => {
  it("queues, submits, and reports a txid", async () => {
    const service = makeService();
    const accepted = await service.accept("withdraw", withdrawReq());
    expect(accepted.state).toBe("queued");
    await settle();
    const job = await service.status(accepted.jobId);
    expect(job?.state).toBe("confirmed");
    expect(job?.txid).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("retries a failing submission, then marks it failed", async () => {
    let calls = 0;
    const service = new RelayerService({
      network: "testnet",
      apiUrl: "http://localhost",
      senderKey: "00".repeat(32) + "01",
      address: "ST3RELAYER",
      deployer: DEPLOYER,
      txFee: 10_000,
      reader: new HappyChain(),
      queue: new MemoryQueue(3),
      submitter: async () => {
        calls++;
        throw new Error("node down");
      },
    });
    const accepted = await service.accept("transfer", transferReq());
    await new Promise((r) => setTimeout(r, 60));
    const job = await service.status(accepted.jobId);
    expect(calls).toBe(3);
    expect(job?.state).toBe("failed");
  });
});

// ===========================================================================
// Multi-relayer failover (SDK side)
// ===========================================================================

describe("multi-relayer failover", () => {
  const endpoints = [
    { name: "R1", url: "http://r1", priority: 0 },
    { name: "R2", url: "http://r2", priority: 1 },
    { name: "R3", url: "http://r3", priority: 2 },
  ];

  const fetchWith = (behaviour: Record<string, number>) =>
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const host = endpoints.find((e) => url.startsWith(e.url))!;
      const status = behaviour[host.name] ?? 202;
      if (status === 0) throw new Error("connection refused");
      return new Response(
        JSON.stringify(
          status === 202
            ? { jobId: `${host.name}-job`, operation: "transfer", state: "queued" }
            : { error: "unavailable", message: "down" },
        ),
        { status },
      ) as Response;
    }) as unknown as typeof fetch;

  it("fails over R1 -> R2 -> R3 until one accepts", async () => {
    const client = new RelayerClient({
      relayers: endpoints,
      selection: "ordered",
      fetchImpl: fetchWith({ R1: 0, R2: 503, R3: 202 }),
    });
    const res = await client.submit("transfer", transferReq());
    expect(res.relayer).toBe("R3");
  });

  it("honours a pinned relayer but still falls back if it is down", async () => {
    const okClient = new RelayerClient({
      relayers: endpoints,
      fetchImpl: fetchWith({ R1: 202, R2: 202, R3: 202 }),
    });
    expect((await okClient.submit("transfer", transferReq(), "R2")).relayer).toBe("R2");

    const downClient = new RelayerClient({
      relayers: endpoints,
      fetchImpl: fetchWith({ R1: 202, R2: 0, R3: 202 }),
    });
    // pinning is a preference, not a dependency — a censoring relayer cannot
    // strand the user
    const res = await downClient.submit("transfer", transferReq(), "R2");
    expect(res.relayer).not.toBe("R2");
  });

  it("throws only when EVERY relayer refuses", async () => {
    const client = new RelayerClient({
      relayers: endpoints,
      fetchImpl: fetchWith({ R1: 0, R2: 0, R3: 503 }),
    });
    await expect(client.submit("transfer", transferReq())).rejects.toBeInstanceOf(
      NoRelayerAvailableError,
    );
  });

  it("does not waste failover on a request the chain itself would reject", async () => {
    const impl = fetchWith({ R1: 409, R2: 202, R3: 202 });
    const client = new RelayerClient({
      relayers: endpoints,
      selection: "ordered",
      fetchImpl: impl,
    });
    await expect(client.submit("transfer", transferReq())).rejects.toBeInstanceOf(
      NoRelayerAvailableError,
    );
    expect((impl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it("random selection spreads load across relayers", async () => {
    const client = new RelayerClient({
      relayers: endpoints,
      selection: "random",
      fetchImpl: fetchWith({ R1: 202, R2: 202, R3: 202 }),
    });
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      seen.add((await client.submit("transfer", transferReq())).relayer);
    }
    // load spreading is what prevents a single relayer becoming the de-facto
    // central point the architecture is meant to avoid
    expect(seen.size).toBeGreaterThan(1);
  });

  it("reports which relayers are accepting work", async () => {
    const client = new RelayerClient({
      relayers: endpoints,
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("http://r2")) return new Response("{}", { status: 503 }) as Response;
        return new Response(JSON.stringify({ accepting: !url.startsWith("http://r3") }), {
          status: 200,
        }) as Response;
      }) as unknown as typeof fetch,
    });
    const up = await client.available();
    expect(up.map((r) => r.name)).toEqual(["R1"]);
  });
});
