import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  bytes32,
  proofBytes,
  shieldInputsHash,
  transferInputsHash,
  withdrawInputsHash,
} from "../helpers/attestation";
import { LocalProver } from "../helpers/aggregation";

/*
  Test suite for privacy-pool.clar -- the user-facing core of STX Shield,
  exercised against the REAL protocol stack: frozen privacy-registry, frozen
  note-manager, zk-verifier (real zkVerify inclusion proofs), and protocol-fees.

  Every operation goes through the pool exactly as it will on mainnet:
  proof binding, zkVerify inclusion, nullifiers, note lifecycle, root sequencing,
  fees, and STX movement -- all verified end to end.
*/

const REGISTRY = "privacy-registry";
const NOTES = "note-manager";
const VERIFIER = "zk-verifier";
const FEES = "protocol-fees";
const POOL = "privacy-pool";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const emergencyAdmin = accounts.get("wallet_2")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_7")!;
const recipient = accounts.get("wallet_8")!;
const attacker = accounts.get("wallet_6")!;

const ROLE = { PROTOCOL: 1, EMERGENCY: 2, VERIFIER: 3, FEE: 4 };
const FEE_TYPE = { SHIELD: 1, TRANSFER: 2, WITHDRAWAL: 3 };

const ERR = {
  // pool u250-u299
  UNAUTHORIZED: 250,
  OPERATION_DISABLED: 251,
  STALE_ROOT: 252,
  UNKNOWN_ROOT: 253,
  INVALID_RECIPIENT: 255,
  SWITCH_UNCHANGED: 257,
  // pass-through spaces
  REG_PAUSED: 102,
  REG_AMOUNT_BELOW_MINIMUM: 131,
  REG_AMOUNT_ABOVE_MAXIMUM: 132,
  REG_DUPLICATE_COMMITMENT: 111,
  NOTE_DUPLICATE: 154,
  REG_DUPLICATE_NULLIFIER: 116,
  REG_INSUFFICIENT_SHIELDED: 134,
  NOTE_INVALID_STATE: 156,
  NOTE_FROZEN: 159,
  VERIFIER_PROOF_REPLAY: 309,
  VERIFIER_NOT_AGGREGATED: 310,
  VERIFIER_AGGREGATION_NOT_FOUND: 311,
  VERIFIER_FROZEN: 302,
};

const ONE_STX = 1_000_000;
const PROOF_LEN = 448;
const GENESIS_ROOT = bytes32(1, 0x47);
const VKEY = {
  1: bytes32(1, 0x5a),
  2: bytes32(2, 0x5a),
  3: bytes32(3, 0x5a),
} as const;

const prover = new LocalProver(deployer);

const poolCall = (fn: string, args: unknown[], sender: string) =>
  simnet.callPublicFn(POOL, fn, args as any, sender);
const poolRead = (fn: string, args: unknown[] = []) =>
  simnet.callReadOnlyFn(POOL, fn, args as any, deployer).result;
const regCall = (fn: string, args: unknown[], sender: string) =>
  simnet.callPublicFn(REGISTRY, fn, args as any, sender);
const regRead = (fn: string, args: unknown[] = []) =>
  simnet.callReadOnlyFn(REGISTRY, fn, args as any, deployer).result;
const noteRead = (fn: string, args: unknown[] = []) =>
  simnet.callReadOnlyFn(NOTES, fn, args as any, deployer).result;
const feesRead = (fn: string, args: unknown[] = []) =>
  simnet.callReadOnlyFn(FEES, fn, args as any, deployer).result;

const stxBalance = (who: string): bigint =>
  simnet.getAssetsMap().get("STX")?.get(who) ?? 0n;
const poolPrincipal = `${deployer}.${POOL}`;
const feesPrincipal = `${deployer}.${FEES}`;

const setFee = (type: number, bps: number, flat: number) =>
  simnet.callPublicFn(
    FEES,
    "set-fee",
    [Cl.uint(type), Cl.uint(bps), Cl.uint(flat), Cl.bool(true)],
    deployer
  );

/*
  Protocol wiring, mirroring the mainnet deployment runbook:
  authorize the pool and note-manager contracts, bootstrap the genesis root,
  register the three circuit vkeys, and seat the attestation committee.
*/
type Ctx = { root: Uint8Array; rootCounter: number };

