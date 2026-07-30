import { describe, expect, it } from "vitest";
import { MemoryQueue } from "../queue/index.js";
import type { RelayRequest } from "../types/index.js";

const req = {} as RelayRequest;
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe("MemoryQueue retries + dead-letter", () => {
  it("retries up to maxAttempts then dead-letters", async () => {
    const q = new MemoryQueue(3);
    let calls = 0;
    q.process(async () => {
      calls++;
      throw new Error("boom");
    });
    const job = await q.add("transfer", req);
    await settle();

    expect(calls).toBe(3);
    const final = await q.get(job.id);
    expect(final?.state).toBe("failed");
    expect(final?.attempts).toBe(3);

    const dead = await q.deadLetter();
    expect(dead.map((j) => j.id)).toContain(job.id);
  });

  it("does not dead-letter a job that eventually succeeds", async () => {
    const q = new MemoryQueue(3);
    let calls = 0;
    q.process(async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
    });
    const job = await q.add("withdraw", req);
    await settle();

    const final = await q.get(job.id);
    expect(final?.state).not.toBe("failed");
    expect((await q.deadLetter()).map((j) => j.id)).not.toContain(job.id);
  });
});
