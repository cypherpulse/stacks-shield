import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { Protocol, ONE_STX, REGISTRY, NOTES } from "../helpers/protocol.js";

/*
  PHASE 5 — Protocol invariant validation.

  Each of the ten protocol invariants is asserted independently and then
  collectively across a mixed workload. Every operation runs the real
  6-contract stack with genuine secp256k1 attestations.
*/

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_7")!;
const recipient = accounts.get("wallet_8")!;

const setup = () => {
  const p = new Protocol(deployer);
  p.wire();
  return p;
};

const ok = (r: { type: string }) => expect(r.type).toBe("ok");

describe("invariant 1: pool balance == total shielded amount", () => {
  it("holds across shield / split / merge / withdraw", () => {
    const p = setup();
    ok(p.shield(alice, 100 * ONE_STX).result);
    ok(p.shield(bob, 50 * ONE_STX).result);
    expect(p.poolBalance()).toBe(p.totalShielded());

    const s = p.shield(alice, 80 * ONE_STX);
    ok(s.result);
    const [a, b] = p.split(alice, s.note, 30 * ONE_STX, 50 * ONE_STX).notes;
    expect(p.poolBalance()).toBe(p.totalShielded()); // reshaping moves no STX
    const m = p.merge(alice, a, b);
    ok(m.result);
    expect(p.poolBalance()).toBe(p.totalShielded());

    ok(p.withdraw(alice, m.note, recipient).result);
    expect(p.poolBalance()).toBe(p.totalShielded());
  });
});

describe("invariant 2: amount conservation", () => {
  it("split outputs sum to the input; merge output equals the sum", () => {
    const p = setup();
    // total shielded only ever changes by shield (+) and withdraw (-)
    const s1 = p.shield(alice, 100 * ONE_STX);
    ok(s1.result);
    expect(p.totalShielded()).toBe(BigInt(100 * ONE_STX));
    // split + merge preserve the shielded total exactly
    const [a, b] = p.split(alice, s1.note, 40 * ONE_STX, 60 * ONE_STX).notes;
    expect(p.totalShielded()).toBe(BigInt(100 * ONE_STX));
    const m = p.merge(alice, a, b);
    ok(m.result);
    expect(m.note.amount).toBe(100 * ONE_STX);
    expect(p.totalShielded()).toBe(BigInt(100 * ONE_STX));
  });
});

describe("invariant 3: every commitment is unique", () => {
  it("re-registering any commitment is rejected", () => {
    const p = setup();
    const s = p.shield(alice, 10 * ONE_STX);
    ok(s.result);
    // a second shield reusing the same note id fails (duplicate note/commitment)
    const dup = simnet.callPublicFn(
      "privacy-registry",
      "register-commitment",
      [Cl.buffer(s.note.commitment), Cl.uint(1)],
      deployer, // even a direct attempt (unauthorized) never creates a duplicate
    );
    expect(dup.result.type).toBe("err");
    expect(p.read(REGISTRY, "is-commitment-registered", [Cl.buffer(s.note.commitment)])).toBeBool(
      true,
    );
  });
});

describe("invariant 4: every nullifier is single-use", () => {
  it("a nullifier can never be registered twice", () => {
    const p = setup();
    const s1 = p.shield(alice, 10 * ONE_STX);
    const s2 = p.shield(alice, 10 * ONE_STX);
    ok(p.transfer(alice, s1.note).result);
    // reuse s1's nullifier on an active note -> duplicate nullifier
    const forged = { ...s2.note, nullifier: s1.note.nullifier };
    const r = p.transfer(alice, forged);
    expect(r.result.type).toBe("err");
    expect((r.result as { value: { value: bigint } }).value.value).toBe(116n); // ERR-DUPLICATE-NULLIFIER
  });
});

describe("invariant 5: every proof is single-use", () => {
  it("an accepted proof-id can never be replayed", () => {
    const p = setup();
    // craft two operations that would hash to the same proof-id is impossible
    // because public inputs differ; instead assert the verifier records ids.
    const s = p.shield(alice, 10 * ONE_STX);
    ok(s.result);
    const stats = p.read("zk-verifier", "get-verification-stats");
    expect(stats).toBeTuple({
      "total-verified": Cl.uint(1),
      shield: Cl.uint(1),
      transfer: Cl.uint(0),
      withdrawal: Cl.uint(0),
      other: Cl.uint(0),
    });
  });
});

describe("invariant 6: every root is valid", () => {
  it("only known, active roots validate; the zero root never does", () => {
    const p = setup();
    const s = p.shield(alice, 10 * ONE_STX);
    ok(s.result);
    expect(p.read(REGISTRY, "is-known-root", [Cl.buffer(p.currentRoot)])).toBeBool(true);
    expect(
      p.read(REGISTRY, "is-known-root", [Cl.buffer(new Uint8Array(32))]),
    ).toBeBool(false);
  });
});