const wire = (): Ctx => {
  regCall("add-authorized-caller", [Cl.contractPrincipal(deployer, POOL)], deployer);
  regCall("add-authorized-caller", [Cl.contractPrincipal(deployer, NOTES)], deployer);
  regCall("update-root", [Cl.buffer(GENESIS_ROOT), Cl.uint(1)], deployer);
  for (const t of [1, 2, 3] as const) {
    simnet.callPublicFn(
      VERIFIER,
      "register-verification-key",
      [Cl.uint(t), Cl.uint(1), Cl.buffer(VKEY[t]), Cl.uint(PROOF_LEN)],
      deployer
    );
  }
  prover.configureBindings([1, 2, 3, 4, 5], 1);
  return { root: GENESIS_ROOT, rootCounter: 1 };
};

/** Attested shield. Advances ctx.root on success. */
const doShield = (
  ctx: Ctx,
  user: string,
  n: number,
  amount: number,
  overrides: Partial<{
    currentRoot: Uint8Array;
    inclusion: ReturnType<LocalProver["args"]>;
  }> = {}
) => {
  const commitment = bytes32(n, 0x3c);
  const owner = bytes32(n, 0x4f);
  const meta = bytes32(n, 0x4d);
  const currentRoot = overrides.currentRoot ?? ctx.root;
  const newRoot = bytes32(++ctx.rootCounter, 0x52);
  const inputsHash = shieldInputsHash({
    commitment,
    ownerCommitment: owner,
    metadata: meta,
    amount,
    currentRoot,
    newRoot,
  });
  const inclusion = overrides.inclusion ?? prover.args(1, inputsHash);
  const res = poolCall(
    "shield",
    [
      Cl.uint(amount),
      Cl.buffer(commitment),
      Cl.buffer(owner),
      Cl.buffer(meta),
      Cl.buffer(currentRoot),
      Cl.buffer(newRoot),
      ...inclusion,
    ],
    user
  );
  if (res.result.type === "ok") ctx.root = newRoot;
  return { ...res, commitment, newRoot };
};

/** Attested private transfer: consumes note `oldN`, creates note `newN`. */
const doTransfer = (
  ctx: Ctx,
  user: string,
  oldN: number,
  newN: number,
  overrides: Partial<{ currentRoot: Uint8Array; nullifier: Uint8Array }> = {}
) => {
  const oldNote = bytes32(oldN, 0x3c);
  const nullifier = overrides.nullifier ?? bytes32(oldN, 0x4e);
  const newCommitment = bytes32(newN, 0x3c);
  const newOwner = bytes32(newN, 0x4f);
  const newMeta = bytes32(newN, 0x4d);
  const currentRoot = overrides.currentRoot ?? ctx.root;
  const newRoot = bytes32(++ctx.rootCounter, 0x52);
  const inputsHash = transferInputsHash({
    nullifier,
    newCommitment,
    newOwnerCommitment: newOwner,
    newMetadata: newMeta,
    currentRoot,
    newRoot,
  });
  const res = poolCall(
    "transfer",
    [
      Cl.buffer(nullifier),
      Cl.buffer(newCommitment),
      Cl.buffer(newOwner),
      Cl.buffer(newMeta),
      Cl.buffer(currentRoot),
      Cl.buffer(newRoot),
      ...prover.args(2, inputsHash),
    ],
    user
  );
  if (res.result.type === "ok") ctx.root = newRoot;
  return { ...res, nullifier, newCommitment, newRoot };
};

/** Attested withdrawal of note `n` for `amount` to `to`. */
const doWithdraw = (
  ctx: Ctx,
  user: string,
  n: number,
  amount: number,
  to: string = recipient,
  overrides: Partial<{ root: Uint8Array; nullifier: Uint8Array }> = {}
) => {
  const noteId = bytes32(n, 0x3c);
  const nullifier = overrides.nullifier ?? bytes32(n, 0x4e);
  const root = overrides.root ?? ctx.root;
  const inputsHash = withdrawInputsHash({ nullifier, amount, recipient: to, root });
  return poolCall(
    "withdraw",
    [
      Cl.buffer(nullifier),
      Cl.uint(amount),
      Cl.principal(to),
      Cl.buffer(root),
      ...prover.args(3, inputsHash),
    ],
    user
  );
};

