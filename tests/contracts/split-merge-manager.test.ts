import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  bytes32,
  shieldInputsHash,
  splitInputsHash,
  mergeInputsHash,
} from "../helpers/attestation";
import { LocalProver } from "../helpers/aggregation";

/*
  Test suite for split-merge-manager.clar, exercised against the REAL protocol
  stack: frozen privacy-registry, note-manager, protocol-fees, zk-verifier,
  and privacy-pool (used to seed spendable notes via genuine shields).

  split  1 note  -> 2 notes
  merge  2 notes -> 1 note

  Real zkVerify inclusion proofs, real nullifiers, real note lifecycle. Notes are
  created by shielding through the pool, then reshaped through the manager.
*/

const REGISTRY = "privacy-registry";
const NOTES = "note-manager";
const VERIFIER = "zk-verifier";
const POOL = "privacy-pool";
const MANAGER = "split-merge-manager";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const emergencyAdmin = accounts.get("wallet_2")!;
const alice = accounts.get("wallet_1")!;
const attacker = accounts.get("wallet_6")!;

const ROLE = { EMERGENCY: 2 };

const ERR = {
  UNAUTHORIZED: 350,
  OPERATION_DISABLED: 351,
  STALE_ROOT: 352,
  UNKNOWN_ROOT: 353,
  INVALID_INPUT: 354,
  DUPLICATE_INPUT: 355,
  DUPLICATE_OUTPUT: 356,
  SWITCH_UNCHANGED: 357,
  REG_PAUSED: 102,
  REG_EMERGENCY: 103,
  REG_DUPLICATE_NULLIFIER: 116,
  NOTE_INVALID_STATE: 156,
  NOTE_FROZEN: 159,
  VERIFIER_NOT_AGGREGATED: 310,
  VERIFIER_AGGREGATION_NOT_FOUND: 311,
  VERIFIER_FROZEN: 302,
};

const ONE_STX = 1_000_000;
const PROOF_LEN = 448;
const GENESIS_ROOT = bytes32(1, 0x47);
const VKEY = {
  1: bytes32(1, 0x5a), // shield
  4: bytes32(4, 0x5a), // split
  5: bytes32(5, 0x5a), // merge
} as const;

const prover = new LocalProver(deployer);
const ZERO = new Uint8Array(32);

const mgrCall = (fn: string, args: unknown[], sender: string) =>
  simnet.callPublicFn(MANAGER, fn, args as any, sender);
const mgrRead = (fn: string, args: unknown[] = []) =>
  simnet.callReadOnlyFn(MANAGER, fn, args as any, deployer).result;
const regCall = (fn: string, args: unknown[], sender: string) =>
  simnet.callPublicFn(REGISTRY, fn, args as any, sender);
const regRead = (fn: string, args: unknown[] = []) =>
  simnet.callReadOnlyFn(REGISTRY, fn, args as any, deployer).result;
const noteRead = (fn: string, args: unknown[] = []) =>
  simnet.callReadOnlyFn(NOTES, fn, args as any, deployer).result;

/* Wire the whole protocol: authorize the pool AND the manager (both write to
   the registry + note-manager), bootstrap the tree, register shield/split/merge
   vkeys, seat the committee. */
type Ctx = { root: Uint8Array; rootCounter: number; leafCount: number };
// The registry's live circuit version (v2) — what the pools pass to verify-proof.
const CV = (): number =>
  Number((simnet.callReadOnlyFn(REGISTRY, "get-circuit-version", [], deployer).result as { value: bigint }).value);
const wire = (): Ctx => {
  for (const c of [POOL, NOTES, MANAGER]) {
    regCall("add-authorized-caller", [Cl.contractPrincipal(deployer, c)], deployer);
  }
  regCall("update-root", [Cl.buffer(GENESIS_ROOT), Cl.uint(1)], deployer);
  const cv = CV();
  for (const t of [1, 4, 5] as const) {
    simnet.callPublicFn(
      VERIFIER,
      "register-verification-key",
      [Cl.uint(t), Cl.uint(cv), Cl.buffer(VKEY[t]), Cl.uint(PROOF_LEN)],
      deployer
    );
  }
  prover.configureBindings([1, 2, 3, 4, 5], cv);
  return { root: GENESIS_ROOT, rootCounter: 1, leafCount: 0 };
};

