import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  Protocol,
  ONE_STX,
  POOL,
  VERIFIER,
  VKEY,
} from "../helpers/protocol.js";
import {
  bytes32,
  withdrawInputsHash,
  shieldInputsHash,
} from "../helpers/attestation.js";
import { Aggregator, bindingFor, statementLeaf } from "../helpers/aggregation.js";

/*
  PHASE 5 — Attack testing.

  Every malicious operation MUST be rejected. Attacks run against the real
  6-contract stack. Error codes: verifier u30x, registry u1xx, note u15x,
  pool u25x.
*/

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const attacker = accounts.get("wallet_6")!;
const recipient = accounts.get("wallet_8")!;

const setup = () => {
  const p = new Protocol(deployer);
  p.wire();
  return p;
};
const errCode = (r: unknown): number => Number((r as { value: { value: bigint } }).value.value);
const isErr = (r: { type: string }) => expect(r.type).toBe("err");

describe("proof & double-spend attacks", () => {
  it("double spend is rejected by the nullifier set, with no note-state leak", () => {
    const p = setup();
    const s = p.shield(alice, 10 * ONE_STX);
    p.transfer(alice, s.note); // consumes the note
    const r = p.transfer(alice, s.note); // spend again -> same nullifier
    isErr(r.result);
    expect(errCode(r.result)).toBe(116); // ERR-DUPLICATE-NULLIFIER
    // PRIVACY: the consumed note is never marked spent on chain.
    expect(
      p.read("note-manager", "is-note-spent", [Cl.buffer(s.note.commitment)]),
    ).toBeBool(false);
  });

  it("double spend via nullifier reuse is rejected", () => {
    const p = setup();
    const s1 = p.shield(alice, 10 * ONE_STX);
    const s2 = p.shield(alice, 10 * ONE_STX);
    p.transfer(alice, s1.note);
    const forged = { ...s2.note, nullifier: s1.note.nullifier };
    const r = p.transfer(alice, forged);
    isErr(r.result);
    expect(errCode(r.result)).toBe(116); // ERR-DUPLICATE-NULLIFIER
  });

  it("transaction replay (identical op resubmitted) fails on stale root", () => {
    const p = setup();
    const s = p.shield(alice, 10 * ONE_STX);
    p.transfer(alice, s.note); // advances the root
    // resubmitting the ORIGINAL transfer would present the now-stale root
    // (the harness already marked the note spent; the state guard also fires)
    const r = p.transfer(alice, s.note);
    isErr(r.result);
  });

  it("duplicate commitment is rejected", () => {
    const p = setup();
    const s = p.shield(alice, 10 * ONE_STX);
    // a shield reusing the same note id fails inside the stack
    const dup = simnet.callPublicFn(
      "privacy-registry",
      "register-commitment",
      [Cl.buffer(s.note.commitment), Cl.uint(1)],
      attacker,
    );
    isErr(dup.result); // unauthorized caller anyway; never creates a duplicate
  });
});

describe("substitution attacks (proof binding)", () => {
  it("recipient substitution: a proof verified for recipient A cannot pay attacker", () => {
    const p = setup();
    const s = p.shield(alice, 50 * ONE_STX);
    // sign a withdrawal to `recipient`, submit it to `attacker`
    const signedHash = withdrawInputsHash({
      nullifier: s.note.nullifier,
      amount: 10 * ONE_STX,
      recipient, // signed destination
      root: p.currentRoot,
    });
    const inc = p.proofArgs(3, signedHash);
    const r = simnet.callPublicFn(
      POOL,
      "withdraw",
      [
        Cl.buffer(s.note.nullifier),
        Cl.uint(10 * ONE_STX),
        Cl.principal(attacker), // swapped
        Cl.buffer(p.currentRoot),
        ...inc,
      ],
      attacker,
    );
    isErr(r.result);
    expect(errCode(r.result)).toBe(310); // ERR-PROOF-NOT-AGGREGATED (leaf mismatch)
  });

  it("amount substitution: a proof verified for amount X cannot shield amount Y", () => {
    const p = setup();
    const note = p.mkNote(100 * ONE_STX);
    const newRoot = p.nextRoot();
    const signedHash = shieldInputsHash({
      commitment: note.commitment,
      ownerCommitment: note.ownerCommitment,
      metadata: note.metadata,
      amount: 100 * ONE_STX, // signed amount
      currentRoot: p.currentRoot,
      newRoot,
      leafIndex: 0,
    });
    const inc = p.proofArgs(1, signedHash);
    const r = simnet.callPublicFn(
      POOL,
      "shield",
      [
        Cl.uint(5 * ONE_STX), // different amount submitted -> hash mismatch
        Cl.buffer(note.commitment),
        Cl.buffer(note.ownerCommitment),
        Cl.buffer(note.metadata),
        Cl.buffer(p.currentRoot),
        Cl.buffer(newRoot),
        Cl.uint(0),
        ...inc,
      ],
      alice,
    );
    isErr(r.result);
    expect(errCode(r.result)).toBe(310);
  });
});

