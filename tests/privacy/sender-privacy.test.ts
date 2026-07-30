import { describe, expect, it, vi } from "vitest";
import { Submitter, relayersFromEnv } from "../../sdk/submission/index.js";
import { RelayerClient } from "../../sdk/relayer/index.js";
import { TransactionBuilder, toRelayPayload } from "../../sdk/transactions/index.js";

/*
  Sender-privacy tests.

  The property: a spend must reach the chain WITHOUT the user's address on it.
  That means every spending operation routes through a relayer by default, and
  the only paths that expose the user are ones they explicitly chose.
*/

const b32 = (n: number, p = 0x11): Uint8Array => {
  const b = new Uint8Array(32);
  b[0] = p;
  b[31] = n & 0xff;
  return b;
};

const CONFIG = {
  contracts: {
    pool: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.privacy-pool",
    splitMerge: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.split-merge-manager",
  },
} as never;

const inclusion = { domainId: 1, aggregationId: 5, merklePath: [b32(1)], leafIndex: 0 };

const transferArgs = {
  nullifier: b32(1, 0x4e),
  newCommitment: b32(2, 0x3c),
  newOwnerCommitment: b32(2, 0x4f),
  newMetadata: b32(2, 0x4d),
  currentRoot: b32(1, 0x52),
  newRoot: b32(2, 0x52),
  inclusion,
};

const withdrawArgs = {
  nullifier: b32(3, 0x4e),
  amount: 10_000_000n,
  recipient: "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG",
  root: b32(1, 0x52),
  inclusion,
};

const acceptingRelayer = () =>
  new RelayerClient({
    relayers: [{ name: "R1", url: "http://r1" }],
    fetchImpl: vi.fn(async () =>
      new Response(JSON.stringify({ jobId: "job-1", operation: "transfer", state: "queued" }), {
        status: 202,
      }),
    ) as unknown as typeof fetch,
  });

describe("sender privacy", () => {
  it("relays spends by default -- the user's address never reaches the chain", async () => {
    const direct = vi.fn(async () => "0xdirect");
    const submitter = new Submitter({
      relayers: acceptingRelayer(),
      directSubmitter: direct,
    });
    const builder = new TransactionBuilder(CONFIG);

    const res = await submitter.transfer(transferArgs, builder.transfer(transferArgs));

    expect(res.mode).toBe("relayed");
    expect(res.senderExposed).toBe(false);
    expect(res.relayer).toBe("R1");
    // the user's own signer was never invoked
    expect(direct).not.toHaveBeenCalled();
  });

  it("relays withdrawals too -- the payout address is unlinked from the payer", async () => {
    const submitter = new Submitter({ relayers: acceptingRelayer() });
    const builder = new TransactionBuilder(CONFIG);
    const res = await submitter.withdraw(withdrawArgs, builder.withdraw(withdrawArgs));
    expect(res.mode).toBe("relayed");
    expect(res.senderExposed).toBe(false);
  });

  it("direct submission is possible but WARNS and flags the exposure", async () => {
    const warnings: string[] = [];
    const submitter = new Submitter({
      relayers: acceptingRelayer(),
      directSubmitter: async () => "0xdirect",
      onPrivacyWarning: (m) => warnings.push(m),
    });
    const builder = new TransactionBuilder(CONFIG);

    const res = await submitter.transfer(transferArgs, builder.transfer(transferArgs), {
      direct: true,
    });

    expect(res.mode).toBe("direct");
    expect(res.senderExposed).toBe(true);
    expect(res.txid).toBe("0xdirect");
    // silently degrading privacy would be the worst outcome; it must be loud
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/link this spend to your address/);
  });

  it("with no relayer configured it warns rather than silently exposing", async () => {
    const warnings: string[] = [];
    const submitter = new Submitter({
      directSubmitter: async () => "0xdirect",
      onPrivacyWarning: (m) => warnings.push(m),
    });
    const builder = new TransactionBuilder(CONFIG);
    const res = await submitter.transfer(transferArgs, builder.transfer(transferArgs));
    expect(res.senderExposed).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it("refuses to submit at all when neither relayer nor signer exists", async () => {
    const submitter = new Submitter({});
    const builder = new TransactionBuilder(CONFIG);
    await expect(
      submitter.transfer(transferArgs, builder.transfer(transferArgs)),
    ).rejects.toThrow(/no relayer configured/);
  });

  it("honours a pinned relayer", async () => {
    const client = new RelayerClient({
      relayers: [
        { name: "R1", url: "http://r1" },
        { name: "R2", url: "http://r2" },
      ],
      fetchImpl: vi.fn(async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify({
            jobId: String(input).includes("r2") ? "j2" : "j1",
            operation: "transfer",
            state: "queued",
          }),
          { status: 202 },
        ),
      ) as unknown as typeof fetch,
    });
    const submitter = new Submitter({ relayers: client });
    const builder = new TransactionBuilder(CONFIG);
    const res = await submitter.transfer(transferArgs, builder.transfer(transferArgs), {
      relayer: "R2",
    });
    expect(res.relayer).toBe("R2");
  });

  it("shield is always direct -- it spends the user's transparent STX", async () => {
    const submitter = new Submitter({
      relayers: acceptingRelayer(),
      directSubmitter: async () => "0xshield",
    });
    const builder = new TransactionBuilder(CONFIG);
    const call = builder.shield({
      amount: 50_000_000n,
      commitment: b32(1, 0x3c),
      ownerCommitment: b32(1, 0x4f),
      metadata: b32(1, 0x4d),
      currentRoot: b32(1, 0x52),
      newRoot: b32(2, 0x52),
      inclusion,
    });
    const res = await submitter.submitShield(call);
    // A deposit is public by nature; privacy begins once the note is pooled.
    expect(res.mode).toBe("direct");
    expect(res.txid).toBe("0xshield");
  });
});

describe("relay payloads", () => {
  it("carry every field the contract binds, and no note id", () => {
    const payload = toRelayPayload.transfer(transferArgs);
    expect(payload.nullifier).toMatch(/^0x[0-9a-f]{64}$/);
    expect(payload.newCommitment).toBeDefined();
    expect(payload.inclusion.aggregationId).toBe(5);
    // the leak that made the graph public must not reappear in the relay path
    expect(JSON.stringify(payload)).not.toMatch(/oldNote|noteId/i);
  });

  it("withdraw payload carries the recipient the proof commits to", () => {
    const payload = toRelayPayload.withdraw(withdrawArgs);
    expect(payload.recipient).toBe(withdrawArgs.recipient);
    expect(payload.amount).toBe("10000000");
  });
});

describe("relayer configuration from env", () => {
  it("parses a name=url list", () => {
    const client = relayersFromEnv("R1=https://a.example,R2=https://b.example");
    expect(client).toBeInstanceOf(RelayerClient);
  });

  it("accepts bare urls and auto-names them", () => {
    expect(relayersFromEnv("https://a.example,https://b.example")).toBeInstanceOf(RelayerClient);
  });

  it("returns undefined when unset, so callers can detect the direct path", () => {
    expect(relayersFromEnv(undefined)).toBeUndefined();
    expect(relayersFromEnv("   ")).toBeUndefined();
  });
});