/* Create a spendable note by genuinely shielding through the pool. */
const shield = (ctx: Ctx, user: string, n: number, amount = 10 * ONE_STX) => {
  const commitment = bytes32(n, 0x3c);
  const owner = bytes32(n, 0x4f);
  const meta = bytes32(n, 0x4d);
  const currentRoot = ctx.root;
  const newRoot = bytes32(++ctx.rootCounter, 0x52);
  const leafIndex = ctx.leafCount;
  const inputsHash = shieldInputsHash({
    commitment,
    ownerCommitment: owner,
    metadata: meta,
    amount,
    currentRoot,
    newRoot,
    leafIndex,
  });
  const inclusionArgs = prover.args(1, inputsHash);
  const res = simnet.callPublicFn(
    POOL,
    "shield",
    [
      Cl.uint(amount),
      Cl.buffer(commitment),
      Cl.buffer(owner),
      Cl.buffer(meta),
      Cl.buffer(currentRoot),
      Cl.buffer(newRoot),
      Cl.uint(leafIndex),
      ...inclusionArgs,
    ],
    user
  );
  if (res.result.type === "ok") { ctx.root = newRoot; ctx.leafCount++; }
  return { ...res, commitment };
};

/* Split note `oldN` into two new notes `aN` and `bN`. */
const doSplit = (
  ctx: Ctx,
  user: string,
  oldN: number,
  aN: number,
  bN: number,
  overrides: Partial<{
    currentRoot: Uint8Array;
    nullifier: Uint8Array;
    commitment2: Uint8Array;
    inclusion: ReturnType<LocalProver["args"]>;
  }> = {}
) => {
  const oldNote = bytes32(oldN, 0x3c);
  const nullifier = overrides.nullifier ?? bytes32(oldN, 0x4e);
  const c1 = bytes32(aN, 0x3c);
  const c2 = overrides.commitment2 ?? bytes32(bN, 0x3c);
  const currentRoot = overrides.currentRoot ?? ctx.root;
  const newRoot = bytes32(++ctx.rootCounter, 0x52);
  const leafIndex = ctx.leafCount; // first output; second lands at leafIndex+1
  const inputsHash = splitInputsHash({
    nullifier,
    commitment1: c1,
    ownerCommitment1: bytes32(aN, 0x4f),
    metadata1: bytes32(aN, 0x4d),
    commitment2: c2,
    ownerCommitment2: bytes32(bN, 0x4f),
    metadata2: bytes32(bN, 0x4d),
    currentRoot,
    newRoot,
    leafIndex,
  });
  const inclusionArgs = overrides.inclusion ?? prover.args(4, inputsHash);
  const res = mgrCall(
    "split-note",
    [
      Cl.buffer(nullifier),
      Cl.buffer(c1),
      Cl.buffer(bytes32(aN, 0x4f)),
      Cl.buffer(bytes32(aN, 0x4d)),
      Cl.buffer(c2),
      Cl.buffer(bytes32(bN, 0x4f)),
      Cl.buffer(bytes32(bN, 0x4d)),
      Cl.buffer(currentRoot),
      Cl.buffer(newRoot),
      Cl.uint(leafIndex),
      ...inclusionArgs,
    ],
    user
  );
  if (res.result.type === "ok") { ctx.root = newRoot; ctx.leafCount += 2; }
  return { ...res, c1, c2, nullifier };
};

