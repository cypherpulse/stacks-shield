import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { Protocol, ONE_STX, NOTES, REGISTRY, type Note } from "../helpers/protocol.js";

/*
  PHASE 5 — Fuzz, randomized & scaled stress testing.

  A deterministic PRNG drives long randomized workloads of mixed operations
  and malformed inputs against the real 6-contract stack. Every accepted
  operation must preserve conservation and note-statistics consistency; every
  malformed operation must be rejected without corrupting state.

  Scale note: these run in the single-threaded simnet with real secp256k1
  verification (~tens of ms per full operation). They validate invariant
  PRESERVATION over hundreds of operations across many users — the same code
  paths a mainnet-scale workload exercises. See docs/analysis/release-candidate.md
  for how this maps to the Phase 5 large-scale targets.
*/

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const users = [
  accounts.get("wallet_1")!,
  accounts.get("wallet_3")!,
  accounts.get("wallet_4")!,
  accounts.get("wallet_7")!,
];
const recipient = accounts.get("wallet_8")!;

const mkRng = (seedInit: number) => {
  let seed = seedInit % 2147483647;
  if (seed <= 0) seed += 2147483646;
  return () => (seed = (seed * 48271) % 2147483647);
};

const setup = () => {
  const p = new Protocol(deployer);
  p.wire();
  return p;
};

describe("fuzz: malformed inputs are always rejected without state corruption", () => {
  it("random zero-valued and malformed operations fail cleanly", () => {
    const p = setup();
    const seed = p.shield(users[0]!, 100 * ONE_STX);
    expect(seed.result.type).toBe("ok");
    const before = p.read(REGISTRY, "get-statistics");

    const rng = mkRng(0xf0);
    for (let i = 0; i < 30; i++) {
      const kind = rng() % 5;
      if (kind === 0) {
        // zero-amount shield
        const r = p.shield(users[rng() % users.length]!, 0);
        expect(r.result.type).toBe("err");
      } else if (kind === 1) {
        // below-minimum shield (< 1 STX)
        const r = p.shield(users[rng() % users.length]!, (rng() % 999_999) + 1);
        expect(r.result.type).toBe("err");
      } else if (kind === 2 || kind === 3) {
        // NOTE: spending a non-existent note is NOT a contract-level check any
        // more, and must not be. Note ids are private, so the contracts cannot
        // tell which leaf a spend consumes -- membership is enforced INSIDE
        // the circuit (assert_merkle_membership). The harness fabricates
        // proofs, so it cannot exercise that gate; the circuits do.
        // What the contracts still guarantee is nullifier uniqueness, covered
        // by the double-spend cases in tests/attacks.
        const r = p.shield(users[rng() % users.length]!, 0);
        expect(r.result.type).toBe("err");
      } else {
        // merge a note with itself (duplicate input)
        const r = p.merge(users[rng() % users.length]!, seed.note, seed.note);
        expect(r.result.type).toBe("err");
      }
    }

    // state is exactly as it was before the malformed barrage
    expect(p.read(REGISTRY, "get-statistics")).toStrictEqual(before);
    expect(p.read(NOTES, "is-statistics-consistent")).toBeBool(true);
    // the seed note is still active and spendable
    expect(p.read(NOTES, "is-note-active", [Cl.buffer(seed.note.commitment)])).toBeBool(true);
  }, 60000);
});

describe("stress: randomized mixed workload preserves all invariants", () => {
  it("300 mixed operations across 4 users, invariants checked continuously", () => {
    const p = setup();
    const rng = mkRng(0x57a11);
    const active: Note[] = [];
    let shielded = 0n;
    let accepted = 0;

    // seed with 24 notes
    for (let i = 0; i < 24; i++) {
      const amt = (2 + (i % 10)) * ONE_STX;
      const r = p.shield(users[i % users.length]!, amt);
      expect(r.result.type).toBe("ok");
      active.push(r.note);
      shielded += BigInt(amt);
      accepted++;
    }

    for (let round = 0; round < 276; round++) {
      const u = users[rng() % users.length]!;
      const op = rng() % 4;
      let performed = false;

      if (op === 0 && active.length > 0) {
        const i = rng() % active.length;
        const note = active.splice(i, 1)[0]!;
        const r = p.transfer(u, note);
        expect(r.result.type).toBe("ok");
        active.push(r.note);
        performed = true;
      } else if (op === 1 && active.some((n) => n.amount >= 2 * ONE_STX)) {
        const i = active.findIndex((n) => n.amount >= 2 * ONE_STX);
        const note = active.splice(i, 1)[0]!;
        const half = Math.floor(note.amount / 2 / ONE_STX) * ONE_STX;
        const r = p.split(u, note, half, note.amount - half);
        expect(r.result.type).toBe("ok");
        active.push(...r.notes);
        performed = true;
      } else if (op === 2 && active.length >= 2) {
        const a = active.splice(rng() % active.length, 1)[0]!;
        const b = active.splice(rng() % active.length, 1)[0]!;
        const r = p.merge(u, a, b);
        expect(r.result.type).toBe("ok");
        active.push(r.note);
        performed = true;
      } else if (op === 3 && active.length > 0) {
        const i = rng() % active.length;
        const note = active[i]!;
        const r = p.withdraw(u, note, recipient);
        expect(r.result.type).toBe("ok");
        active.splice(i, 1);
        shielded -= BigInt(note.amount);
        performed = true;
      }

      // fallback: if the chosen op could not run, shield — so every round
      // performs a real operation and the workload stays dense
      if (!performed) {
        const amt = (2 + (rng() % 10)) * ONE_STX;
        const r = p.shield(u, amt);
        expect(r.result.type).toBe("ok");
        active.push(r.note);
        shielded += BigInt(amt);
      }
      accepted++;

      // continuous invariant checks
      expect(p.poolBalance()).toBe(shielded);
      expect(p.poolBalance()).toBe(p.totalShielded());
    }

    // final consistency: 24 seed shields + 276 rounds, one real op each
    expect(p.read(NOTES, "is-statistics-consistent")).toBeBool(true);
    expect(accepted).toBe(300);
    // every surviving note is active
    for (const n of active) {
      expect(p.read(NOTES, "is-note-active", [Cl.buffer(n.commitment)])).toBeBool(true);
    }
  }, 300000);
});