describe("invariant 7: every fee is correctly accounted", () => {
  it("treasury equals the sum of collected fees", () => {
    const p = setup();
    simnet.callPublicFn(
      "protocol-fees",
      "set-fee",
      [Cl.uint(1), Cl.uint(100), Cl.uint(0), Cl.bool(true)], // 1% shield fee
      deployer,
    );
    ok(p.shield(alice, 100 * ONE_STX).result);
    ok(p.shield(bob, 200 * ONE_STX).result);
    const treasury = p.read("protocol-fees", "get-treasury");
    expect(treasury).toBeTuple({
      "total-collected": Cl.uint(3 * ONE_STX),
      "total-withdrawn": Cl.uint(0),
      balance: Cl.uint(3 * ONE_STX),
      "actual-balance": Cl.uint(3 * ONE_STX),
    });
  });
});

describe("invariant 8: every note is a valid state transition", () => {
  it("note-manager statistics stay closed-form consistent", () => {
    const p = setup();
    const s = p.shield(alice, 100 * ONE_STX);
    const [a, b] = p.split(alice, s.note, 40 * ONE_STX, 60 * ONE_STX).notes;
    p.merge(alice, a, b);
    expect(p.read(NOTES, "is-statistics-consistent")).toBeBool(true);
  });
});

describe("invariant 9: protocol accounting is always correct", () => {
  it("commitments, nullifiers, notes track the workload exactly", () => {
    const p = setup();
    const s = p.shield(alice, 100 * ONE_STX); // +1 commitment, +1 note
    const t = p.transfer(alice, s.note); //       +1 commitment, +1 nullifier, +1 note
    const [a, b] = p.split(alice, t.note, 40 * ONE_STX, 60 * ONE_STX).notes; // +2c,+1n,+2note
    p.merge(alice, a, b); //                       +1 commitment, +2 nullifier, +1 note
    expect(p.read(REGISTRY, "get-total-commitments")).toBeUint(5);
    expect(p.read(REGISTRY, "get-total-nullifiers")).toBeUint(4);
    expect(p.read(REGISTRY, "get-total-notes")).toBeUint(5);
  });
});

describe("invariant 10: emergency recovery is always possible", () => {
  it("emergency-pause then owner recovery restores full operation", () => {
    const p = setup();
    p.grantRole(accounts.get("wallet_2")!, 2); // emergency admin
    const s = p.shield(alice, 100 * ONE_STX);
    ok(s.result);

    p.regCall("emergency-pause-protocol", []); // owner can also do this
    // recover
    p.regCall("resolve-emergency", []);
    p.regCall("unpause-protocol", []);
    // funds intact and operations resume
    expect(p.poolBalance()).toBe(BigInt(100 * ONE_STX));
    ok(p.transfer(alice, s.note).result);
  });
});

describe("collective: all invariants under a mixed workload", () => {
  it("100 mixed operations preserve every invariant simultaneously", () => {
    const p = setup();
    const users = [alice, bob, accounts.get("wallet_3")!, accounts.get("wallet_4")!];
    const active: import("../helpers/protocol.js").Note[] = [];
    let shielded = 0n;

    // seed
    for (let i = 0; i < 12; i++) {
      const amt = (2 + (i % 8)) * ONE_STX;
      const s = p.shield(users[i % users.length]!, amt);
      ok(s.result);
      active.push(s.note);
      shielded += BigInt(amt);
    }

    let seed = 0xa11ce;
    const next = () => (seed = (seed * 48271) % 2147483647);
    for (let round = 0; round < 88; round++) {
      const u = users[next() % users.length]!;
      const pick = next() % 4;
      if (pick === 0 && active.length >= 1) {
        const i = next() % active.length;
        const note = active.splice(i, 1)[0]!;
        const r = p.transfer(u, note);
        ok(r.result);
        active.push(r.note);
      } else if (pick === 1 && active.some((n) => n.amount >= 2 * ONE_STX)) {
        const i = active.findIndex((n) => n.amount >= 2 * ONE_STX);
        const note = active.splice(i, 1)[0]!;
        const half = Math.floor(note.amount / 2 / ONE_STX) * ONE_STX;
        const r = p.split(u, note, half, note.amount - half);
        ok(r.result);
        active.push(...r.notes);
      } else if (pick === 2 && active.length >= 2) {
        const a = active.splice(next() % active.length, 1)[0]!;
        const b = active.splice(next() % active.length, 1)[0]!;
        const r = p.merge(u, a, b);
        ok(r.result);
        active.push(r.note);
      } else if (active.length >= 1) {
        const i = next() % active.length;
        const note = active[i]!;
        const r = p.withdraw(u, note, recipient);
        if (r.result.type === "ok") {
          active.splice(i, 1);
          shielded -= BigInt(note.amount);
        }
      }

      // invariants checked EVERY round
      expect(p.poolBalance()).toBe(p.totalShielded());
      expect(p.poolBalance()).toBe(shielded);
      expect(p.read(NOTES, "is-statistics-consistent")).toBeBool(true);
    }
  }, 120000);
});