/* Merge notes `aN` and `bN` into a new note `outN`. */
const doMerge = (
  ctx: Ctx,
  user: string,
  aN: number,
  bN: number,
  outN: number,
  overrides: Partial<{
    currentRoot: Uint8Array;
    note2: Uint8Array;
    nullifier1: Uint8Array;
    nullifier2: Uint8Array;
  }> = {}
) => {
  const n1 = bytes32(aN, 0x3c);
  const n2 = overrides.note2 ?? bytes32(bN, 0x3c);
  const null1 = overrides.nullifier1 ?? bytes32(aN, 0x4e);
  const null2 = overrides.nullifier2 ?? bytes32(bN, 0x4e);
  const commitment = bytes32(outN, 0x3c);
  const currentRoot = overrides.currentRoot ?? ctx.root;
  const newRoot = bytes32(++ctx.rootCounter, 0x52);
  const leafIndex = ctx.leafCount;
  const inputsHash = mergeInputsHash({
    nullifier1: null1,
    nullifier2: null2,
    commitment,
    ownerCommitment: bytes32(outN, 0x4f),
    metadata: bytes32(outN, 0x4d),
    currentRoot,
    newRoot,
    leafIndex,
  });
  const inclusionArgs = prover.args(5, inputsHash);
  const res = mgrCall(
    "merge-notes",
    [
      Cl.buffer(null1),
      Cl.buffer(null2),
      Cl.buffer(commitment),
      Cl.buffer(bytes32(outN, 0x4f)),
      Cl.buffer(bytes32(outN, 0x4d)),
      Cl.buffer(currentRoot),
      Cl.buffer(newRoot),
      Cl.uint(leafIndex),
      ...inclusionArgs,
    ],
    user
  );
  if (res.result.type === "ok") { ctx.root = newRoot; ctx.leafCount++; }
  return { ...res, commitment };
};

// ===========================================================================
// Deployment
// ===========================================================================

describe("deployment", () => {
  it("starts with split and merge enabled", () => {
    expect(mgrRead("is-split-enabled")).toBeBool(true);
    expect(mgrRead("is-merge-enabled")).toBeBool(true);
    expect(mgrRead("get-manager-version")).toBeUint(1);
  });
});

// ===========================================================================
// SPLIT
// ===========================================================================

