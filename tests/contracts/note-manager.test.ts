import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";

/*
  Test suite for note-manager.clar -- the STX Shield note lifecycle layer.

  Categories: unit, security, integration, edge-case, property/randomized,
  invariant, and mainnet-scenario tests, per the Milestone 2 test plan.

  The simnet is reset between tests. note-manager holds NO local authority
  state: authorization is delegated to the frozen privacy-registry v1.0.0,
  so most setups configure the registry first:
    - `pool` (wallet_5) stands in for privacy-pool: an authorized caller.
    - the note-manager CONTRACT itself must be an authorized caller in the
      registry (it calls record-note-created on registration).
*/

const REGISTRY = "privacy-registry";
const NOTES = "note-manager";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const protocolAdmin = accounts.get("wallet_1")!;
const emergencyAdmin = accounts.get("wallet_2")!;
const verifierAdmin = accounts.get("wallet_3")!;
const pool = accounts.get("wallet_5")!;
const attacker = accounts.get("wallet_6")!;
const successor = accounts.get("wallet_7")!;

const NOTE_STATE = { ACTIVE: 1, SPENT: 2, WITHDRAWN: 3, FROZEN: 4, DEPRECATED: 5 };
const ROLE = { PROTOCOL: 1, EMERGENCY: 2, VERIFIER: 3, FEE: 4 };

// note-manager errors (u150-u199)
const ERR = {
  UNAUTHORIZED: 150,
  UNAUTHORIZED_CALLER: 151,
  INVALID_NOTE_ID: 152,
  INVALID_OWNER_COMMITMENT: 153,
  DUPLICATE_NOTE: 154,
  NOTE_NOT_FOUND: 155,
  INVALID_NOTE_STATE: 156,
  INVALID_STATE_TRANSITION: 157,
  VERSION_MISMATCH: 158,
  NOTE_FROZEN: 159,
};

// registry errors that pass through note-manager unchanged (u100-u149)
const REG_ERR = {
  UNAUTHORIZED_CALLER: 101,
  PROTOCOL_PAUSED: 102,
  PROTOCOL_EMERGENCY: 103,
  PROTOCOL_UPGRADING: 104,
  PROTOCOL_DEPRECATED: 105,
  NOTE_LIMIT_EXCEEDED: 133,
};

const ONE_STX = 1_000_000;
const DEFAULT_LIMITS = {
  "min-shield": ONE_STX,
  "max-shield": 1_000_000_000_000,
  "min-withdrawal": ONE_STX,
  "max-withdrawal": 1_000_000_000_000,
  "max-commitments": 1_048_576,
  "max-notes": 1_048_576,
  "max-fee-bps": 100,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic non-zero 32-byte hash from a 32-bit integer. */
const hash32 = (n: number) => {
  const b = new Uint8Array(32);
  b[31] = n & 0xff;
  b[30] = (n >>> 8) & 0xff;
  b[29] = (n >>> 16) & 0xff;
  b[28] = (n >>> 24) & 0xff;
  b[0] = 0x2b; // note-domain prefix; never the zero hash
  return Cl.buffer(b);
};
const ZERO_HASH = Cl.buffer(new Uint8Array(32));
const noteManagerPrincipal = Cl.contractPrincipal(deployer, NOTES);

const call = (fn: string, args: unknown[], sender: string) =>
  simnet.callPublicFn(NOTES, fn, args as any, sender);
const read = (fn: string, args: unknown[] = []) =>
  simnet.callReadOnlyFn(NOTES, fn, args as any, deployer).result;
const regCall = (fn: string, args: unknown[], sender: string) =>
  simnet.callPublicFn(REGISTRY, fn, args as any, sender);
const regRead = (fn: string, args: unknown[] = []) =>
  simnet.callReadOnlyFn(REGISTRY, fn, args as any, deployer).result;

const uintTuple = (obj: Record<string, number>) =>
  Cl.tuple(Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Cl.uint(v)])));
const limitsCV = (overrides: Partial<typeof DEFAULT_LIMITS> = {}) =>
  uintTuple({ ...DEFAULT_LIMITS, ...overrides });
const versionsCV = (overrides: Record<string, number> = {}) =>
  uintTuple({
    // circuit ships at 2 in v2; versions are monotonic non-decreasing, so the
    // baseline must not regress it.
    protocol: 1, verifier: 1, note: 1, circuit: 2, commitment: 1, root: 1,
    ...overrides,
  });

/** Standard integration wiring: pool wallet + note-manager contract are
 *  authorized callers in the registry. */
const wire = () => {
  regCall("add-authorized-caller", [Cl.principal(pool)], deployer);
  regCall("add-authorized-caller", [noteManagerPrincipal], deployer);
};
const grantRole = (account: string, role: number) =>
  regCall("grant-role", [Cl.principal(account), Cl.uint(role)], deployer);

const registerNote = (n: number, sender = pool, version = 1) =>
  call(
    "register-note",
    [hash32(n), hash32(9_000_000 + n), hash32(8_000_000 + n), Cl.uint(version)],
    sender
  );
const spendNote = (n: number, sender = pool) =>
  call("spend-note", [hash32(n)], sender);
const withdrawNote = (n: number, sender = pool) =>
  call("withdraw-note", [hash32(n)], sender);
const freezeNote = (n: number, sender = deployer) =>
  call("freeze-note", [hash32(n)], sender);
const reactivateNote = (n: number, sender = deployer) =>
  call("reactivate-note", [hash32(n)], sender);
const deprecateNote = (n: number, sender = deployer) =>
  call("deprecate-note", [hash32(n)], sender);