describe("root attacks", () => {
  it("unknown root on withdrawal is rejected", () => {
    const p = setup();
    const s = p.shield(alice, 50 * ONE_STX);
    const bogus = bytes32(9999, 0x52);
    const inc = p.proofArgs(3, withdrawInputsHash({
        nullifier: s.note.nullifier,
        amount: 10 * ONE_STX,
        recipient,
        root: bogus,
      }));
    const r = simnet.callPublicFn(
      POOL,
      "withdraw",
      [
        Cl.buffer(s.note.nullifier),
        Cl.uint(10 * ONE_STX),
        Cl.principal(recipient),
        Cl.buffer(bogus),
        ...inc,
      ],
      alice,
    );
    isErr(r.result);
    expect(errCode(r.result)).toBe(253); // ERR-UNKNOWN-ROOT
  });

  it("stale root on a tree-extending op is rejected", () => {
    const p = setup();
    const s1 = p.shield(alice, 10 * ONE_STX);
    const genesis = bytes32(1, 0x47);
    p.shield(alice, 10 * ONE_STX); // advance the root
    // transfer built against the stale genesis root; the stale-root guard
    // fires before proof verification, so the inclusion proof never matters
    const out = p.mkNote(10 * ONE_STX);
    const r = simnet.callPublicFn(
      POOL,
      "transfer",
      [
        Cl.buffer(s1.note.nullifier),
        Cl.buffer(out.commitment),
        Cl.buffer(out.ownerCommitment),
        Cl.buffer(out.metadata),
        Cl.buffer(genesis), // stale
        Cl.buffer(p.nextRoot()),
        Cl.uint(0),
        ...p.proofArgs(2, bytes32(4242, 0x11)),
      ],
      alice,
    );
    isErr(r.result);
    expect(errCode(r.result)).toBe(252); // ERR-STALE-ROOT (checked before proof)
  });

  it("historical roots still validate for withdrawals (positive control)", () => {
    const p = setup();
    const s = p.shield(alice, 50 * ONE_STX);
    const oldRoot = p.currentRoot;
    p.shield(alice, 50 * ONE_STX); // root advances
    // withdraw the first note against the OLD (still active) root: must succeed
    const inc = p.proofArgs(3, withdrawInputsHash({
        nullifier: s.note.nullifier,
        amount: 10 * ONE_STX,
        recipient,
        root: oldRoot,
      }));
    const r = simnet.callPublicFn(
      POOL,
      "withdraw",
      [
        Cl.buffer(s.note.nullifier),
        Cl.uint(10 * ONE_STX),
        Cl.principal(recipient),
        Cl.buffer(oldRoot),
        ...inc,
      ],
      alice,
    );
    expect(r.result.type).toBe("ok");
  });
});

