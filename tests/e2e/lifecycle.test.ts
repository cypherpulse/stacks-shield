import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { Protocol, ONE_STX, REGISTRY, NOTES, VERIFIER } from "../helpers/protocol.js";

/*
  PHASE 5 — End-to-end & mainnet simulations.

  The canonical lifecycle, an emergency drill, and an upgrade rehearsal, all
  against the real 6-contract stack with genuine attestations.
*/

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_7")!;
const recipient = accounts.get("wallet_8")!;
const emergencyAdmin = accounts.get("wallet_2")!;

const ok = (r: { type: string }) => expect(r.type).toBe("ok");
const setup = () => {
  const p = new Protocol(deployer);
  p.wire();
  return p;
};

describe("mainnet simulation: shield -> transfer -> transfer -> split -> merge -> transfer -> withdraw", () => {
  it("completes the full lifecycle with conservation intact at every step", () => {
    const p = setup();

    // shield 100 STX
    const s = p.shield(alice, 100 * ONE_STX);
    ok(s.result);
    expect(p.poolBalance()).toBe(BigInt(100 * ONE_STX));

    // transfer -> transfer (ownership moves privately, value preserved)
    const t1 = p.transfer(alice, s.note);
    ok(t1.result);
    const t2 = p.transfer(bob, t1.note);
    ok(t2.result);

    // split 100 -> 40 + 60
    const sp = p.split(bob, t2.note, 40 * ONE_STX, 60 * ONE_STX);
    ok(sp.result);

    // merge 40 + 60 -> 100
    const mg = p.merge(bob, sp.notes[0], sp.notes[1]);
    ok(mg.result);
    expect(mg.note.amount).toBe(100 * ONE_STX);

    // transfer -> withdraw
    const t3 = p.transfer(bob, mg.note);
    ok(t3.result);
    const before = BigInt(0);
    void before;
    ok(p.withdraw(bob, t3.note, recipient).result);

    // conservation and consistency at the end
    expect(p.poolBalance()).toBe(BigInt(0));
    expect(p.poolBalance()).toBe(p.totalShielded());
    expect(p.read(NOTES, "is-statistics-consistent")).toBeBool(true);
    // full audit trail. Commitments: shield + t1 + t2 + split(2) + merge + t3 = 7.
    // Nullifiers, one per consumed note: t1, t2, split-input, merge-input-1,
    // merge-input-2, t3, withdraw = 7.
    expect(p.read(REGISTRY, "get-total-commitments")).toBeUint(7);
    expect(p.read(REGISTRY, "get-total-nullifiers")).toBeUint(7);
    expect(p.read(REGISTRY, "get-total-withdrawals")).toBeUint(1);
  });
});

describe("emergency scenario: pause -> freeze -> recover -> resume", () => {
  it("halts everything, preserves funds, and recovers to full operation", () => {
    const p = setup();
    p.grantRole(emergencyAdmin, 2);
    const s1 = p.shield(alice, 100 * ONE_STX);
    const s2 = p.shield(bob, 50 * ONE_STX);
    ok(s1.result);
    ok(s2.result);
    const funds = p.poolBalance();

    // incident: emergency pause + verification freeze + treasury freeze
    simnet.callPublicFn(REGISTRY, "emergency-pause-protocol", [], emergencyAdmin);
    simnet.callPublicFn(VERIFIER, "freeze-verification", [], emergencyAdmin);
    simnet.callPublicFn("protocol-fees", "freeze-treasury", [], emergencyAdmin);

    // nothing moves during the emergency
    expect(p.transfer(alice, s1.note).result.type).toBe("err");
    // ...but user funds are exactly where they were
    expect(p.poolBalance()).toBe(funds);

    // recovery: owner resolves, unpauses, unfreezes
    simnet.callPublicFn(REGISTRY, "resolve-emergency", [], deployer);
    simnet.callPublicFn(REGISTRY, "unpause-protocol", [], deployer);
    simnet.callPublicFn(VERIFIER, "unfreeze-verification", [], emergencyAdmin);
    simnet.callPublicFn("protocol-fees", "unfreeze-treasury", [], emergencyAdmin);

    // full operation resumes
    ok(p.transfer(alice, s1.note).result);
    ok(p.withdraw(bob, s2.note, recipient).result);
    expect(p.poolBalance()).toBe(p.totalShielded());
  });
});

describe("upgrade rehearsal: v1 -> UPGRADING -> v2 circuits/vkeys -> resume", () => {
  it("bumps circuit version, preserves live state, and keeps old notes spendable", () => {
    const p = setup();

    // pre-upgrade state
    const s1 = p.shield(alice, 100 * ONE_STX); // a v1 note
    ok(s1.result);
    const commitmentsBefore = p.read(REGISTRY, "get-total-commitments");
    expect(commitmentsBefore).toBeUint(1);

    // --- upgrade flow ---
    // 1. stage v2 vkeys for every circuit (allowed in any state), recorded in
    //    the harness so post-upgrade attestations bind the v2 keys
    for (const t of [1, 2, 3, 4, 5]) {
      p.registerVkey(t, 2, new Uint8Array(32).fill(0x5b + t));
    }
    // the v2 circuits need their own zkVerify binding, exactly as a real
    // upgrade would observe and configure it
    p.configureBindings([1, 2, 3, 4, 5], 2);
    // 2. enter the upgrade window
    p.regCall("pause-protocol", []);
    p.regCall("begin-upgrade", []);
    // 3. bump component versions (circuit + verifier + protocol)
    ok(
      simnet.callPublicFn(
        REGISTRY,
        "update-versions",
        [
          Cl.tuple({
            protocol: Cl.uint(2),
            verifier: Cl.uint(2),
            note: Cl.uint(1),
            circuit: Cl.uint(2),
            commitment: Cl.uint(1),
            root: Cl.uint(1),
          }),
        ],
        deployer,
      ).result,
    );
    // 4. resume
    p.regCall("complete-upgrade", []);

    // --- post-upgrade validation ---
    expect(p.read(REGISTRY, "get-circuit-version")).toBeUint(2);
    // live state fully preserved
    expect(p.read(REGISTRY, "get-total-commitments")).toBeUint(1);
    expect(p.poolBalance()).toBe(BigInt(100 * ONE_STX));
    expect(p.read(NOTES, "is-note-active", [Cl.buffer(s1.note.commitment)])).toBeBool(true);

    // the old v1 note remains spendable (its recorded version is honored),
    // and a fresh operation now proves against circuit v2 — the harness reads
    // the live circuit version from the registry, so this "just works"
    ok(p.transfer(alice, s1.note).result);
  });
});