const expectStats = (expected: Record<string, number>) =>
  expect(read("get-note-statistics")).toBeTuple({
    "total-registered": Cl.uint(expected.registered ?? 0),
    "total-active": Cl.uint(expected.active ?? 0),
    "total-spent": Cl.uint(expected.spent ?? 0),
    "total-withdrawn": Cl.uint(expected.withdrawn ?? 0),
    "total-frozen": Cl.uint(expected.frozen ?? 0),
    "total-deprecated": Cl.uint(expected.deprecated ?? 0),
  });

// ===========================================================================
// UNIT -- registration
// ===========================================================================

describe("unit: note registration", () => {
  it("registers a note and stores the full record", () => {
    wire();
    expect(registerNote(1).result).toBeOk(Cl.bool(true));
    const height = simnet.blockHeight;
    expect(read("get-note", [hash32(1)])).toBeSome(
      Cl.tuple({
        state: Cl.uint(NOTE_STATE.ACTIVE),
        "owner-commitment": hash32(9_000_001),
        version: Cl.uint(1),
        metadata: hash32(8_000_001),
        "registered-at": Cl.uint(height),
        "updated-at": Cl.uint(height),
      })
    );
  });

  it("newly registered notes are ACTIVE", () => {
    wire();
    registerNote(1);
    expect(read("get-note-state", [hash32(1)])).toBeSome(Cl.uint(NOTE_STATE.ACTIVE));
    expect(read("is-note-active", [hash32(1)])).toBeBool(true);
    expect(read("validate-note-active", [hash32(1)])).toBeOk(Cl.bool(true));
  });

  it("note-exists reflects registration", () => {
    wire();
    expect(read("note-exists", [hash32(1)])).toBeBool(false);
    registerNote(1);
    expect(read("note-exists", [hash32(1)])).toBeBool(true);
  });

  it("unknown notes read as none / false everywhere", () => {
    expect(read("get-note", [hash32(42)])).toBeNone();
    expect(read("get-note-state", [hash32(42)])).toBeNone();
    expect(read("get-note-version", [hash32(42)])).toBeNone();
    expect(read("get-note-owner-commitment", [hash32(42)])).toBeNone();
    expect(read("get-note-metadata", [hash32(42)])).toBeNone();
    expect(read("is-note-active", [hash32(42)])).toBeBool(false);
    expect(read("is-note-spent", [hash32(42)])).toBeBool(false);
    expect(read("validate-note-active", [hash32(42)])).toBeErr(
      Cl.uint(ERR.NOTE_NOT_FOUND)
    );
  });

  it("stores owner commitment, metadata, and version per note", () => {
    wire();
    registerNote(7);
    expect(read("get-note-owner-commitment", [hash32(7)])).toBeSome(hash32(9_000_007));
    expect(read("get-note-metadata", [hash32(7)])).toBeSome(hash32(8_000_007));
    expect(read("get-note-version", [hash32(7)])).toBeSome(Cl.uint(1));
  });

  it("registration updates local statistics", () => {
    wire();
    registerNote(1);
    registerNote(2);
    registerNote(3);
    expectStats({ registered: 3, active: 3 });
  });

  it("registration updates the registry's authoritative total-notes", () => {
    wire();
    registerNote(1);
    registerNote(2);
    expect(regRead("get-total-notes")).toBeUint(2);
  });

  it("many notes can be registered by the same caller", () => {
    wire();
    for (let i = 1; i <= 10; i++) {
      expect(registerNote(i).result).toBeOk(Cl.bool(true));
    }
    expectStats({ registered: 10, active: 10 });
  });
});

// ===========================================================================
// UNIT -- lifecycle transitions
// ===========================================================================

describe("unit: lifecycle transitions", () => {
  it("spend: ACTIVE -> SPENT", () => {
    wire();
    registerNote(1);
    expect(spendNote(1).result).toBeOk(Cl.bool(true));
    expect(read("is-note-spent", [hash32(1)])).toBeBool(true);
    expect(read("is-note-active", [hash32(1)])).toBeBool(false);
    expectStats({ registered: 1, spent: 1 });
  });

  it("withdraw: ACTIVE -> WITHDRAWN", () => {
    wire();
    registerNote(1);
    expect(withdrawNote(1).result).toBeOk(Cl.bool(true));
    expect(read("is-note-withdrawn", [hash32(1)])).toBeBool(true);
    expectStats({ registered: 1, withdrawn: 1 });
  });

  it("freeze: ACTIVE -> FROZEN", () => {
    wire();
    registerNote(1);
    expect(freezeNote(1).result).toBeOk(Cl.bool(true));
    expect(read("is-note-frozen", [hash32(1)])).toBeBool(true);
    expect(read("validate-note-active", [hash32(1)])).toBeErr(
      Cl.uint(ERR.NOTE_FROZEN)
    );
    expectStats({ registered: 1, frozen: 1 });
  });

  it("reactivate: FROZEN -> ACTIVE", () => {
    wire();
    registerNote(1);
    freezeNote(1);
    expect(reactivateNote(1).result).toBeOk(Cl.bool(true));
    expect(read("is-note-active", [hash32(1)])).toBeBool(true);
    expectStats({ registered: 1, active: 1 });
  });

  it("deprecate: FROZEN -> DEPRECATED", () => {
    wire();
    registerNote(1);
    freezeNote(1);
    expect(deprecateNote(1).result).toBeOk(Cl.bool(true));
    expect(read("is-note-deprecated", [hash32(1)])).toBeBool(true);
    expectStats({ registered: 1, deprecated: 1 });
  });

  it("state changes update updated-at but never registered-at", () => {
    wire();
    registerNote(1);
    const registeredAt = simnet.blockHeight;
    simnet.mineEmptyBlocks(5);
    spendNote(1);
    const updatedAt = simnet.blockHeight;
    expect(read("get-note", [hash32(1)])).toBeSome(
      Cl.tuple({
        state: Cl.uint(NOTE_STATE.SPENT),
        "owner-commitment": hash32(9_000_001),
        version: Cl.uint(1),
        metadata: hash32(8_000_001),
        "registered-at": Cl.uint(registeredAt),
        "updated-at": Cl.uint(updatedAt),
      })
    );
  });

  it("immutable fields survive the full lifecycle", () => {
    wire();
    registerNote(1);
    freezeNote(1);
    reactivateNote(1);
    spendNote(1);
    expect(read("get-note-owner-commitment", [hash32(1)])).toBeSome(hash32(9_000_001));
    expect(read("get-note-metadata", [hash32(1)])).toBeSome(hash32(8_000_001));
    expect(read("get-note-version", [hash32(1)])).toBeSome(Cl.uint(1));
  });

  it("independent notes transition independently", () => {
    wire();
    registerNote(1);
    registerNote(2);
    registerNote(3);
    registerNote(4);
    spendNote(1);
    withdrawNote(2);
    freezeNote(3);
    expect(read("is-note-spent", [hash32(1)])).toBeBool(true);
    expect(read("is-note-withdrawn", [hash32(2)])).toBeBool(true);
    expect(read("is-note-frozen", [hash32(3)])).toBeBool(true);
    expect(read("is-note-active", [hash32(4)])).toBeBool(true);
    expectStats({ registered: 4, active: 1, spent: 1, withdrawn: 1, frozen: 1 });
  });
});