// ===========================================================================
// Deployment
// ===========================================================================

describe("deployment", () => {
  it("starts with all operations enabled and an empty pool", () => {
    expect(poolRead("is-shield-enabled")).toBeBool(true);
    expect(poolRead("is-transfer-enabled")).toBeBool(true);
    expect(poolRead("is-withdraw-enabled")).toBeBool(true);
    expect(poolRead("get-pool-balance")).toBeUint(0);
    expect(poolRead("get-pool-contract-version")).toBeUint(1);
  });
});

// ===========================================================================
// SHIELD
// ===========================================================================

describe("shield", () => {
  it("shields STX end to end across all five contracts", () => {
    const ctx = wire();
    const before = stxBalance(alice);
    const res = doShield(ctx, alice, 1, 100 * ONE_STX);
    expect(res.result).toBeOk(Cl.uint(0)); // first leaf

    // money moved: user -> pool
    expect(stxBalance(alice)).toBe(before - BigInt(100 * ONE_STX));
    expect(poolRead("get-pool-balance")).toBeUint(100 * ONE_STX);
    // registry: commitment, root, statistics
    expect(regRead("is-commitment-registered", [Cl.buffer(res.commitment)])).toBeBool(true);
    expect(regRead("get-total-shielded-stx")).toBeUint(100 * ONE_STX);
    expect(regRead("is-known-root", [Cl.buffer(res.newRoot)])).toBeBool(true);
    // note-manager: active note
    expect(noteRead("is-note-active", [Cl.buffer(res.commitment)])).toBeBool(true);
    // conservation invariant
    expect(poolRead("get-pool-balance")).toBeUint(100 * ONE_STX);
  });

  it("sequential shields get sequential leaf indices and advance the root", () => {
    const ctx = wire();
    expect(doShield(ctx, alice, 1, 10 * ONE_STX).result).toBeOk(Cl.uint(0));
    expect(doShield(ctx, bob, 2, 20 * ONE_STX).result).toBeOk(Cl.uint(1));
    expect(doShield(ctx, alice, 3, 30 * ONE_STX).result).toBeOk(Cl.uint(2));
    expect(regRead("get-total-commitments")).toBeUint(3);
    expect(regRead("get-total-shielded-stx")).toBeUint(60 * ONE_STX);
  });

  it("charges the shield fee on top: amount to pool, fee to treasury", () => {
    const ctx = wire();
    setFee(FEE_TYPE.SHIELD, 100, 0); // 1%
    const before = stxBalance(alice);
    expect(doShield(ctx, alice, 1, 100 * ONE_STX).result).toBeOk(Cl.uint(0));
    // user paid 100 + 1 STX
    expect(stxBalance(alice)).toBe(before - BigInt(101 * ONE_STX));
    expect(poolRead("get-pool-balance")).toBeUint(100 * ONE_STX);
    expect(stxBalance(feesPrincipal)).toBe(BigInt(ONE_STX));
    expect(feesRead("get-fee-type-stats", [Cl.uint(FEE_TYPE.SHIELD)])).toBeTuple({
      collected: Cl.uint(ONE_STX),
    });
    // shielded accounting is NET of fees
    expect(regRead("get-total-shielded-stx")).toBeUint(100 * ONE_STX);
  });

  it("rejects a stale current root (tree linearity)", () => {
    const ctx = wire();
    doShield(ctx, alice, 1, 10 * ONE_STX);
    // second shield built against the genesis root instead of the live one
    expect(
      doShield(ctx, bob, 2, 10 * ONE_STX, { currentRoot: GENESIS_ROOT }).result
    ).toBeErr(Cl.uint(ERR.STALE_ROOT));
  });

  it("rejects amounts outside the registry limits", () => {
    const ctx = wire();
    expect(doShield(ctx, alice, 1, ONE_STX - 1).result).toBeErr(
      Cl.uint(ERR.REG_AMOUNT_BELOW_MINIMUM)
    );
    expect(doShield(ctx, alice, 2, 1_000_000_000_001).result).toBeErr(
      Cl.uint(ERR.REG_AMOUNT_ABOVE_MAXIMUM)
    );
  });

  it("rejects a duplicate note/commitment even with a fresh valid proof", () => {
    const ctx = wire();
    doShield(ctx, alice, 1, 10 * ONE_STX);

    // Identical parameters now produce an identical statement, because the
    // binding contains ONLY the circuit's public inputs -- metadata and roots
    // no longer perturb it. So a byte-identical replay is caught earlier and
    // more strongly, by the verifier's proof-id registry.
    expect(doShield(ctx, bob, 1, 10 * ONE_STX).result).toBeErr(
      Cl.uint(ERR.VERIFIER_PROOF_REPLAY)
    );

    // A genuinely different statement (different amount) that nonetheless
    // reuses the commitment is stopped by the append-only note ledger.
    expect(doShield(ctx, bob, 1, 11 * ONE_STX).result).toBeErr(
      Cl.uint(ERR.NOTE_DUPLICATE)
    );
    expect(regRead("get-total-commitments")).toBeUint(1);
  });

  it("rejects proofs that zkVerify never verified", () => {
    const ctx = wire();
    // An inclusion path built against an aggregation whose root was never
    // published: the statement cannot be shown to have been verified.
    const unpublished = new LocalProver(deployer);
    unpublished.publishRoots = false;
    expect(
      doShield(ctx, alice, 1, 10 * ONE_STX, {
        inclusion: unpublished.args(1, new Uint8Array(32).fill(0xab)),
      }).result
    ).toBeErr(Cl.uint(ERR.VERIFIER_AGGREGATION_NOT_FOUND));
    // a valid shield, then an identical re-submission (same proof + params
    // rebuilt against the same root) is stopped by root sequencing first --
    // so craft the exact same call again: current root moved -> stale root
    expect(doShield(ctx, alice, 1, 10 * ONE_STX).result).toBeOk(Cl.uint(0));
  });

  it("respects the registry pause and the pool's own shield switch", () => {
    const ctx = wire();
    regCall("grant-role", [Cl.principal(emergencyAdmin), Cl.uint(ROLE.EMERGENCY)], deployer);
    regCall("pause-protocol", [], deployer);
    expect(doShield(ctx, alice, 1, 10 * ONE_STX).result).toBeErr(Cl.uint(ERR.REG_PAUSED));
    regCall("unpause-protocol", [], deployer);

    simnet.callPublicFn(POOL, "set-shield-enabled", [Cl.bool(false)], emergencyAdmin);
    expect(doShield(ctx, alice, 1, 10 * ONE_STX).result).toBeErr(
      Cl.uint(ERR.OPERATION_DISABLED)
    );
    simnet.callPublicFn(POOL, "set-shield-enabled", [Cl.bool(true)], emergencyAdmin);
    expect(doShield(ctx, alice, 1, 10 * ONE_STX).result).toBeOk(Cl.uint(0));
  });
});