describe("split", () => {
  it("splits one note into two across the full stack", () => {
    const ctx = wire();
    shield(ctx, alice, 1, 100 * ONE_STX);
    const res = doSplit(ctx, alice, 1, 2, 3);
    expect(res.result).toBeOk(
      Cl.tuple({ "leaf-1": Cl.uint(1), "leaf-2": Cl.uint(2) })
    );
    // input consumed
    expect(noteRead("is-note-spent", [Cl.buffer(bytes32(1, 0x3c))])).toBeBool(false); // PRIVACY: unlinkable
    expect(regRead("is-nullifier-spent", [Cl.buffer(res.nullifier)])).toBeBool(true);
    // two outputs live
    expect(noteRead("is-note-active", [Cl.buffer(res.c1)])).toBeBool(true);
    expect(noteRead("is-note-active", [Cl.buffer(res.c2)])).toBeBool(true);
    // registry accounting: 1 shield commitment + 2 split commitments
    expect(regRead("get-total-commitments")).toBeUint(3);
    expect(regRead("get-total-nullifiers")).toBeUint(1);
    expect(regRead("get-total-notes")).toBeUint(3);
    // no STX moved: conservation holds
    expect(regRead("get-total-shielded-stx")).toBeUint(100 * ONE_STX);
  });

  it("split outputs are immediately spendable (chained split)", () => {
    const ctx = wire();
    shield(ctx, alice, 1, 100 * ONE_STX);
    doSplit(ctx, alice, 1, 2, 3);
    // split one of the outputs again
    expect(doSplit(ctx, alice, 2, 4, 5).result).toBeOk(
      Cl.tuple({ "leaf-1": Cl.uint(3), "leaf-2": Cl.uint(4) })
    );
    expect(noteRead("is-note-spent", [Cl.buffer(bytes32(2, 0x3c))])).toBeBool(false); // PRIVACY: unlinkable
  });

  it("rejects a stale root, zero inputs, and colliding outputs", () => {
    const ctx = wire();
    shield(ctx, alice, 1, 100 * ONE_STX);
    // stale root
    expect(doSplit(ctx, alice, 1, 2, 3, { currentRoot: GENESIS_ROOT }).result).toBeErr(
      Cl.uint(ERR.STALE_ROOT)
    );
    // zero nullifier
    expect(doSplit(ctx, alice, 1, 2, 3, { nullifier: ZERO }).result).toBeErr(
      Cl.uint(ERR.INVALID_INPUT)
    );
    // two identical output commitments
    expect(
      doSplit(ctx, alice, 1, 2, 3, { commitment2: bytes32(2, 0x3c) }).result
    ).toBeErr(Cl.uint(ERR.DUPLICATE_OUTPUT));
  });

  it("rejects splitting a non-active note and double-spends", () => {
    const ctx = wire();
    shield(ctx, alice, 1, 100 * ONE_STX);
    doSplit(ctx, alice, 1, 2, 3);
    // note 1 is now SPENT
    expect(doSplit(ctx, alice, 1, 6, 7).result).toBeErr(Cl.uint(ERR.REG_DUPLICATE_NULLIFIER));
    // reuse note 1's nullifier against an active note
    expect(
      doSplit(ctx, alice, 2, 8, 9, { nullifier: bytes32(1, 0x4e) }).result
    ).toBeErr(Cl.uint(ERR.REG_DUPLICATE_NULLIFIER));
  });

  it("rejects statements zkVerify never verified", () => {
    const ctx = wire();
    shield(ctx, alice, 1, 100 * ONE_STX);
    const unpublished = new LocalProver(deployer);
    unpublished.publishRoots = false;
    expect(
      doSplit(ctx, alice, 1, 2, 3, {
        inclusion: unpublished.args(4, new Uint8Array(32).fill(0xcd)),
      }).result
    ).toBeErr(Cl.uint(ERR.VERIFIER_AGGREGATION_NOT_FOUND));
  });

  it("respects protocol pause and the split switch", () => {
    const ctx = wire();
    regCall("grant-role", [Cl.principal(emergencyAdmin), Cl.uint(ROLE.EMERGENCY)], deployer);
    shield(ctx, alice, 1, 100 * ONE_STX);

    regCall("pause-protocol", [], deployer);
    expect(doSplit(ctx, alice, 1, 2, 3).result).toBeErr(Cl.uint(ERR.REG_PAUSED));
    regCall("unpause-protocol", [], deployer);

    mgrCall("set-split-enabled", [Cl.bool(false)], emergencyAdmin);
    expect(doSplit(ctx, alice, 1, 2, 3).result).toBeErr(Cl.uint(ERR.OPERATION_DISABLED));
    mgrCall("set-split-enabled", [Cl.bool(true)], emergencyAdmin);
    expect(doSplit(ctx, alice, 1, 2, 3).result).toBeOk(
      Cl.tuple({ "leaf-1": Cl.uint(1), "leaf-2": Cl.uint(2) })
    );
  });

  it("a frozen input note can still be split -- per-note censorship is impossible", () => {
    const ctx = wire();
    regCall("grant-role", [Cl.principal(emergencyAdmin), Cl.uint(ROLE.EMERGENCY)], deployer);
    shield(ctx, alice, 1, 100 * ONE_STX);
    // CENSORSHIP-RESISTANCE: the chain never learns which note is consumed,
    // so freezing an individual note cannot block a spend.
    simnet.callPublicFn(NOTES, "freeze-note", [Cl.buffer(bytes32(1, 0x3c))], emergencyAdmin);
    expect(doSplit(ctx, alice, 1, 2, 3).result.type).toBe("ok");
  });
});

// ===========================================================================
// MERGE
// ===========================================================================