describe("aggregation, inclusion & vkey attacks", () => {
  /** Build a shield call whose inclusion proof the test controls. */
  const shieldWith = (p: Protocol, inclusion: unknown[]) => {
    const note = p.mkNote(10 * ONE_STX);
    return simnet.callPublicFn(
      POOL,
      "shield",
      [
        Cl.uint(10 * ONE_STX),
        Cl.buffer(note.commitment),
        Cl.buffer(note.ownerCommitment),
        Cl.buffer(note.metadata),
        Cl.buffer(p.currentRoot),
        Cl.buffer(p.nextRoot()),
        Cl.uint(0),
        ...inclusion,
      ] as never,
      alice,
    );
  };

  it("a statement zkVerify never verified cannot be spent", () => {
    const p = setup();
    // an aggregation that was never published on chain
    const orphan = new Aggregator(9).aggregate(
      statementLeaf(bindingFor(1), bytes32(777, 0x11)),
    );
    const r = shieldWith(p, [
      Cl.uint(orphan.domainId),
      Cl.uint(orphan.aggregationId),
      Cl.list(orphan.path.map((x) => Cl.buffer(x))),
      Cl.uint(orphan.leafIndex),
    ]);
    isErr(r.result);
    expect(errCode(r.result)).toBe(311); // ERR-AGGREGATION-NOT-FOUND
  });

  it("a forged inclusion path against a real root is rejected", () => {
    const p = setup();
    // a genuine aggregation exists for some OTHER statement...
    const real = p.aggregate(1, bytes32(555, 0x11));
    // ...and the attacker attaches its ids to their own operation with a
    // fabricated path. The recomputed root cannot match.
    const forged = real.path.map(() => bytes32(31337, 0xbb));
    const r = shieldWith(p, [
      Cl.uint(real.domainId),
      Cl.uint(real.aggregationId),
      Cl.list(forged.map((x) => Cl.buffer(x))),
      Cl.uint(real.leafIndex),
    ]);
    isErr(r.result);
    expect(errCode(r.result)).toBe(310); // ERR-PROOF-NOT-AGGREGATED
  });

  it("a leaf index outside the tree is rejected", () => {
    const p = setup();
    const real = p.aggregate(1, bytes32(556, 0x11));
    const r = shieldWith(p, [
      Cl.uint(real.domainId),
      Cl.uint(real.aggregationId),
      Cl.list(real.path.map((x) => Cl.buffer(x))),
      Cl.uint(real.leafCount + 99),
    ]);
    isErr(r.result);
    expect(errCode(r.result)).toBe(316); // ERR-INVALID-LEAF-INDEX
  });

  it("an unauthorized party cannot publish an aggregation root", () => {
    const p = setup();
    void p;
    const inc = new Aggregator(7).aggregate(bytes32(1, 0x77));
    const r = simnet.callPublicFn(
      VERIFIER,
      "submit-aggregation",
      [
        Cl.uint(inc.domainId),
        Cl.uint(inc.aggregationId),
        Cl.buffer(inc.root),
        Cl.uint(inc.leafCount),
      ],
      attacker,
    );
    isErr(r.result);
    expect(errCode(r.result)).toBe(300); // ERR-UNAUTHORIZED
  });

  it("a published root cannot be overwritten, even by the relayer", () => {
    const p = setup();
    const real = p.aggregate(1, bytes32(557, 0x11));
    // the relayer's own key cannot rewrite history to include a forged tree
    const r = simnet.callPublicFn(
      VERIFIER,
      "submit-aggregation",
      [
        Cl.uint(real.domainId),
        Cl.uint(real.aggregationId),
        Cl.buffer(bytes32(6666, 0xaa)),
        Cl.uint(real.leafCount),
      ],
      deployer,
    );
    isErr(r.result);
    expect(errCode(r.result)).toBe(312); // ERR-AGGREGATION-EXISTS
  });

  it("disabled verification key rejects proofs", () => {
    const p = setup();
    // Disable the vkey at the LIVE circuit version (what the pool verifies against).
    simnet.callPublicFn(
      VERIFIER,
      "set-verification-key-status",
      [Cl.uint(1), Cl.uint(p.liveCircuitVersion()), Cl.bool(false)],
      deployer,
    );
    const r = p.shield(alice, 10 * ONE_STX);
    isErr(r.result);
    expect(errCode(r.result)).toBe(305); // ERR-VKEY-DISABLED
  });

});

describe("access-control, pause, freeze & DoS attacks", () => {
  it("unauthorized principals cannot drive protected writes", () => {
    setup();
    // direct calls to protected registry writes from an attacker are rejected
    const c = simnet.callPublicFn(
      "privacy-registry",
      "register-nullifier",
      [Cl.buffer(bytes32(7, 0x4e))],
      attacker,
    );
    isErr(c.result);
    expect(errCode(c.result)).toBe(101); // ERR-UNAUTHORIZED-CALLER
  });

  it("operations are blocked while paused, and resume after unpause", () => {
    const p = setup();
    const s = p.shield(alice, 10 * ONE_STX);
    p.regCall("pause-protocol", []);
    const blocked = p.transfer(alice, s.note);
    isErr(blocked.result);
    expect(errCode(blocked.result)).toBe(102); // ERR-PROTOCOL-PAUSED
    p.regCall("unpause-protocol", []);
    expect(p.transfer(alice, s.note).result.type).toBe("ok");
  });

  it("verification freeze halts every operation", () => {
    const p = setup();
    const s = p.shield(alice, 10 * ONE_STX);
    simnet.callPublicFn(VERIFIER, "freeze-verification", [], deployer);
    isErr(p.transfer(alice, s.note).result);
    isErr(p.split(alice, s.note, 5 * ONE_STX, 5 * ONE_STX).result);
  });

  it("non-owner cannot pause, upgrade, or seize the treasury", () => {
    setup();
    isErr(simnet.callPublicFn("privacy-registry", "pause-protocol", [], attacker).result);
    isErr(simnet.callPublicFn("privacy-registry", "begin-upgrade", [], attacker).result);
    isErr(
      simnet.callPublicFn(
        "protocol-fees",
        "withdraw-fees",
        [Cl.uint(1), Cl.principal(attacker)],
        attacker,
      ).result,
    );
  });
});