// ===========================================================================
// UNIT -- invalid transitions (the complete forbidden matrix)
// ===========================================================================

describe("unit: invalid transitions", () => {
  it("SPENT is terminal: spend/withdraw/freeze/reactivate/deprecate all fail", () => {
    wire();
    registerNote(1);
    spendNote(1);
    expect(spendNote(1).result).toBeErr(Cl.uint(ERR.INVALID_NOTE_STATE));
    expect(withdrawNote(1).result).toBeErr(Cl.uint(ERR.INVALID_NOTE_STATE));
    expect(freezeNote(1).result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
    expect(reactivateNote(1).result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
    // deprecation requires FROZEN, so even the owner cannot deprecate a spent note
    expect(deprecateNote(1).result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
  });

  it("WITHDRAWN is terminal", () => {
    wire();
    registerNote(1);
    withdrawNote(1);
    expect(spendNote(1).result).toBeErr(Cl.uint(ERR.INVALID_NOTE_STATE));
    expect(withdrawNote(1).result).toBeErr(Cl.uint(ERR.INVALID_NOTE_STATE));
    expect(freezeNote(1).result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
    expect(reactivateNote(1).result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
    expect(deprecateNote(1).result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
  });

  it("DEPRECATED is terminal", () => {
    wire();
    registerNote(1);
    freezeNote(1);
    deprecateNote(1);
    expect(spendNote(1).result).toBeErr(Cl.uint(ERR.INVALID_NOTE_STATE));
    expect(withdrawNote(1).result).toBeErr(Cl.uint(ERR.INVALID_NOTE_STATE));
    expect(freezeNote(1).result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
    expect(reactivateNote(1).result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
    expect(deprecateNote(1).result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
  });

  it("FROZEN notes cannot be spent or withdrawn (precise error)", () => {
    wire();
    registerNote(1);
    freezeNote(1);
    expect(spendNote(1).result).toBeErr(Cl.uint(ERR.NOTE_FROZEN));
    expect(withdrawNote(1).result).toBeErr(Cl.uint(ERR.NOTE_FROZEN));
  });

  it("ACTIVE notes cannot be reactivated or deprecated directly", () => {
    wire();
    registerNote(1);
    expect(reactivateNote(1).result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
    expect(deprecateNote(1).result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
  });

  it("FROZEN notes cannot be frozen again", () => {
    wire();
    registerNote(1);
    freezeNote(1);
    expect(freezeNote(1).result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
  });

  it("transitions on unknown notes fail with NOTE-NOT-FOUND", () => {
    wire();
    expect(spendNote(99).result).toBeErr(Cl.uint(ERR.NOTE_NOT_FOUND));
    expect(withdrawNote(99).result).toBeErr(Cl.uint(ERR.NOTE_NOT_FOUND));
    expect(freezeNote(99).result).toBeErr(Cl.uint(ERR.NOTE_NOT_FOUND));
    expect(reactivateNote(99).result).toBeErr(Cl.uint(ERR.NOTE_NOT_FOUND));
    expect(deprecateNote(99).result).toBeErr(Cl.uint(ERR.NOTE_NOT_FOUND));
  });
});

// ===========================================================================
// UNIT -- read functions & contract info
// ===========================================================================

describe("unit: contract info reads", () => {
  it("reports its own contract version", () => {
    expect(read("get-note-manager-version")).toBeUint(1);
  });

  it("reads the current note version live from the registry", () => {
    expect(read("get-current-note-version")).toBeUint(1);
  });

  it("get-note-manager-info aggregates version, registry context, and stats", () => {
    wire();
    registerNote(1);
    spendNote(1);
    expect(read("get-note-manager-info")).toBeTuple({
      "contract-version": Cl.uint(1),
      "note-version": Cl.uint(1),
      "protocol-state": Cl.uint(1),
      statistics: uintTuple({
        "total-registered": 1,
        "total-active": 0,
        "total-spent": 1,
        "total-withdrawn": 0,
        "total-frozen": 0,
        "total-deprecated": 0,
      }),
    });
  });

  it("statistics start at zero and consistent", () => {
    expectStats({});
    expect(read("is-statistics-consistent")).toBeBool(true);
  });
});

// ===========================================================================
// SECURITY -- authorization
// ===========================================================================

describe("security: authorization", () => {
  it("unauthorized callers cannot register notes", () => {
    wire();
    expect(registerNote(1, attacker).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED_CALLER));
  });

  it("even the registry owner cannot register notes directly", () => {
    wire();
    expect(registerNote(1, deployer).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED_CALLER));
  });

  it("unauthorized callers cannot spend or withdraw", () => {
    wire();
    registerNote(1);
    expect(spendNote(1, attacker).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED_CALLER));
    expect(withdrawNote(1, attacker).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED_CALLER));
  });

  it("the registry owner cannot spend user notes", () => {
    wire();
    registerNote(1);
    expect(spendNote(1, deployer).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED_CALLER));
  });

  it("freeze/reactivate require registry owner or emergency admin", () => {
    wire();
    grantRole(emergencyAdmin, ROLE.EMERGENCY);
    registerNote(1);
    expect(freezeNote(1, attacker).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(freezeNote(1, pool).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(freezeNote(1, emergencyAdmin).result).toBeOk(Cl.bool(true));
    expect(reactivateNote(1, attacker).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(reactivateNote(1, emergencyAdmin).result).toBeOk(Cl.bool(true));
  });

  it("protocol and verifier admins cannot freeze notes (role separation)", () => {
    wire();
    grantRole(protocolAdmin, ROLE.PROTOCOL);
    grantRole(verifierAdmin, ROLE.VERIFIER);
    registerNote(1);
    expect(freezeNote(1, protocolAdmin).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(freezeNote(1, verifierAdmin).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
  });

  it("deprecate-note is registry-owner only -- even emergency admins fail", () => {
    wire();
    grantRole(emergencyAdmin, ROLE.EMERGENCY);
    registerNote(1);
    freezeNote(1, emergencyAdmin);
    expect(deprecateNote(1, emergencyAdmin).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(deprecateNote(1, attacker).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(deprecateNote(1, deployer).result).toBeOk(Cl.bool(true));
  });

  it("authorization is checked before any note lookup for admin ops", () => {
    // unknown note + unauthorized caller: must fail on authorization
    expect(freezeNote(99, attacker).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(deprecateNote(99, attacker).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
  });
});

// ===========================================================================
// SECURITY -- replay, duplicates, malformed inputs
// ===========================================================================

describe("security: replay and duplicates", () => {
  it("duplicate note registration is rejected (registration replay)", () => {
    wire();
    registerNote(1);
    expect(registerNote(1).result).toBeErr(Cl.uint(ERR.DUPLICATE_NOTE));
    expectStats({ registered: 1, active: 1 });
    expect(regRead("get-total-notes")).toBeUint(1);
  });

  it("a duplicate with different owner/metadata is still rejected", () => {
    wire();
    registerNote(1);
    expect(
      call(
        "register-note",
        [hash32(1), hash32(777), hash32(778), Cl.uint(1)],
        pool
      ).result
    ).toBeErr(Cl.uint(ERR.DUPLICATE_NOTE));
    // original record untouched
    expect(read("get-note-owner-commitment", [hash32(1)])).toBeSome(hash32(9_000_001));
  });

  it("spend replay is rejected deterministically, even many blocks later", () => {
    wire();
    registerNote(1);
    spendNote(1);
    simnet.mineEmptyBlocks(10);
    expect(spendNote(1).result).toBeErr(Cl.uint(ERR.INVALID_NOTE_STATE));
    expectStats({ registered: 1, spent: 1 });
  });

  it("withdraw-after-spend and spend-after-withdraw both fail", () => {
    wire();
    registerNote(1);
    registerNote(2);
    spendNote(1);
    withdrawNote(2);
    expect(withdrawNote(1).result).toBeErr(Cl.uint(ERR.INVALID_NOTE_STATE));
    expect(spendNote(2).result).toBeErr(Cl.uint(ERR.INVALID_NOTE_STATE));
  });

  it("zero note id is rejected everywhere", () => {
    wire();
    expect(
      call("register-note", [ZERO_HASH, hash32(1), hash32(2), Cl.uint(1)], pool).result
    ).toBeErr(Cl.uint(ERR.INVALID_NOTE_ID));
    expect(call("spend-note", [ZERO_HASH], pool).result).toBeErr(
      Cl.uint(ERR.INVALID_NOTE_ID)
    );
    expect(call("withdraw-note", [ZERO_HASH], pool).result).toBeErr(
      Cl.uint(ERR.INVALID_NOTE_ID)
    );
    expect(call("freeze-note", [ZERO_HASH], deployer).result).toBeErr(
      Cl.uint(ERR.INVALID_NOTE_ID)
    );
    expect(call("reactivate-note", [ZERO_HASH], deployer).result).toBeErr(
      Cl.uint(ERR.INVALID_NOTE_ID)
    );
    expect(call("deprecate-note", [ZERO_HASH], deployer).result).toBeErr(
      Cl.uint(ERR.INVALID_NOTE_ID)
    );
  });

  it("zero owner commitment is rejected", () => {
    wire();
    expect(
      call("register-note", [hash32(1), ZERO_HASH, hash32(2), Cl.uint(1)], pool).result
    ).toBeErr(Cl.uint(ERR.INVALID_OWNER_COMMITMENT));
  });

  it("wrong note version is rejected", () => {
    wire();
    expect(registerNote(1, pool, 2).result).toBeErr(Cl.uint(ERR.VERSION_MISMATCH));
    expect(registerNote(1, pool, 0).result).toBeErr(Cl.uint(ERR.VERSION_MISMATCH));
  });
});

// ===========================================================================
// SECURITY -- privilege escalation attempts
// ===========================================================================

describe("security: privilege escalation", () => {
  it("a revoked emergency admin immediately loses note authority", () => {
    wire();
    grantRole(emergencyAdmin, ROLE.EMERGENCY);
    registerNote(1);
    freezeNote(1, emergencyAdmin);
    regCall("revoke-role", [Cl.principal(emergencyAdmin), Cl.uint(ROLE.EMERGENCY)], deployer);
    expect(reactivateNote(1, emergencyAdmin).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
  });

  it("a deauthorized pool immediately loses note write access", () => {
    wire();
    registerNote(1);
    regCall("remove-authorized-caller", [Cl.principal(pool)], deployer);
    expect(registerNote(2).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED_CALLER));
    expect(spendNote(1).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED_CALLER));
  });

  it("registry ownership transfer moves note-admin authority atomically", () => {
    wire();
    registerNote(1);
    regCall("transfer-ownership", [Cl.principal(successor)], deployer);
    // pending: old owner still rules
    expect(freezeNote(1, successor).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    regCall("accept-ownership", [], successor);
    // accepted: authority has moved
    expect(freezeNote(1, deployer).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(freezeNote(1, successor).result).toBeOk(Cl.bool(true));
    expect(deprecateNote(1, successor).result).toBeOk(Cl.bool(true));
  });

  it("being an authorized caller grants no admin authority, and vice versa", () => {
    wire();
    grantRole(emergencyAdmin, ROLE.EMERGENCY);
    registerNote(1);
    // pool: protocol caller but not admin
    expect(freezeNote(1, pool).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    // emergency admin: admin but not protocol caller
    expect(registerNote(2, emergencyAdmin).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED_CALLER)
    );
    expect(spendNote(1, emergencyAdmin).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED_CALLER)
    );
  });
});

// ===========================================================================
// INTEGRATION -- registry protocol state gating
// ===========================================================================

describe("integration: registry protocol state", () => {
  it("registration and consumption fail while the registry is paused", () => {
    wire();
    registerNote(1);
    regCall("pause-protocol", [], deployer);
    expect(registerNote(2).result).toBeErr(Cl.uint(REG_ERR.PROTOCOL_PAUSED));
    expect(spendNote(1).result).toBeErr(Cl.uint(REG_ERR.PROTOCOL_PAUSED));
    expect(withdrawNote(1).result).toBeErr(Cl.uint(REG_ERR.PROTOCOL_PAUSED));
  });

  it("each registry state maps to its precise pass-through error", () => {
    wire();
    grantRole(emergencyAdmin, ROLE.EMERGENCY);
    regCall("pause-protocol", [], deployer);
    regCall("begin-upgrade", [], deployer);
    expect(registerNote(1).result).toBeErr(Cl.uint(REG_ERR.PROTOCOL_UPGRADING));
    regCall("emergency-pause-protocol", [], emergencyAdmin);
    expect(registerNote(1).result).toBeErr(Cl.uint(REG_ERR.PROTOCOL_EMERGENCY));
    regCall("resolve-emergency", [], deployer);
    regCall("deprecate-protocol", [], deployer);
    expect(registerNote(1).result).toBeErr(Cl.uint(REG_ERR.PROTOCOL_DEPRECATED));
  });

  it("note operations resume after unpause", () => {
    wire();
    registerNote(1);
    regCall("pause-protocol", [], deployer);
    expect(spendNote(1).result).toBeErr(Cl.uint(REG_ERR.PROTOCOL_PAUSED));
    regCall("unpause-protocol", [], deployer);
    expect(spendNote(1).result).toBeOk(Cl.bool(true));
    expect(registerNote(2).result).toBeOk(Cl.bool(true));
  });

  it("freeze and reactivate work while the registry is paused", () => {
    wire();
    registerNote(1);
    regCall("pause-protocol", [], deployer);
    expect(freezeNote(1).result).toBeOk(Cl.bool(true));
    expect(reactivateNote(1).result).toBeOk(Cl.bool(true));
  });

  it("freeze works during a registry EMERGENCY (the incident-response case)", () => {
    wire();
    grantRole(emergencyAdmin, ROLE.EMERGENCY);
    registerNote(1);
    regCall("emergency-pause-protocol", [], emergencyAdmin);
    expect(freezeNote(1, emergencyAdmin).result).toBeOk(Cl.bool(true));
  });

  it("deprecate-note works even after the protocol itself is deprecated", () => {
    wire();
    registerNote(1);
    freezeNote(1);
    regCall("pause-protocol", [], deployer);
    regCall("deprecate-protocol", [], deployer);
    expect(deprecateNote(1).result).toBeOk(Cl.bool(true));
    // but no new notes can ever be registered
    expect(registerNote(2).result).toBeErr(Cl.uint(REG_ERR.PROTOCOL_DEPRECATED));
  });
});

// ===========================================================================
// INTEGRATION -- capacity, versions, and misconfiguration
// ===========================================================================

describe("integration: capacity and versions", () => {
  it("the registry's max-notes capacity bounds registration", () => {
    wire();
    regCall("update-protocol-limits", [limitsCV({ "max-notes": 2 })], deployer);
    expect(registerNote(1).result).toBeOk(Cl.bool(true));
    expect(registerNote(2).result).toBeOk(Cl.bool(true));
    expect(registerNote(3).result).toBeErr(Cl.uint(REG_ERR.NOTE_LIMIT_EXCEEDED));
    expectStats({ registered: 2, active: 2 });
  });

  it("the note cap is cumulative: spending notes frees no capacity", () => {
    wire();
    regCall("update-protocol-limits", [limitsCV({ "max-notes": 2 })], deployer);
    registerNote(1);
    registerNote(2);
    spendNote(1);
    withdrawNote(2);
    expect(registerNote(3).result).toBeErr(Cl.uint(REG_ERR.NOTE_LIMIT_EXCEEDED));
  });

  it("a failed registration leaves both contracts' counters untouched", () => {
    wire();
    regCall("update-protocol-limits", [limitsCV({ "max-notes": 1 })], deployer);
    registerNote(1);
    expect(registerNote(2).result).toBeErr(Cl.uint(REG_ERR.NOTE_LIMIT_EXCEEDED));
    expectStats({ registered: 1, active: 1 });
    expect(regRead("get-total-notes")).toBeUint(1);
    expect(read("note-exists", [hash32(2)])).toBeBool(false);
  });

  it("a registry note-version upgrade is enforced immediately", () => {
    wire();
    registerNote(1); // v1 note
    regCall("pause-protocol", [], deployer);
    regCall("begin-upgrade", [], deployer);
    regCall("update-versions", [versionsCV({ note: 2 })], deployer);
    regCall("complete-upgrade", [], deployer);

    expect(read("get-current-note-version")).toBeUint(2);
    expect(registerNote(2, pool, 1).result).toBeErr(Cl.uint(ERR.VERSION_MISMATCH));
    expect(registerNote(2, pool, 2).result).toBeOk(Cl.bool(true));

    // versions are recorded per note; old notes keep theirs and stay spendable
    expect(read("get-note-version", [hash32(1)])).toBeSome(Cl.uint(1));
    expect(read("get-note-version", [hash32(2)])).toBeSome(Cl.uint(2));
    expect(spendNote(1).result).toBeOk(Cl.bool(true));
    expect(spendNote(2).result).toBeOk(Cl.bool(true));
  });

  it("surfaces the misconfiguration loudly when note-manager itself is not authorized", () => {
    // pool authorized, but the note-manager CONTRACT is not: the registry
    // rejects record-note-created with its own unauthorized-caller error
    regCall("add-authorized-caller", [Cl.principal(pool)], deployer);
    expect(registerNote(1).result).toBeErr(Cl.uint(REG_ERR.UNAUTHORIZED_CALLER));
    // nothing was written anywhere
    expect(read("note-exists", [hash32(1)])).toBeBool(false);
    expectStats({});
  });
});

// ===========================================================================
// EDGE CASES
// ===========================================================================

describe("edge cases", () => {
  it("accepts the maximal 0xff...ff note id", () => {
    wire();
    const maxHash = Cl.buffer(new Uint8Array(32).fill(0xff));
    expect(
      call("register-note", [maxHash, hash32(1), hash32(2), Cl.uint(1)], pool).result
    ).toBeOk(Cl.bool(true));
    expect(read("is-note-active", [maxHash])).toBeBool(true);
  });

  it("note id may equal its owner commitment (opaque, independent domains)", () => {
    wire();
    expect(
      call("register-note", [hash32(5), hash32(5), hash32(5), Cl.uint(1)], pool).result
    ).toBeOk(Cl.bool(true));
  });

  it("metadata may be the zero hash (opaque, optional semantics)", () => {
    wire();
    expect(
      call("register-note", [hash32(5), hash32(6), ZERO_HASH, Cl.uint(1)], pool).result
    ).toBeOk(Cl.bool(true));
    expect(read("get-note-metadata", [hash32(5)])).toBeSome(ZERO_HASH);
  });

  it("freeze -> reactivate -> spend: full recovery path", () => {
    wire();
    registerNote(1);
    freezeNote(1);
    reactivateNote(1);
    expect(spendNote(1).result).toBeOk(Cl.bool(true));
    expectStats({ registered: 1, spent: 1 });
  });

  it("repeated freeze/reactivate cycles stay consistent", () => {
    wire();
    registerNote(1);
    for (let i = 0; i < 5; i++) {
      expect(freezeNote(1).result).toBeOk(Cl.bool(true));
      expect(reactivateNote(1).result).toBeOk(Cl.bool(true));
    }
    expectStats({ registered: 1, active: 1 });
    expect(read("is-statistics-consistent")).toBeBool(true);
  });

  it("a frozen note survives a registry pause/unpause cycle frozen", () => {
    wire();
    registerNote(1);
    freezeNote(1);
    regCall("pause-protocol", [], deployer);
    regCall("unpause-protocol", [], deployer);
    expect(read("is-note-frozen", [hash32(1)])).toBeBool(true);
    expect(spendNote(1).result).toBeErr(Cl.uint(ERR.NOTE_FROZEN));
  });

  it("draining every note out of ACTIVE keeps counters exact", () => {
    wire();
    for (let i = 1; i <= 6; i++) registerNote(i);
    spendNote(1);
    spendNote(2);
    withdrawNote(3);
    withdrawNote(4);
    freezeNote(5);
    deprecateNote(5);
    freezeNote(6);
    expectStats({
      registered: 6,
      active: 0,
      spent: 2,
      withdrawn: 2,
      frozen: 1,
      deprecated: 1,
    });
    expect(read("is-statistics-consistent")).toBeBool(true);
  });

  it("historical reads remain available for terminal notes forever", () => {
    wire();
    registerNote(1);
    const registeredAt = simnet.blockHeight;
    spendNote(1);
    const updatedAt = simnet.blockHeight;
    regCall("pause-protocol", [], deployer);
    regCall("deprecate-protocol", [], deployer);
    // protocol is gone; history is not
    expect(read("get-note", [hash32(1)])).toBeSome(
      Cl.tuple({
        state: Cl.uint(NOTE_STATE.SPENT),
        "owner-commitment": hash32(9_000_001),
        version: Cl.uint(1),
        metadata: hash32(8_000_001),
        "registered-at": Cl.uint(registeredAt),
        "updated-at": Cl.uint(updatedAt),
      })
    );
  });
});

// ===========================================================================
// PROPERTY / RANDOMIZED
// ===========================================================================

describe("property: randomized operations", () => {
  // deterministic MINSTD generator: reproducible pseudo-random 31-bit values
  const minstd = (seedInit: number) => {
    let seed = seedInit % 2147483647;
    return () => (seed = (seed * 48271) % 2147483647);
  };

  it("30 random notes register uniquely with consistent counters", () => {
    wire();
    const next = minstd(0xbeef);
    const ids: number[] = [];
    const seen = new Set<number>();
    while (ids.length < 30) {
      const v = next();
      if (!seen.has(v)) {
        seen.add(v);
        ids.push(v);
      }
    }
    for (const id of ids) {
      expect(registerNote(id).result).toBeOk(Cl.bool(true));
    }
    expectStats({ registered: 30, active: 30 });
    for (const id of ids) {
      expect(read("is-note-active", [hash32(id)])).toBeBool(true);
    }
  });

  it("randomized replays never disturb state or counters", () => {
    wire();
    const next = minstd(0xfeed);
    const ids = Array.from({ length: 12 }, () => next());
    ids.forEach((id) => registerNote(id));
    // replay every registration
    for (const id of ids) {
      expect(registerNote(id).result).toBeErr(Cl.uint(ERR.DUPLICATE_NOTE));
    }
    expectStats({ registered: 12, active: 12 });
    expect(read("is-statistics-consistent")).toBeBool(true);
  });

  it("random lifecycle walks always end in a legal state with exact counters", () => {
    wire();
    const next = minstd(0xdead);
    const ids = Array.from({ length: 20 }, () => next());
    ids.forEach((id) => registerNote(id));

    const tally = { active: 0, spent: 0, withdrawn: 0, frozen: 0, deprecated: 0 };
    for (const id of ids) {
      switch (next() % 5) {
        case 0:
          expect(spendNote(id).result).toBeOk(Cl.bool(true));
          tally.spent++;
          break;
        case 1:
          expect(withdrawNote(id).result).toBeOk(Cl.bool(true));
          tally.withdrawn++;
          break;
        case 2:
          expect(freezeNote(id).result).toBeOk(Cl.bool(true));
          tally.frozen++;
          break;
        case 3:
          expect(freezeNote(id).result).toBeOk(Cl.bool(true));
          expect(reactivateNote(id).result).toBeOk(Cl.bool(true));
          expect(spendNote(id).result).toBeOk(Cl.bool(true));
          tally.spent++;
          break;
        default:
          expect(freezeNote(id).result).toBeOk(Cl.bool(true));
          expect(deprecateNote(id).result).toBeOk(Cl.bool(true));
          tally.deprecated++;
      }
    }
    expectStats({ registered: 20, ...tally });
    expect(read("is-statistics-consistent")).toBeBool(true);
  });

  it("randomized invalid operations on terminal notes all fail", () => {
    wire();
    const next = minstd(0xcafe);
    const ids = Array.from({ length: 8 }, () => next());
    ids.forEach((id) => registerNote(id));
    ids.forEach((id, i) => (i % 2 === 0 ? spendNote(id) : withdrawNote(id)));

    for (const id of ids) {
      expect(spendNote(id).result).toBeErr(Cl.uint(ERR.INVALID_NOTE_STATE));
      expect(withdrawNote(id).result).toBeErr(Cl.uint(ERR.INVALID_NOTE_STATE));
      expect(freezeNote(id).result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
    }
    expectStats({ registered: 8, spent: 4, withdrawn: 4 });
  });
});

// ===========================================================================
// INVARIANTS
// ===========================================================================

describe("invariants", () => {
  it("statistics stay consistent after every single operation", () => {
    wire();
    const ops: Array<() => void> = [
      () => void registerNote(1),
      () => void registerNote(2),
      () => void registerNote(3),
      () => void spendNote(1),
      () => void freezeNote(2),
      () => void reactivateNote(2),
      () => void withdrawNote(2),
      () => void freezeNote(3),
      () => void deprecateNote(3),
    ];
    for (const op of ops) {
      op();
      expect(read("is-statistics-consistent")).toBeBool(true);
    }
    expectStats({ registered: 3, spent: 1, withdrawn: 1, deprecated: 1 });
  });

  it("failed operations never change statistics", () => {
    wire();
    registerNote(1);
    spendNote(1);
    const before = read("get-note-statistics");
    registerNote(1); // duplicate
    spendNote(1); // terminal
    freezeNote(1); // invalid transition
    spendNote(99); // not found
    expect(read("get-note-statistics")).toStrictEqual(before);
  });

  it("registry total-notes and local total-registered advance in lockstep", () => {
    wire();
    for (let i = 1; i <= 5; i++) {
      registerNote(i);
      expect(regRead("get-total-notes")).toBeUint(i);
      expect(read("get-note-statistics")).toBeTuple({
        "total-registered": Cl.uint(i),
        "total-active": Cl.uint(i),
        "total-spent": Cl.uint(0),
        "total-withdrawn": Cl.uint(0),
        "total-frozen": Cl.uint(0),
        "total-deprecated": Cl.uint(0),
      });
    }
  });
});

// ===========================================================================
// MAINNET SCENARIOS
// ===========================================================================

describe("mainnet scenarios", () => {
  it("full protocol flow: shield -> transfer -> withdraw across both contracts", () => {
    wire();

    // -- shield: pool registers commitment + note + accounting + root
    expect(
      regCall("register-commitment", [hash32(1), Cl.uint(1)], pool).result
    ).toBeOk(Cl.uint(0));
    expect(registerNote(1).result).toBeOk(Cl.bool(true));
    expect(regCall("record-shield", [Cl.uint(100 * ONE_STX)], pool).result).toBeOk(
      Cl.bool(true)
    );
    expect(regCall("update-root", [hash32(500_001), Cl.uint(1)], pool).result).toBeOk(
      Cl.bool(true)
    );

    // -- private transfer: nullifier + spend old note, create new note
    expect(regCall("register-nullifier", [hash32(600_001)], pool).result).toBeOk(
      Cl.bool(true)
    );
    expect(spendNote(1).result).toBeOk(Cl.bool(true));
    expect(
      regCall("register-commitment", [hash32(2), Cl.uint(1)], pool).result
    ).toBeOk(Cl.uint(1));
    expect(registerNote(2).result).toBeOk(Cl.bool(true));
    expect(regCall("update-root", [hash32(500_002), Cl.uint(1)], pool).result).toBeOk(
      Cl.bool(true)
    );
    expect(regCall("record-transfer", [], pool).result).toBeOk(Cl.bool(true));

    // -- withdrawal: nullifier + withdraw the new note
    expect(regCall("register-nullifier", [hash32(600_002)], pool).result).toBeOk(
      Cl.bool(true)
    );
    expect(withdrawNote(2).result).toBeOk(Cl.bool(true));
    expect(
      regCall("record-withdrawal", [Cl.uint(40 * ONE_STX)], pool).result
    ).toBeOk(Cl.bool(true));

    // -- cross-contract consistency
    expectStats({ registered: 2, spent: 1, withdrawn: 1 });
    expect(regRead("get-total-notes")).toBeUint(2);
    expect(regRead("get-total-commitments")).toBeUint(2);
    expect(regRead("get-total-nullifiers")).toBeUint(2);
    expect(regRead("get-total-shielded-stx")).toBeUint(60 * ONE_STX);
    expect(read("is-statistics-consistent")).toBeBool(true);
  });

  it("incident-response drill: freeze during emergency, recover, resume", () => {
    wire();
    grantRole(emergencyAdmin, ROLE.EMERGENCY);
    registerNote(1);
    registerNote(2);

    // incident detected: emergency pause + freeze the suspicious note
    regCall("emergency-pause-protocol", [], emergencyAdmin);
    expect(freezeNote(1, emergencyAdmin).result).toBeOk(Cl.bool(true));
    // nothing moves during the emergency
    expect(spendNote(2).result).toBeErr(Cl.uint(REG_ERR.PROTOCOL_EMERGENCY));

    // resolution: owner recovers, unpauses, releases the hold
    regCall("resolve-emergency", [], deployer);
    regCall("unpause-protocol", [], deployer);
    expect(reactivateNote(1, emergencyAdmin).result).toBeOk(Cl.bool(true));

    // normal operation resumes for everything
    expect(spendNote(1).result).toBeOk(Cl.bool(true));
    expect(spendNote(2).result).toBeOk(Cl.bool(true));
  });

  it("upgrade drill: v1 and v2 notes coexist and both remain spendable", () => {
    wire();
    registerNote(1);
    registerNote(2);
    regCall("pause-protocol", [], deployer);
    regCall("begin-upgrade", [], deployer);
    regCall("update-versions", [versionsCV({ protocol: 2, note: 2 })], deployer);
    regCall("complete-upgrade", [], deployer);

    expect(registerNote(3, pool, 2).result).toBeOk(Cl.bool(true));
    expect(spendNote(1).result).toBeOk(Cl.bool(true)); // v1 note
    expect(spendNote(3).result).toBeOk(Cl.bool(true)); // v2 note
    expect(read("get-note-version", [hash32(2)])).toBeSome(Cl.uint(1));
    expectStats({ registered: 3, active: 1, spent: 2 });
  });

  it("sunset drill: notes retired, protocol deprecated, history immortal", () => {
    wire();
    registerNote(1);
    registerNote(2);
    spendNote(1);
    freezeNote(2);
    deprecateNote(2);

    regCall("pause-protocol", [], deployer);
    regCall("deprecate-protocol", [], deployer);

    // every write path is dead
    expect(registerNote(3).result).toBeErr(Cl.uint(REG_ERR.PROTOCOL_DEPRECATED));
    // every read path lives forever
    expect(read("is-note-spent", [hash32(1)])).toBeBool(true);
    expect(read("is-note-deprecated", [hash32(2)])).toBeBool(true);
    expectStats({ registered: 2, spent: 1, deprecated: 1 });
    expect(read("is-statistics-consistent")).toBeBool(true);
  });
});