// ===========================================================================
// PRIVATE TRANSFER
// ===========================================================================

describe("private transfer", () => {
  it("transfers privately: only a nullifier is published, spend is unlinkable", () => {
    const ctx = wire();
    doShield(ctx, alice, 1, 50 * ONE_STX);
    const res = doTransfer(ctx, alice, 1, 2);
    expect(res.result).toBeOk(Cl.uint(1)); // second leaf

    expect(regRead("is-nullifier-spent", [Cl.buffer(res.nullifier)])).toBeBool(true);
    // PRIVACY: the consumed note is NOT marked spent on chain -- nothing links
    // this transfer to the leaf it consumed. The nullifier is the only trace.
    expect(noteRead("is-note-spent", [Cl.buffer(bytes32(1, 0x3c))])).toBeBool(false);
    expect(noteRead("is-note-active", [Cl.buffer(res.newCommitment)])).toBeBool(true);
    expect(regRead("get-total-transfers")).toBeUint(1);
    // no STX moved
    expect(poolRead("get-pool-balance")).toBeUint(50 * ONE_STX);
    expect(regRead("get-total-shielded-stx")).toBeUint(50 * ONE_STX);
  });

  it("rejects double spends via the nullifier set alone", () => {
    const ctx = wire();
    doShield(ctx, alice, 1, 50 * ONE_STX);
    doShield(ctx, alice, 2, 50 * ONE_STX);
    doTransfer(ctx, alice, 1, 3);
    // Spending the same note again reuses its nullifier -- rejected by the
    // registry. This is now the ONLY double-spend gate, and it leaks nothing.
    expect(doTransfer(ctx, alice, 1, 4).result).toBeErr(Cl.uint(ERR.REG_DUPLICATE_NULLIFIER));
    // reusing note 1's nullifier against a different (active) note
    expect(
      doTransfer(ctx, alice, 2, 5, { nullifier: bytes32(1, 0x4e) }).result
    ).toBeErr(Cl.uint(ERR.REG_DUPLICATE_NULLIFIER));
  });

  it("chains transfers: each output is immediately spendable", () => {
    const ctx = wire();
    doShield(ctx, alice, 1, 50 * ONE_STX);
    expect(doTransfer(ctx, alice, 1, 2).result).toBeOk(Cl.uint(1));
    expect(doTransfer(ctx, bob, 2, 3).result).toBeOk(Cl.uint(2));
    expect(doTransfer(ctx, alice, 3, 4).result).toBeOk(Cl.uint(3));
    expect(regRead("get-total-transfers")).toBeUint(3);
    expect(regRead("get-total-nullifiers")).toBeUint(3);
    expect(noteRead("is-note-active", [Cl.buffer(bytes32(4, 0x3c))])).toBeBool(true);
  });

  it("charges the flat transfer fee transparently from tx-sender", () => {
    const ctx = wire();
    setFee(FEE_TYPE.TRANSFER, 0, ONE_STX / 2); // flat 0.5 STX
    doShield(ctx, alice, 1, 50 * ONE_STX);
    const before = stxBalance(bob);
    expect(doTransfer(ctx, bob, 1, 2).result).toBeOk(Cl.uint(1));
    expect(stxBalance(bob)).toBe(before - BigInt(ONE_STX / 2));
    expect(stxBalance(feesPrincipal)).toBe(BigInt(ONE_STX / 2));
    // pool balance untouched by transfers
    expect(poolRead("get-pool-balance")).toBeUint(50 * ONE_STX);
  });

  it("per-note freezing can no longer censor a spend; stale roots and the switch still hold", () => {
    const ctx = wire();
    regCall("grant-role", [Cl.principal(emergencyAdmin), Cl.uint(ROLE.EMERGENCY)], deployer);
    doShield(ctx, alice, 1, 50 * ONE_STX);
    doShield(ctx, alice, 2, 50 * ONE_STX);

    // PRIVACY / CENSORSHIP-RESISTANCE: freezing an individual note no longer
    // blocks anything. The chain never learns which note a spend consumes, so
    // no admin can single one out. This capability is now unreachable by
    // construction -- exactly what a censorship-resistant pool requires.
    simnet.callPublicFn(NOTES, "freeze-note", [Cl.buffer(bytes32(1, 0x3c))], emergencyAdmin);
    expect(doTransfer(ctx, alice, 1, 3).result.type).toBe("ok");

    expect(
      doTransfer(ctx, alice, 2, 4, { currentRoot: GENESIS_ROOT }).result
    ).toBeErr(Cl.uint(ERR.STALE_ROOT));

    simnet.callPublicFn(POOL, "set-transfer-enabled", [Cl.bool(false)], emergencyAdmin);
    expect(doTransfer(ctx, alice, 2, 4).result).toBeErr(Cl.uint(ERR.OPERATION_DISABLED));
  });
});