describe("merge", () => {
  it("merges two notes into one across the full stack", () => {
    const ctx = wire();
    shield(ctx, alice, 1, 40 * ONE_STX);
    shield(ctx, alice, 2, 60 * ONE_STX);
    const res = doMerge(ctx, alice, 1, 2, 3);
    expect(res.result).toBeOk(Cl.uint(2)); // third leaf
    // both inputs consumed
    expect(noteRead("is-note-spent", [Cl.buffer(bytes32(1, 0x3c))])).toBeBool(false); // PRIVACY: unlinkable
    expect(noteRead("is-note-spent", [Cl.buffer(bytes32(2, 0x3c))])).toBeBool(false); // PRIVACY: unlinkable
    expect(regRead("get-total-nullifiers")).toBeUint(2);
    // single output live
    expect(noteRead("is-note-active", [Cl.buffer(res.commitment)])).toBeBool(true);
    expect(regRead("get-total-commitments")).toBeUint(3);
    // conservation
    expect(regRead("get-total-shielded-stx")).toBeUint(100 * ONE_STX);
  });

  it("the merged note is immediately spendable (merge then split)", () => {
    const ctx = wire();
    shield(ctx, alice, 1, 40 * ONE_STX);
    shield(ctx, alice, 2, 60 * ONE_STX);
    doMerge(ctx, alice, 1, 2, 3);
    expect(doSplit(ctx, alice, 3, 4, 5).result).toBeOk(
      Cl.tuple({ "leaf-1": Cl.uint(3), "leaf-2": Cl.uint(4) })
    );
  });

  it("rejects identical inputs, zero inputs, and stale roots", () => {
    const ctx = wire();
    shield(ctx, alice, 1, 40 * ONE_STX);
    shield(ctx, alice, 2, 60 * ONE_STX);
    // Note ids are private and never submitted, so "same note twice" is now
    // expressed -- and enforced -- purely on the nullifiers.
    // same nullifier twice
    expect(
      doMerge(ctx, alice, 1, 2, 3, { nullifier2: bytes32(1, 0x4e) }).result
    ).toBeErr(Cl.uint(ERR.DUPLICATE_INPUT));
    // zero commitment output handled as invalid input path via nullifier zero
    expect(
      doMerge(ctx, alice, 1, 2, 3, { nullifier1: ZERO }).result
    ).toBeErr(Cl.uint(ERR.INVALID_INPUT));
    // stale root
    expect(doMerge(ctx, alice, 1, 2, 3, { currentRoot: GENESIS_ROOT }).result).toBeErr(
      Cl.uint(ERR.STALE_ROOT)
    );
  });

  it("rejects merging a spent note and double-spends", () => {
    const ctx = wire();
    shield(ctx, alice, 1, 40 * ONE_STX);
    shield(ctx, alice, 2, 60 * ONE_STX);
    shield(ctx, alice, 3, 10 * ONE_STX);
    doMerge(ctx, alice, 1, 2, 4);
    // note 1 already spent
    expect(doMerge(ctx, alice, 1, 3, 5).result).toBeErr(Cl.uint(ERR.REG_DUPLICATE_NULLIFIER));
    // Reusing note 1's already-consumed nullifier is caught by the registry's
    // append-only nullifier set -- the single double-spend gate.
    expect(
      doMerge(ctx, alice, 3, 2, 6, { nullifier1: bytes32(1, 0x4e) }).result
    ).toBeErr(Cl.uint(ERR.REG_DUPLICATE_NULLIFIER));
  });

  it("respects protocol pause and the merge switch", () => {
    const ctx = wire();
    regCall("grant-role", [Cl.principal(emergencyAdmin), Cl.uint(ROLE.EMERGENCY)], deployer);
    shield(ctx, alice, 1, 40 * ONE_STX);
    shield(ctx, alice, 2, 60 * ONE_STX);

    mgrCall("set-merge-enabled", [Cl.bool(false)], emergencyAdmin);
    expect(doMerge(ctx, alice, 1, 2, 3).result).toBeErr(Cl.uint(ERR.OPERATION_DISABLED));
    mgrCall("set-merge-enabled", [Cl.bool(true)], emergencyAdmin);
    expect(doMerge(ctx, alice, 1, 2, 3).result).toBeOk(Cl.uint(2));
  });
});

// ===========================================================================
// Access control on switches
// ===========================================================================

describe("switches", () => {
  it("only emergency admin or owner toggle switches; no-ops rejected", () => {
    regCall("grant-role", [Cl.principal(emergencyAdmin), Cl.uint(ROLE.EMERGENCY)], deployer);
    expect(mgrCall("set-split-enabled", [Cl.bool(false)], attacker).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED)
    );
    expect(mgrCall("set-split-enabled", [Cl.bool(true)], deployer).result).toBeErr(
      Cl.uint(ERR.SWITCH_UNCHANGED)
    );
    expect(mgrCall("set-merge-enabled", [Cl.bool(false)], emergencyAdmin).result).toBeOk(
      Cl.bool(true)
    );
  });
});

// ===========================================================================
// End-to-end lifecycle + invariants
// ===========================================================================