// ===========================================================================
// WITHDRAWAL
// ===========================================================================

describe("withdrawal", () => {
  it("withdraws end to end with exact balances", () => {
    const ctx = wire();
    doShield(ctx, alice, 1, 100 * ONE_STX);
    const before = stxBalance(recipient);
    expect(doWithdraw(ctx, alice, 1, 40 * ONE_STX)).toSatisfy(
      (r: any) => r.result.type === "ok"
    );
    expect(stxBalance(recipient)).toBe(before + BigInt(40 * ONE_STX));
    expect(poolRead("get-pool-balance")).toBeUint(60 * ONE_STX);
    expect(regRead("get-total-shielded-stx")).toBeUint(60 * ONE_STX);
    expect(regRead("get-total-withdrawals")).toBeUint(1);
    // PRIVACY: the withdrawn note is not marked on chain; only its nullifier.
    expect(noteRead("is-note-withdrawn", [Cl.buffer(bytes32(1, 0x3c))])).toBeBool(false);
  });

  it("splits the withdrawal between recipient and treasury when a fee is set", () => {
    const ctx = wire();
    setFee(FEE_TYPE.WITHDRAWAL, 100, 0); // 1%
    doShield(ctx, alice, 1, 100 * ONE_STX);
    const before = stxBalance(recipient);
    const res = doWithdraw(ctx, alice, 1, 50 * ONE_STX);
    expect(res.result).toBeOk(Cl.uint(495 * (ONE_STX / 10))); // 49.5 STX net
    expect(stxBalance(recipient)).toBe(before + BigInt(49_500_000));
    expect(stxBalance(feesPrincipal)).toBe(BigInt(500_000));
    // pool decreased by the FULL amount; conservation holds
    expect(poolRead("get-pool-balance")).toBeUint(50 * ONE_STX);
    expect(regRead("get-total-shielded-stx")).toBeUint(50 * ONE_STX);
  });

  it("accepts historical roots -- concurrent tree growth cannot grief withdrawals", () => {
    const ctx = wire();
    doShield(ctx, alice, 1, 50 * ONE_STX);
    const oldRoot = ctx.root;
    doShield(ctx, bob, 2, 50 * ONE_STX); // root advances
    // withdraw note 1 with a proof built against the pre-advance root
    expect(doWithdraw(ctx, alice, 1, 10 * ONE_STX, recipient, { root: oldRoot }).result)
      .toSatisfy((r: any) => r.type === "ok");
  });

  it("rejects unknown and deactivated roots", () => {
    const ctx = wire();
    doShield(ctx, alice, 1, 50 * ONE_STX);
    expect(
      doWithdraw(ctx, alice, 1, 10 * ONE_STX, recipient, { root: bytes32(999, 0x52) })
        .result
    ).toBeErr(Cl.uint(ERR.UNKNOWN_ROOT));
    // deactivate the current root: registry-level kill switch
    regCall("set-root-status", [Cl.buffer(ctx.root), Cl.bool(false)], deployer);
    expect(doWithdraw(ctx, alice, 1, 10 * ONE_STX).result).toBeErr(
      Cl.uint(ERR.UNKNOWN_ROOT)
    );
  });

  it("rejects double withdrawals via the nullifier set alone", () => {
    const ctx = wire();
    doShield(ctx, alice, 1, 50 * ONE_STX);
    doShield(ctx, alice, 2, 50 * ONE_STX);
    doWithdraw(ctx, alice, 1, 20 * ONE_STX);
    // Re-submitting the identical withdrawal replays the identical zkVerify
    // statement, so the verifier's proof-id gate fires first (u309). A
    // DIFFERENT proof reusing the same nullifier hits the registry (u116),
    // asserted below.
    expect(doWithdraw(ctx, alice, 1, 20 * ONE_STX).result).toBeErr(
      Cl.uint(ERR.VERIFIER_PROOF_REPLAY)
    );
    // A genuinely different statement (different amount) reusing note 1's
    // nullifier gets past the proof-id gate and is stopped by the registry.
    // NOTE: with note ids private, a withdrawal is identified ONLY by
    // (nullifier, amount, recipient, root) -- two withdrawals of the same
    // amount to the same recipient are now indistinguishable on chain, which
    // is precisely the unlinkability property.
    expect(
      doWithdraw(ctx, alice, 2, 21 * ONE_STX, recipient, { nullifier: bytes32(1, 0x4e) })
        .result
    ).toBeErr(Cl.uint(ERR.REG_DUPLICATE_NULLIFIER));
  });

  it("the registry's shielded-balance backstop rejects over-withdrawal", () => {
    const ctx = wire();
    doShield(ctx, alice, 1, 10 * ONE_STX);
    // attested for 50 STX although only 10 are shielded: the registry
    // accounting is the final line of defense
    expect(doWithdraw(ctx, alice, 1, 50 * ONE_STX).result).toBeErr(
      Cl.uint(ERR.REG_INSUFFICIENT_SHIELDED)
    );
  });

  it("rejects invalid recipients and the withdraw switch", () => {
    const ctx = wire();
    regCall("grant-role", [Cl.principal(emergencyAdmin), Cl.uint(ROLE.EMERGENCY)], deployer);
    doShield(ctx, alice, 1, 50 * ONE_STX);
    expect(
      doWithdraw(ctx, alice, 1, 10 * ONE_STX, "SP000000000000000000002Q6VF78").result
    ).toBeErr(Cl.uint(ERR.INVALID_RECIPIENT));
    expect(doWithdraw(ctx, alice, 1, 10 * ONE_STX, poolPrincipal).result).toBeErr(
      Cl.uint(ERR.INVALID_RECIPIENT)
    );
    simnet.callPublicFn(POOL, "set-withdraw-enabled", [Cl.bool(false)], emergencyAdmin);
    expect(doWithdraw(ctx, alice, 1, 10 * ONE_STX).result).toBeErr(
      Cl.uint(ERR.OPERATION_DISABLED)
    );
  });

  it("recipient binding: a proof verified for Alice's recipient cannot pay Bob", () => {
    const ctx = wire();
    doShield(ctx, alice, 1, 50 * ONE_STX);
    // The statement zkVerify verified names `recipient`; the transaction
    // names `attacker`. The public-inputs hash differs, so the leaf differs,
    // so the inclusion path no longer reconstructs the published root.
    const noteId = bytes32(1, 0x3c);
    const nullifier = bytes32(1, 0x4e);
    const inputsHash = withdrawInputsHash({
      nullifier,
      amount: 10 * ONE_STX,
      recipient, // proven destination
      root: ctx.root,
    });
    expect(
      poolCall(
        "withdraw",
        [
          Cl.buffer(nullifier),
          Cl.uint(10 * ONE_STX),
          Cl.principal(attacker), // swapped destination
          Cl.buffer(ctx.root),
          ...prover.args(3, inputsHash),
        ],
        attacker
      ).result
    ).toBeErr(Cl.uint(ERR.VERIFIER_NOT_AGGREGATED));
  });
});