describe("end-to-end: shield -> split -> merge -> withdraw", () => {
  it("runs the full note-graph lifecycle with conservation intact", () => {
    const ctx = wire();
    // shield 100 STX (note 1)
    shield(ctx, alice, 1, 100 * ONE_STX);

    // split 100 -> (note 2, note 3)
    expect(doSplit(ctx, alice, 1, 2, 3).result).toBeOk(
      Cl.tuple({ "leaf-1": Cl.uint(1), "leaf-2": Cl.uint(2) })
    );
    // merge (note 2, note 3) -> note 4
    expect(doMerge(ctx, alice, 2, 3, 4).result).toBeOk(Cl.uint(3));

    // conservation holds throughout: pool balance == shielded accounting
    const poolBal = simnet.callReadOnlyFn(POOL, "get-pool-balance", [], deployer).result;
    expect(poolBal).toBeUint(100 * ONE_STX);
    expect(regRead("get-total-shielded-stx")).toBeUint(100 * ONE_STX);

    // note stats: 4 registered (1 shield + 2 split + 1 merge),
    // 3 spent (1 split-input + 2 merge-inputs), 1 active (the merged note)
    expect(noteRead("get-note-statistics")).toBeTuple({
      "total-registered": Cl.uint(4),
      // PRIVACY: consumption is tracked only by nullifiers, never per note.
      "total-active": Cl.uint(4),
      "total-spent": Cl.uint(0),
      "total-withdrawn": Cl.uint(0),
      "total-frozen": Cl.uint(0),
      "total-deprecated": Cl.uint(0),
    });
    expect(noteRead("is-statistics-consistent")).toBeBool(true);
    // nullifiers: 1 split + 2 merge = 3
    expect(regRead("get-total-nullifiers")).toBeUint(3);
    // commitments: 1 shield + 2 split + 1 merge = 4
    expect(regRead("get-total-commitments")).toBeUint(4);
  });

  it("verifier freeze halts both split and merge at once", () => {
    const ctx = wire();
    shield(ctx, alice, 1, 40 * ONE_STX);
    shield(ctx, alice, 2, 60 * ONE_STX);
    simnet.callPublicFn(VERIFIER, "freeze-verification", [], deployer);
    expect(doSplit(ctx, alice, 1, 10, 11).result).toBeErr(Cl.uint(ERR.VERIFIER_FROZEN));
    expect(doMerge(ctx, alice, 1, 2, 3).result).toBeErr(Cl.uint(ERR.VERIFIER_FROZEN));
  });
});

// ===========================================================================
// Property / randomized
// ===========================================================================

describe("property: randomized reshaping", () => {
  // Heavy: ~40 operations, each doing real secp256k1 attestation verification.
  // Raise the timeout well above the 5s default so it is stable under the
  // single-threaded full-suite run.
  it("randomized split/merge walks preserve every invariant", () => {
    const ctx = wire();
    let seed = 0x5b1c;
    const next = () => (seed = (seed * 48271) % 2147483647);

    // shield 8 base notes
    let idCounter = 1;
    const active: number[] = [];
    for (let i = 0; i < 8; i++) {
      const id = idCounter++;
      shield(ctx, alice, id, 10 * ONE_STX);
      active.push(id);
    }
    let commitments = 8;
    let nullifiers = 0;

    for (let round = 0; round < 12; round++) {
      if (next() % 2 === 0 && active.length >= 1) {
        // split
        const idx = next() % active.length;
        const src = active.splice(idx, 1)[0]!;
        const a = idCounter++;
        const b = idCounter++;
        expect(doSplit(ctx, alice, src, a, b).result.type).toBe("ok");
        active.push(a, b);
        commitments += 2;
        nullifiers += 1;
      } else if (active.length >= 2) {
        // merge
        const i1 = next() % active.length;
        const first = active.splice(i1, 1)[0]!;
        const i2 = next() % active.length;
        const second = active.splice(i2, 1)[0]!;
        const out = idCounter++;
        expect(doMerge(ctx, alice, first, second, out).result.type).toBe("ok");
        active.push(out);
        commitments += 1;
        nullifiers += 2;
      }
    }

    // invariants after the whole random walk
    expect(regRead("get-total-commitments")).toBeUint(commitments);
    expect(regRead("get-total-nullifiers")).toBeUint(nullifiers);
    expect(regRead("get-total-shielded-stx")).toBeUint(8 * 10 * ONE_STX);
    expect(noteRead("is-statistics-consistent")).toBeBool(true);
    // every remaining tracked note is active and spendable
    for (const id of active) {
      expect(noteRead("is-note-active", [Cl.buffer(bytes32(id, 0x3c))])).toBeBool(true);
    }
  }, 60000);
});