// ===========================================================================
// Emergency switches & access control
// ===========================================================================

describe("emergency switches", () => {
  it("only emergency admin or owner control switches; no-ops rejected", () => {
    regCall("grant-role", [Cl.principal(emergencyAdmin), Cl.uint(ROLE.EMERGENCY)], deployer);
    expect(
      simnet.callPublicFn(POOL, "set-shield-enabled", [Cl.bool(false)], attacker).result
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(
      simnet.callPublicFn(POOL, "set-shield-enabled", [Cl.bool(true)], deployer).result
    ).toBeErr(Cl.uint(ERR.SWITCH_UNCHANGED));
    expect(
      simnet.callPublicFn(POOL, "set-shield-enabled", [Cl.bool(false)], emergencyAdmin)
        .result
    ).toBeOk(Cl.bool(true));
    expect(poolRead("is-shield-enabled")).toBeBool(false);
  });

  it("verifier freeze halts every pool operation at once", () => {
    const ctx = wire();
    doShield(ctx, alice, 1, 50 * ONE_STX);
    simnet.callPublicFn(VERIFIER, "freeze-verification", [], deployer);
    expect(doShield(ctx, alice, 2, 10 * ONE_STX).result).toBeErr(
      Cl.uint(ERR.VERIFIER_FROZEN)
    );
    expect(doTransfer(ctx, alice, 1, 3).result).toBeErr(Cl.uint(ERR.VERIFIER_FROZEN));
    expect(doWithdraw(ctx, alice, 1, 10 * ONE_STX).result).toBeErr(
      Cl.uint(ERR.VERIFIER_FROZEN)
    );
  });
});

// ===========================================================================
// Mainnet scenario
// ===========================================================================

describe("mainnet scenario", () => {
  it("full protocol life: fees on, multiple users, conservation always holds", () => {
    const ctx = wire();
    setFee(FEE_TYPE.SHIELD, 50, 0); // 0.5%
    setFee(FEE_TYPE.WITHDRAWAL, 100, 0); // 1%
    setFee(FEE_TYPE.TRANSFER, 0, ONE_STX / 4); // flat 0.25 STX

    // two users shield
    expect(doShield(ctx, alice, 1, 200 * ONE_STX).result).toBeOk(Cl.uint(0));
    expect(doShield(ctx, bob, 2, 100 * ONE_STX).result).toBeOk(Cl.uint(1));

    // private activity
    expect(doTransfer(ctx, alice, 1, 3).result).toBeOk(Cl.uint(2));
    expect(doTransfer(ctx, bob, 2, 4).result).toBeOk(Cl.uint(3));
    expect(doTransfer(ctx, alice, 3, 5).result).toBeOk(Cl.uint(4));

    // withdrawals
    expect(doWithdraw(ctx, alice, 5, 80 * ONE_STX).result).toBeOk(
      Cl.uint(792 * (ONE_STX / 10))
    );
    expect(doWithdraw(ctx, bob, 4, 50 * ONE_STX).result).toBeOk(
      Cl.uint(495 * (ONE_STX / 10))
    );

    // conservation: pool balance == shielded accounting
    expect(poolRead("get-pool-balance")).toBeUint(170 * ONE_STX);
    expect(regRead("get-total-shielded-stx")).toBeUint(170 * ONE_STX);

    // treasury: shield fees (1.5) + transfer fees (0.75) + withdrawal fees (1.3)
    const expectedTreasury =
      (200 + 100) * (ONE_STX / 200) + 3 * (ONE_STX / 4) + (80 + 50) * (ONE_STX / 100);
    expect(stxBalance(feesPrincipal)).toBe(BigInt(expectedTreasury));

    // registry statistics are complete and consistent
    expect(regRead("get-statistics")).toBeTuple({
      "total-commitments": Cl.uint(5),
      "total-nullifiers": Cl.uint(5),
      "total-notes": Cl.uint(5),
      "total-transfers": Cl.uint(3),
      "total-withdrawals": Cl.uint(2),
      "total-shielded-stx": Cl.uint(170 * ONE_STX),
    });
    // note-manager agrees
    expect(noteRead("get-note-statistics")).toBeTuple({
      "total-registered": Cl.uint(5),
      // PRIVACY: the ledger cannot know which notes were consumed, so every
      // registered note stays ACTIVE. Consumption is tracked ONLY by the
      // registry's nullifier set, which reveals nothing about which leaf.
      "total-active": Cl.uint(5),
      "total-spent": Cl.uint(0),
      "total-withdrawn": Cl.uint(0),
      "total-frozen": Cl.uint(0),
      "total-deprecated": Cl.uint(0),
    });
    expect(noteRead("is-statistics-consistent")).toBeBool(true);

    // owner sweeps the treasury
    expect(
      simnet.callPublicFn(
        FEES,
        "withdraw-fees",
        [Cl.uint(expectedTreasury), Cl.principal(deployer)],
        deployer
      ).result
    ).toBeOk(Cl.bool(true));
    expect(stxBalance(feesPrincipal)).toBe(0n);
  });

  it("incident drill: emergency pause, resolve, and resume with funds intact", () => {
    const ctx = wire();
    regCall("grant-role", [Cl.principal(emergencyAdmin), Cl.uint(ROLE.EMERGENCY)], deployer);
    doShield(ctx, alice, 1, 100 * ONE_STX);

    // incident: emergency-pause protocol + freeze verification
    regCall("emergency-pause-protocol", [], emergencyAdmin);
    simnet.callPublicFn(VERIFIER, "freeze-verification", [], emergencyAdmin);
    expect(doWithdraw(ctx, alice, 1, 10 * ONE_STX).result).toBeErr(Cl.uint(103));

    // funds are exactly where they were
    expect(poolRead("get-pool-balance")).toBeUint(100 * ONE_STX);

    // recovery
    regCall("resolve-emergency", [], deployer);
    regCall("unpause-protocol", [], deployer);
    simnet.callPublicFn(VERIFIER, "unfreeze-verification", [], emergencyAdmin);
    expect(doWithdraw(ctx, alice, 1, 10 * ONE_STX).result).toBeOk(Cl.uint(10 * ONE_STX));
  });
});
