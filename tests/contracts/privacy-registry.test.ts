import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";

/*
  Unit tests for privacy-registry.clar -- the STX Shield source of truth.

  The simnet is reset between tests by vitest-environment-clarinet, so every
  test builds its own state through the helpers below.

  wallet_5 stands in for the privacy-pool contract (an authorized protocol
  caller); wallet_6 is an unprivileged attacker.
*/

const CONTRACT = "privacy-registry";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const protocolAdmin = accounts.get("wallet_1")!;
const emergencyAdmin = accounts.get("wallet_2")!;
const verifierAdmin = accounts.get("wallet_3")!;
const feeAdmin = accounts.get("wallet_4")!;
const pool = accounts.get("wallet_5")!;
const attacker = accounts.get("wallet_6")!;
const successor = accounts.get("wallet_7")!;

// ---------------------------------------------------------------------------
// Contract constants mirrored for assertions
// ---------------------------------------------------------------------------

const STATE = { ACTIVE: 1, PAUSED: 2, EMERGENCY: 3, UPGRADING: 4, DEPRECATED: 5 };
const ROLE = { PROTOCOL: 1, EMERGENCY: 2, VERIFIER: 3, FEE: 4 };

const ERR = {
  UNAUTHORIZED: 100,
  UNAUTHORIZED_CALLER: 101,
  PROTOCOL_PAUSED: 102,
  PROTOCOL_EMERGENCY: 103,
  PROTOCOL_UPGRADING: 104,
  PROTOCOL_DEPRECATED: 105,
  INVALID_PROTOCOL_STATE: 106,
  INVALID_STATE_TRANSITION: 107,
  INVALID_COMMITMENT: 110,
  DUPLICATE_COMMITMENT: 111,
  COMMITMENT_LIMIT_EXCEEDED: 112,
  INVALID_NULLIFIER: 115,
  DUPLICATE_NULLIFIER: 116,
  NULLIFIER_INVARIANT_VIOLATION: 117,
  INVALID_ROOT: 120,
  DUPLICATE_ROOT: 121,
  ROOT_NOT_FOUND: 122,
  INVALID_VERSION: 125,
  VERSION_MISMATCH: 126,
  INVALID_LIMITS: 130,
  AMOUNT_BELOW_MINIMUM: 131,
  AMOUNT_ABOVE_MAXIMUM: 132,
  NOTE_LIMIT_EXCEEDED: 133,
  INSUFFICIENT_SHIELDED_BALANCE: 134,
  SHIELDED_SUPPLY_OVERFLOW: 135,
  INVALID_ADMINISTRATOR: 140,
  INVALID_ROLE: 141,
  ROLE_ALREADY_GRANTED: 142,
  ROLE_NOT_GRANTED: 143,
  CALLER_ALREADY_AUTHORIZED: 144,
  CALLER_NOT_AUTHORIZED: 145,
  INVALID_OWNER: 146,
  NO_PENDING_OWNER: 147,
  NOT_PENDING_OWNER: 148,
};

const ONE_STX = 1_000_000;
/** Maximum STX that will ever exist, in micro-STX (1,818,000,000 STX). */
const STX_SUPPLY_CEILING = 1_818_000_000_000_000;
const DEFAULT_LIMITS = {
  "min-shield": ONE_STX,
  "max-shield": 1_000_000_000_000,
  "min-withdrawal": ONE_STX,
  "max-withdrawal": 1_000_000_000_000,
  "max-commitments": 1_048_576,
  "max-notes": 1_048_576,
  "max-fee-bps": 100,
};
const DEFAULT_VERSIONS = {
  protocol: 1,
  verifier: 1,
  note: 1,
  circuit: 1,
  commitment: 1,
  root: 1,
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
  b[0] = 0x1a; // never the zero hash, even for n = 0
  return Cl.buffer(b);
};
const ZERO_HASH = Cl.buffer(new Uint8Array(32));

const call = (fn: string, args: unknown[], sender: string) =>
  simnet.callPublicFn(CONTRACT, fn, args as any, sender);
const read = (fn: string, args: unknown[] = []) =>
  simnet.callReadOnlyFn(CONTRACT, fn, args as any, deployer).result;

const uintTuple = (obj: Record<string, number>) =>
  Cl.tuple(Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Cl.uint(v)])));

const limitsCV = (overrides: Partial<typeof DEFAULT_LIMITS> = {}) =>
  uintTuple({ ...DEFAULT_LIMITS, ...overrides });
const versionsCV = (overrides: Partial<typeof DEFAULT_VERSIONS> = {}) =>
  uintTuple({ ...DEFAULT_VERSIONS, ...overrides });

const grantRole = (account: string, role: number) =>
  call("grant-role", [Cl.principal(account), Cl.uint(role)], deployer);
const authorize = (account: string) =>
  call("add-authorized-caller", [Cl.principal(account)], deployer);
const registerCommitment = (n: number, sender = pool, version = 1) =>
  call("register-commitment", [hash32(n), Cl.uint(version)], sender);
const registerNullifier = (n: number, sender = pool) =>
  call("register-nullifier", [hash32(1000 + n)], sender);
const updateRoot = (n: number, sender = pool, version = 1) =>
  call("update-root", [hash32(2000 + n), Cl.uint(version)], sender);

const pause = () => call("pause-protocol", [], deployer);
const unpause = () => call("unpause-protocol", [], deployer);
const beginUpgrade = () => {
  pause();
  return call("begin-upgrade", [], deployer);
};

// ===========================================================================
// Deployment & initial state
// ===========================================================================

describe("deployment & initial state", () => {
  it("sets the deployer as owner with no pending owner", () => {
    expect(read("get-owner")).toBePrincipal(deployer);
    expect(read("get-pending-owner")).toBeNone();
  });

  it("starts ACTIVE", () => {
    expect(read("get-protocol-state")).toBeUint(STATE.ACTIVE);
    expect(read("is-protocol-active")).toBeBool(true);
    expect(read("check-protocol-active")).toBeOk(Cl.bool(true));
  });

  it("initializes all component versions to 1", () => {
    expect(read("get-versions")).toBeTuple({
      protocol: Cl.uint(1),
      verifier: Cl.uint(1),
      note: Cl.uint(1),
      circuit: Cl.uint(1),
      commitment: Cl.uint(1),
      root: Cl.uint(1),
    });
    expect(read("get-protocol-version")).toBeUint(1);
    expect(read("get-verifier-version")).toBeUint(1);
    expect(read("get-note-version")).toBeUint(1);
    expect(read("get-circuit-version")).toBeUint(1);
    expect(read("get-commitment-version")).toBeUint(1);
    expect(read("get-root-version")).toBeUint(1);
  });

  it("initializes default protocol limits", () => {
    expect(read("get-protocol-limits")).toBeTuple({
      "min-shield": Cl.uint(ONE_STX),
      "max-shield": Cl.uint(1_000_000_000_000),
      "min-withdrawal": Cl.uint(ONE_STX),
      "max-withdrawal": Cl.uint(1_000_000_000_000),
      "max-commitments": Cl.uint(1_048_576),
      "max-notes": Cl.uint(1_048_576),
      "max-fee-bps": Cl.uint(100),
    });
    expect(read("get-min-shield-amount")).toBeUint(ONE_STX);
    expect(read("get-max-shield-amount")).toBeUint(1_000_000_000_000);
    expect(read("get-min-withdrawal-amount")).toBeUint(ONE_STX);
    expect(read("get-max-withdrawal-amount")).toBeUint(1_000_000_000_000);
    expect(read("get-max-commitments")).toBeUint(1_048_576);
    expect(read("get-max-notes")).toBeUint(1_048_576);
    expect(read("get-max-fee-bps")).toBeUint(100);
  });

  it("initializes all statistics to zero", () => {
    expect(read("get-statistics")).toBeTuple({
      "total-commitments": Cl.uint(0),
      "total-nullifiers": Cl.uint(0),
      "total-notes": Cl.uint(0),
      "total-transfers": Cl.uint(0),
      "total-withdrawals": Cl.uint(0),
      "total-shielded-stx": Cl.uint(0),
    });
  });

  it("starts with the zero root (tree not bootstrapped) which is never known", () => {
    expect(read("get-current-root")).toBeTuple({
      root: ZERO_HASH,
      version: Cl.uint(1),
      "updated-at": Cl.uint(0),
    });
    expect(read("is-known-root", [ZERO_HASH])).toBeBool(false);
    expect(read("validate-root", [ZERO_HASH])).toBeErr(Cl.uint(ERR.ROOT_NOT_FOUND));
  });
});

// ===========================================================================
// Access control: roles
// ===========================================================================

describe("access control: roles", () => {
  it("owner can grant and revoke roles", () => {
    expect(grantRole(protocolAdmin, ROLE.PROTOCOL).result).toBeOk(Cl.bool(true));
    expect(
      read("has-role", [Cl.principal(protocolAdmin), Cl.uint(ROLE.PROTOCOL)])
    ).toBeBool(true);

    expect(
      call("revoke-role", [Cl.principal(protocolAdmin), Cl.uint(ROLE.PROTOCOL)], deployer)
        .result
    ).toBeOk(Cl.bool(true));
    expect(
      read("has-role", [Cl.principal(protocolAdmin), Cl.uint(ROLE.PROTOCOL)])
    ).toBeBool(false);
  });

  it("non-owner cannot grant roles", () => {
    expect(
      call("grant-role", [Cl.principal(attacker), Cl.uint(ROLE.PROTOCOL)], attacker).result
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
  });

  it("an administrator cannot grant roles either", () => {
    grantRole(protocolAdmin, ROLE.PROTOCOL);
    expect(
      call("grant-role", [Cl.principal(attacker), Cl.uint(ROLE.PROTOCOL)], protocolAdmin)
        .result
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
  });

  it("rejects duplicate role grants", () => {
    grantRole(protocolAdmin, ROLE.PROTOCOL);
    expect(grantRole(protocolAdmin, ROLE.PROTOCOL).result).toBeErr(
      Cl.uint(ERR.ROLE_ALREADY_GRANTED)
    );
  });

  it("rejects unknown role ids", () => {
    expect(grantRole(protocolAdmin, 9).result).toBeErr(Cl.uint(ERR.INVALID_ROLE));
    expect(grantRole(protocolAdmin, 0).result).toBeErr(Cl.uint(ERR.INVALID_ROLE));
  });

  it("rejects granting a role to the owner", () => {
    expect(grantRole(deployer, ROLE.PROTOCOL).result).toBeErr(
      Cl.uint(ERR.INVALID_ADMINISTRATOR)
    );
  });

  it("rejects revoking a role that was never granted", () => {
    expect(
      call("revoke-role", [Cl.principal(attacker), Cl.uint(ROLE.FEE)], deployer).result
    ).toBeErr(Cl.uint(ERR.ROLE_NOT_GRANTED));
  });

  it("roles are independent per role id", () => {
    grantRole(protocolAdmin, ROLE.PROTOCOL);
    expect(
      read("has-role", [Cl.principal(protocolAdmin), Cl.uint(ROLE.EMERGENCY)])
    ).toBeBool(false);
  });
});

// ===========================================================================
// Access control: authorized callers
// ===========================================================================

describe("access control: authorized callers", () => {
  it("owner can add and remove authorized callers", () => {
    expect(authorize(pool).result).toBeOk(Cl.bool(true));
    expect(read("is-authorized-caller", [Cl.principal(pool)])).toBeBool(true);

    expect(
      call("remove-authorized-caller", [Cl.principal(pool)], deployer).result
    ).toBeOk(Cl.bool(true));
    expect(read("is-authorized-caller", [Cl.principal(pool)])).toBeBool(false);
  });

  it("non-owner cannot manage authorized callers", () => {
    expect(
      call("add-authorized-caller", [Cl.principal(attacker)], attacker).result
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(
      call("remove-authorized-caller", [Cl.principal(pool)], attacker).result
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
  });

  it("rejects double authorization and removing a non-authorized caller", () => {
    authorize(pool);
    expect(authorize(pool).result).toBeErr(Cl.uint(ERR.CALLER_ALREADY_AUTHORIZED));
    expect(
      call("remove-authorized-caller", [Cl.principal(attacker)], deployer).result
    ).toBeErr(Cl.uint(ERR.CALLER_NOT_AUTHORIZED));
  });
});

// ===========================================================================
// Access control: two-step ownership transfer
// ===========================================================================

describe("access control: ownership transfer", () => {
  it("completes a two-step transfer and moves all authority", () => {
    expect(
      call("transfer-ownership", [Cl.principal(successor)], deployer).result
    ).toBeOk(Cl.bool(true));
    expect(read("get-pending-owner")).toBeSome(Cl.principal(successor));
    // authority has NOT moved yet
    expect(read("get-owner")).toBePrincipal(deployer);

    expect(call("accept-ownership", [], successor).result).toBeOk(Cl.bool(true));
    expect(read("get-owner")).toBePrincipal(successor);
    expect(read("get-pending-owner")).toBeNone();

    // old owner has lost administrative authority, new owner has it
    expect(grantRole(protocolAdmin, ROLE.PROTOCOL).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED)
    );
    expect(
      call("grant-role", [Cl.principal(protocolAdmin), Cl.uint(ROLE.PROTOCOL)], successor)
        .result
    ).toBeOk(Cl.bool(true));
  });

  it("only the pending owner can accept", () => {
    call("transfer-ownership", [Cl.principal(successor)], deployer);
    expect(call("accept-ownership", [], attacker).result).toBeErr(
      Cl.uint(ERR.NOT_PENDING_OWNER)
    );
  });

  it("accept fails when no transfer is pending", () => {
    expect(call("accept-ownership", [], attacker).result).toBeErr(
      Cl.uint(ERR.NO_PENDING_OWNER)
    );
  });

  it("non-owner cannot initiate a transfer", () => {
    expect(
      call("transfer-ownership", [Cl.principal(attacker)], attacker).result
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
  });

  it("rejects transferring to the current owner", () => {
    expect(
      call("transfer-ownership", [Cl.principal(deployer)], deployer).result
    ).toBeErr(Cl.uint(ERR.INVALID_OWNER));
  });

  it("owner can cancel a pending transfer, blocking acceptance", () => {
    call("transfer-ownership", [Cl.principal(successor)], deployer);
    expect(call("cancel-ownership-transfer", [], deployer).result).toBeOk(Cl.bool(true));
    expect(read("get-pending-owner")).toBeNone();
    expect(call("accept-ownership", [], successor).result).toBeErr(
      Cl.uint(ERR.NO_PENDING_OWNER)
    );
  });

  it("cancel fails when nothing is pending", () => {
    expect(call("cancel-ownership-transfer", [], deployer).result).toBeErr(
      Cl.uint(ERR.NO_PENDING_OWNER)
    );
  });
});

// ===========================================================================
// Protocol state machine
// ===========================================================================

describe("protocol state machine", () => {
  it("protocol admin can pause and unpause", () => {
    grantRole(protocolAdmin, ROLE.PROTOCOL);
    expect(call("pause-protocol", [], protocolAdmin).result).toBeOk(Cl.bool(true));
    expect(read("get-protocol-state")).toBeUint(STATE.PAUSED);
    expect(read("is-protocol-active")).toBeBool(false);
    expect(read("check-protocol-active")).toBeErr(Cl.uint(ERR.PROTOCOL_PAUSED));

    expect(call("unpause-protocol", [], protocolAdmin).result).toBeOk(Cl.bool(true));
    expect(read("get-protocol-state")).toBeUint(STATE.ACTIVE);
  });

  it("unauthorized principals cannot pause or unpause", () => {
    expect(call("pause-protocol", [], attacker).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    pause();
    expect(call("unpause-protocol", [], attacker).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED)
    );
  });

  it("rejects pausing when not ACTIVE and unpausing when not PAUSED", () => {
    expect(unpause().result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
    pause();
    expect(pause().result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
  });

  it("emergency admin can emergency-pause from ACTIVE, PAUSED, and UPGRADING", () => {
    grantRole(emergencyAdmin, ROLE.EMERGENCY);

    // from ACTIVE
    expect(call("emergency-pause-protocol", [], emergencyAdmin).result).toBeOk(
      Cl.bool(true)
    );
    expect(read("get-protocol-state")).toBeUint(STATE.EMERGENCY);
    expect(read("check-protocol-active")).toBeErr(Cl.uint(ERR.PROTOCOL_EMERGENCY));

    // recover, then from PAUSED
    call("resolve-emergency", [], deployer);
    expect(read("get-protocol-state")).toBeUint(STATE.PAUSED);
    expect(call("emergency-pause-protocol", [], emergencyAdmin).result).toBeOk(
      Cl.bool(true)
    );

    // recover, then from UPGRADING
    call("resolve-emergency", [], deployer);
    call("begin-upgrade", [], deployer);
    expect(read("get-protocol-state")).toBeUint(STATE.UPGRADING);
    expect(call("emergency-pause-protocol", [], emergencyAdmin).result).toBeOk(
      Cl.bool(true)
    );
  });

  it("protocol admin cannot emergency-pause (role separation)", () => {
    grantRole(protocolAdmin, ROLE.PROTOCOL);
    expect(call("emergency-pause-protocol", [], protocolAdmin).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED)
    );
  });

  it("only the owner can resolve an emergency, landing in PAUSED", () => {
    grantRole(emergencyAdmin, ROLE.EMERGENCY);
    call("emergency-pause-protocol", [], emergencyAdmin);

    expect(call("resolve-emergency", [], emergencyAdmin).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED)
    );
    expect(call("resolve-emergency", [], deployer).result).toBeOk(Cl.bool(true));
    expect(read("get-protocol-state")).toBeUint(STATE.PAUSED);
  });

  it("resolve-emergency fails outside EMERGENCY", () => {
    expect(call("resolve-emergency", [], deployer).result).toBeErr(
      Cl.uint(ERR.INVALID_STATE_TRANSITION)
    );
  });

  it("upgrade window: PAUSED -> UPGRADING -> ACTIVE, owner only", () => {
    expect(call("begin-upgrade", [], deployer).result).toBeErr(
      Cl.uint(ERR.INVALID_STATE_TRANSITION) // must pause first
    );
    pause();
    grantRole(protocolAdmin, ROLE.PROTOCOL);
    expect(call("begin-upgrade", [], protocolAdmin).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED)
    );
    expect(call("begin-upgrade", [], deployer).result).toBeOk(Cl.bool(true));
    expect(read("get-protocol-state")).toBeUint(STATE.UPGRADING);
    expect(read("check-protocol-active")).toBeErr(Cl.uint(ERR.PROTOCOL_UPGRADING));

    expect(call("complete-upgrade", [], protocolAdmin).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED)
    );
    expect(call("complete-upgrade", [], deployer).result).toBeOk(Cl.bool(true));
    expect(read("get-protocol-state")).toBeUint(STATE.ACTIVE);
  });

  it("unpause cannot be abused to complete an upgrade", () => {
    beginUpgrade();
    grantRole(protocolAdmin, ROLE.PROTOCOL);
    expect(call("unpause-protocol", [], protocolAdmin).result).toBeErr(
      Cl.uint(ERR.INVALID_STATE_TRANSITION)
    );
  });

  it("complete-upgrade fails outside UPGRADING", () => {
    expect(call("complete-upgrade", [], deployer).result).toBeErr(
      Cl.uint(ERR.INVALID_STATE_TRANSITION)
    );
  });

  it("deprecation requires PAUSED, is owner-only, and is terminal", () => {
    expect(call("deprecate-protocol", [], deployer).result).toBeErr(
      Cl.uint(ERR.INVALID_STATE_TRANSITION)
    );
    pause();
    grantRole(protocolAdmin, ROLE.PROTOCOL);
    expect(call("deprecate-protocol", [], protocolAdmin).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED)
    );
    expect(call("deprecate-protocol", [], deployer).result).toBeOk(Cl.bool(true));
    expect(read("get-protocol-state")).toBeUint(STATE.DEPRECATED);

    // terminal: no transition leaves DEPRECATED, even for the owner
    expect(unpause().result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
    expect(pause().result).toBeErr(Cl.uint(ERR.INVALID_STATE_TRANSITION));
    expect(call("emergency-pause-protocol", [], deployer).result).toBeErr(
      Cl.uint(ERR.INVALID_STATE_TRANSITION)
    );
    expect(call("begin-upgrade", [], deployer).result).toBeErr(
      Cl.uint(ERR.INVALID_STATE_TRANSITION)
    );
    expect(read("check-protocol-active")).toBeErr(Cl.uint(ERR.PROTOCOL_DEPRECATED));
  });
});

// ===========================================================================
// Commitments
// ===========================================================================

describe("commitments", () => {
  it("registers commitments and returns sequential leaf indices", () => {
    authorize(pool);
    expect(registerCommitment(1).result).toBeOk(Cl.uint(0));
    expect(registerCommitment(2).result).toBeOk(Cl.uint(1));
    expect(registerCommitment(3).result).toBeOk(Cl.uint(2));
    expect(read("get-total-commitments")).toBeUint(3);
  });

  it("stores the commitment record with status, height, and version", () => {
    authorize(pool);
    registerCommitment(1);
    const height = simnet.blockHeight;
    expect(read("get-commitment", [hash32(1)])).toBeSome(
      Cl.tuple({
        registered: Cl.bool(true),
        "registered-at": Cl.uint(height),
        version: Cl.uint(1),
      })
    );
    expect(read("is-commitment-registered", [hash32(1)])).toBeBool(true);
    expect(read("is-commitment-registered", [hash32(99)])).toBeBool(false);
    expect(read("get-commitment", [hash32(99)])).toBeNone();
  });

  it("rejects duplicate commitments (immutability)", () => {
    authorize(pool);
    registerCommitment(1);
    expect(registerCommitment(1).result).toBeErr(Cl.uint(ERR.DUPLICATE_COMMITMENT));
    // count unchanged
    expect(read("get-total-commitments")).toBeUint(1);
  });

  it("rejects the zero commitment", () => {
    authorize(pool);
    expect(
      call("register-commitment", [ZERO_HASH, Cl.uint(1)], pool).result
    ).toBeErr(Cl.uint(ERR.INVALID_COMMITMENT));
  });

  it("rejects a commitment version mismatch", () => {
    authorize(pool);
    expect(registerCommitment(1, pool, 2).result).toBeErr(Cl.uint(ERR.VERSION_MISMATCH));
    expect(registerCommitment(1, pool, 0).result).toBeErr(Cl.uint(ERR.VERSION_MISMATCH));
  });

  it("rejects unauthorized callers -- including the owner", () => {
    expect(registerCommitment(1, attacker).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED_CALLER)
    );
    expect(registerCommitment(1, deployer).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED_CALLER)
    );
  });

  it("fails in every non-active protocol state with the precise error", () => {
    authorize(pool);
    grantRole(emergencyAdmin, ROLE.EMERGENCY);

    pause();
    expect(registerCommitment(1).result).toBeErr(Cl.uint(ERR.PROTOCOL_PAUSED));

    call("begin-upgrade", [], deployer);
    expect(registerCommitment(1).result).toBeErr(Cl.uint(ERR.PROTOCOL_UPGRADING));

    call("emergency-pause-protocol", [], emergencyAdmin);
    expect(registerCommitment(1).result).toBeErr(Cl.uint(ERR.PROTOCOL_EMERGENCY));

    call("resolve-emergency", [], deployer);
    call("deprecate-protocol", [], deployer);
    expect(registerCommitment(1).result).toBeErr(Cl.uint(ERR.PROTOCOL_DEPRECATED));
  });

  it("enforces the max-commitments capacity limit", () => {
    authorize(pool);
    call(
      "update-protocol-limits",
      [limitsCV({ "max-commitments": 2 })],
      deployer
    );
    expect(registerCommitment(1).result).toBeOk(Cl.uint(0));
    expect(registerCommitment(2).result).toBeOk(Cl.uint(1));
    expect(registerCommitment(3).result).toBeErr(
      Cl.uint(ERR.COMMITMENT_LIMIT_EXCEEDED)
    );
  });
});

// ===========================================================================
// Nullifiers: double spend & replay protection
// ===========================================================================

describe("nullifiers", () => {
  it("registers a nullifier and marks the note spent", () => {
    authorize(pool);
    registerCommitment(1);
    expect(registerNullifier(1).result).toBeOk(Cl.bool(true));
    expect(read("is-nullifier-spent", [hash32(1001)])).toBeBool(true);
    const height = simnet.blockHeight;
    expect(read("get-nullifier", [hash32(1001)])).toBeSome(
      Cl.tuple({ registered: Cl.bool(true), "consumed-at": Cl.uint(height) })
    );
    expect(read("get-total-nullifiers")).toBeUint(1);
  });

  it("unspent nullifiers read as unspent", () => {
    expect(read("is-nullifier-spent", [hash32(1001)])).toBeBool(false);
    expect(read("get-nullifier", [hash32(1001)])).toBeNone();
  });

  it("rejects double spending (same nullifier twice)", () => {
    authorize(pool);
    registerCommitment(1);
    registerCommitment(2);
    registerNullifier(1);
    expect(registerNullifier(1).result).toBeErr(Cl.uint(ERR.DUPLICATE_NULLIFIER));
    expect(read("get-total-nullifiers")).toBeUint(1);
  });

  it("rejects a replayed registration even many operations later", () => {
    authorize(pool);
    registerCommitment(1);
    registerCommitment(2);
    registerCommitment(3);
    registerNullifier(1);
    registerNullifier(2);
    // replay of the first spend transaction
    expect(registerNullifier(1).result).toBeErr(Cl.uint(ERR.DUPLICATE_NULLIFIER));
  });

  it("rejects the zero nullifier", () => {
    authorize(pool);
    registerCommitment(1);
    expect(call("register-nullifier", [ZERO_HASH], pool).result).toBeErr(
      Cl.uint(ERR.INVALID_NULLIFIER)
    );
  });

  it("rejects unauthorized callers", () => {
    authorize(pool);
    registerCommitment(1);
    expect(registerNullifier(1, attacker).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED_CALLER)
    );
  });

  it("fails while paused", () => {
    authorize(pool);
    registerCommitment(1);
    pause();
    expect(registerNullifier(1).result).toBeErr(Cl.uint(ERR.PROTOCOL_PAUSED));
  });

  it("cumulative nullifiers can never exceed cumulative commitments", () => {
    authorize(pool);
    registerCommitment(1);
    registerCommitment(2);
    registerNullifier(1);
    registerNullifier(2);
    // a third spend without a third commitment is a protocol-level impossibility
    expect(registerNullifier(3).result).toBeErr(
      Cl.uint(ERR.NULLIFIER_INVARIANT_VIOLATION)
    );
  });
});

// ===========================================================================
// Merkle roots
// ===========================================================================

describe("merkle roots", () => {
  it("authorized caller can post a new root; it becomes current and known", () => {
    authorize(pool);
    expect(updateRoot(1).result).toBeOk(Cl.bool(true));
    const height = simnet.blockHeight;
    expect(read("get-current-root")).toBeTuple({
      root: hash32(2001),
      version: Cl.uint(1),
      "updated-at": Cl.uint(height),
    });
    expect(read("is-known-root", [hash32(2001)])).toBeBool(true);
    expect(read("validate-root", [hash32(2001)])).toBeOk(Cl.bool(true));
  });

  it("owner can bootstrap the first root without being an authorized caller", () => {
    expect(updateRoot(1, deployer).result).toBeOk(Cl.bool(true));
  });

  it("historical roots remain known after newer roots are posted", () => {
    authorize(pool);
    updateRoot(1);
    updateRoot(2);
    updateRoot(3);
    // current is the newest...
    expect(read("get-current-root")).toBeTuple({
      root: hash32(2003),
      version: Cl.uint(1),
      "updated-at": Cl.uint(simnet.blockHeight),
    });
    // ...but proofs against older roots must still validate
    expect(read("is-known-root", [hash32(2001)])).toBeBool(true);
    expect(read("is-known-root", [hash32(2002)])).toBeBool(true);
    expect(read("validate-root", [hash32(2001)])).toBeOk(Cl.bool(true));
  });

  it("rejects unknown roots", () => {
    expect(read("is-known-root", [hash32(2099)])).toBeBool(false);
    expect(read("validate-root", [hash32(2099)])).toBeErr(Cl.uint(ERR.ROOT_NOT_FOUND));
  });

  it("rejects the zero root, duplicate roots, and version mismatches", () => {
    authorize(pool);
    expect(call("update-root", [ZERO_HASH, Cl.uint(1)], pool).result).toBeErr(
      Cl.uint(ERR.INVALID_ROOT)
    );
    updateRoot(1);
    expect(updateRoot(1).result).toBeErr(Cl.uint(ERR.DUPLICATE_ROOT));
    expect(updateRoot(2, pool, 7).result).toBeErr(Cl.uint(ERR.VERSION_MISMATCH));
  });

  it("rejects unauthorized root updates and updates while paused", () => {
    expect(updateRoot(1, attacker).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED_CALLER));
    authorize(pool);
    pause();
    expect(updateRoot(1).result).toBeErr(Cl.uint(ERR.PROTOCOL_PAUSED));
  });

  it("emergency admin can deactivate and reactivate a root in any state", () => {
    authorize(pool);
    grantRole(emergencyAdmin, ROLE.EMERGENCY);
    updateRoot(1);
    updateRoot(2);

    // incident: deactivate the older root while paused
    pause();
    expect(
      call("set-root-status", [hash32(2001), Cl.bool(false)], emergencyAdmin).result
    ).toBeOk(Cl.bool(true));
    expect(read("is-known-root", [hash32(2001)])).toBeBool(false);
    expect(read("validate-root", [hash32(2001)])).toBeErr(Cl.uint(ERR.INVALID_ROOT));
    // the other root is untouched
    expect(read("is-known-root", [hash32(2002)])).toBeBool(true);

    // reactivate
    expect(
      call("set-root-status", [hash32(2001), Cl.bool(true)], emergencyAdmin).result
    ).toBeOk(Cl.bool(true));
    expect(read("is-known-root", [hash32(2001)])).toBeBool(true);
  });

  it("set-root-status rejects unknown roots, no-op changes, and unauthorized callers", () => {
    authorize(pool);
    updateRoot(1);
    expect(
      call("set-root-status", [hash32(2099), Cl.bool(false)], deployer).result
    ).toBeErr(Cl.uint(ERR.ROOT_NOT_FOUND));
    expect(
      call("set-root-status", [hash32(2001), Cl.bool(true)], deployer).result
    ).toBeErr(Cl.uint(ERR.INVALID_ROOT)); // already active
    expect(
      call("set-root-status", [hash32(2001), Cl.bool(false)], attacker).result
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
  });
});

// ===========================================================================
// Version management
// ===========================================================================

describe("version management", () => {
  it("versions can only change while UPGRADING", () => {
    expect(
      call("update-versions", [versionsCV({ protocol: 2 })], deployer).result
    ).toBeErr(Cl.uint(ERR.INVALID_PROTOCOL_STATE));
    pause();
    expect(
      call("update-versions", [versionsCV({ protocol: 2 })], deployer).result
    ).toBeErr(Cl.uint(ERR.INVALID_PROTOCOL_STATE));
  });

  it("full upgrade flow bumps versions and returns to ACTIVE", () => {
    beginUpgrade();
    expect(
      call(
        "update-versions",
        [versionsCV({ protocol: 2, note: 2, commitment: 2 })],
        deployer
      ).result
    ).toBeOk(Cl.bool(true));
    call("complete-upgrade", [], deployer);

    expect(read("get-protocol-version")).toBeUint(2);
    expect(read("get-note-version")).toBeUint(2);
    expect(read("get-commitment-version")).toBeUint(2);
    expect(read("get-verifier-version")).toBeUint(1);
    expect(read("get-protocol-state")).toBeUint(STATE.ACTIVE);

    // the new commitment version is now enforced
    authorize(pool);
    expect(registerCommitment(1, pool, 1).result).toBeErr(
      Cl.uint(ERR.VERSION_MISMATCH)
    );
    expect(registerCommitment(1, pool, 2).result).toBeOk(Cl.uint(0));
  });

  it("rejects downgrades and unchanged version sets", () => {
    beginUpgrade();
    expect(
      call("update-versions", [versionsCV({ protocol: 0 })], deployer).result
    ).toBeErr(Cl.uint(ERR.INVALID_VERSION));
    expect(call("update-versions", [versionsCV()], deployer).result).toBeErr(
      Cl.uint(ERR.INVALID_VERSION)
    );
  });

  it("protocol admin may update versions; other roles may not", () => {
    grantRole(protocolAdmin, ROLE.PROTOCOL);
    grantRole(verifierAdmin, ROLE.VERIFIER);
    beginUpgrade();
    expect(
      call("update-versions", [versionsCV({ protocol: 2 })], verifierAdmin).result
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(
      call("update-versions", [versionsCV({ protocol: 2 })], protocolAdmin).result
    ).toBeOk(Cl.bool(true));
  });

  it("verifier admin can bump verifier/circuit versions via the scoped function", () => {
    grantRole(verifierAdmin, ROLE.VERIFIER);
    beginUpgrade();
    expect(
      call("set-verifier-versions", [Cl.uint(2), Cl.uint(2)], verifierAdmin).result
    ).toBeOk(Cl.bool(true));
    expect(read("get-verifier-version")).toBeUint(2);
    expect(read("get-circuit-version")).toBeUint(2);
    // untouched components keep their versions
    expect(read("get-protocol-version")).toBeUint(1);
  });

  it("scoped verifier update enforces state, monotonicity, and authorization", () => {
    grantRole(verifierAdmin, ROLE.VERIFIER);
    grantRole(feeAdmin, ROLE.FEE);
    expect(
      call("set-verifier-versions", [Cl.uint(2), Cl.uint(2)], verifierAdmin).result
    ).toBeErr(Cl.uint(ERR.INVALID_PROTOCOL_STATE));
    beginUpgrade();
    expect(
      call("set-verifier-versions", [Cl.uint(1), Cl.uint(1)], verifierAdmin).result
    ).toBeErr(Cl.uint(ERR.INVALID_VERSION)); // unchanged
    expect(
      call("set-verifier-versions", [Cl.uint(0), Cl.uint(2)], verifierAdmin).result
    ).toBeErr(Cl.uint(ERR.INVALID_VERSION)); // downgrade
    expect(
      call("set-verifier-versions", [Cl.uint(2), Cl.uint(2)], feeAdmin).result
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
  });
});

// ===========================================================================
// Protocol limits
// ===========================================================================

describe("protocol limits", () => {
  it("protocol admin can update limits; getters reflect the change", () => {
    grantRole(protocolAdmin, ROLE.PROTOCOL);
    expect(
      call(
        "update-protocol-limits",
        [limitsCV({ "min-shield": 2 * ONE_STX, "max-fee-bps": 50 })],
        protocolAdmin
      ).result
    ).toBeOk(Cl.bool(true));
    expect(read("get-min-shield-amount")).toBeUint(2 * ONE_STX);
    expect(read("get-max-fee-bps")).toBeUint(50);
  });

  it("rejects updates from unauthorized principals", () => {
    grantRole(feeAdmin, ROLE.FEE);
    expect(call("update-protocol-limits", [limitsCV()], attacker).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED)
    );
    expect(call("update-protocol-limits", [limitsCV()], feeAdmin).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED)
    );
  });

  it("rejects inconsistent limit configurations", () => {
    const bad = [
      { "min-shield": 0 },
      { "min-shield": 10 * ONE_STX, "max-shield": ONE_STX },
      { "min-withdrawal": 0 },
      { "min-withdrawal": 10 * ONE_STX, "max-withdrawal": ONE_STX },
      { "max-commitments": 0 },
      { "max-commitments": 1_048_577 }, // beyond tree capacity
      { "max-notes": 0 },
      { "max-notes": 1_048_577 },
      { "max-fee-bps": 1001 }, // beyond the 10% hard cap
    ];
    for (const overrides of bad) {
      expect(
        call("update-protocol-limits", [limitsCV(overrides as any)], deployer).result
      ).toBeErr(Cl.uint(ERR.INVALID_LIMITS));
    }
  });

  it("capacity limits can never be set below what is already registered", () => {
    authorize(pool);
    registerCommitment(1);
    registerCommitment(2);
    call("record-note-created", [], pool);
    call("record-note-created", [], pool);

    expect(
      call("update-protocol-limits", [limitsCV({ "max-commitments": 1 })], deployer)
        .result
    ).toBeErr(Cl.uint(ERR.INVALID_LIMITS));
    expect(
      call("update-protocol-limits", [limitsCV({ "max-notes": 1 })], deployer).result
    ).toBeErr(Cl.uint(ERR.INVALID_LIMITS));
    // equal to what is registered is fine
    expect(
      call(
        "update-protocol-limits",
        [limitsCV({ "max-commitments": 2, "max-notes": 2 })],
        deployer
      ).result
    ).toBeOk(Cl.bool(true));
  });

  it("fee admin can update only the fee ceiling, within the hard cap", () => {
    grantRole(feeAdmin, ROLE.FEE);
    grantRole(verifierAdmin, ROLE.VERIFIER);
    expect(call("set-max-fee-bps", [Cl.uint(250)], feeAdmin).result).toBeOk(
      Cl.bool(true)
    );
    expect(read("get-max-fee-bps")).toBeUint(250);
    expect(call("set-max-fee-bps", [Cl.uint(1001)], feeAdmin).result).toBeErr(
      Cl.uint(ERR.INVALID_LIMITS)
    );
    expect(call("set-max-fee-bps", [Cl.uint(50)], verifierAdmin).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED)
    );
    // other limits untouched
    expect(read("get-min-shield-amount")).toBeUint(ONE_STX);
  });

  it("validates shield amounts at exact boundaries", () => {
    expect(read("validate-shield-amount", [Cl.uint(ONE_STX - 1)])).toBeErr(
      Cl.uint(ERR.AMOUNT_BELOW_MINIMUM)
    );
    expect(read("validate-shield-amount", [Cl.uint(ONE_STX)])).toBeOk(Cl.bool(true));
    expect(read("validate-shield-amount", [Cl.uint(1_000_000_000_000)])).toBeOk(
      Cl.bool(true)
    );
    expect(read("validate-shield-amount", [Cl.uint(1_000_000_000_001)])).toBeErr(
      Cl.uint(ERR.AMOUNT_ABOVE_MAXIMUM)
    );
  });

  it("validates withdrawal amounts at exact boundaries", () => {
    expect(read("validate-withdrawal-amount", [Cl.uint(ONE_STX - 1)])).toBeErr(
      Cl.uint(ERR.AMOUNT_BELOW_MINIMUM)
    );
    expect(read("validate-withdrawal-amount", [Cl.uint(ONE_STX)])).toBeOk(
      Cl.bool(true)
    );
    expect(
      read("validate-withdrawal-amount", [Cl.uint(1_000_000_000_001)])
    ).toBeErr(Cl.uint(ERR.AMOUNT_ABOVE_MAXIMUM));
  });
});

// ===========================================================================
// Statistics
// ===========================================================================

describe("statistics", () => {
  it("records shields and enforces shield limits", () => {
    authorize(pool);
    expect(call("record-shield", [Cl.uint(10 * ONE_STX)], pool).result).toBeOk(
      Cl.bool(true)
    );
    expect(read("get-total-shielded-stx")).toBeUint(10 * ONE_STX);

    expect(call("record-shield", [Cl.uint(ONE_STX - 1)], pool).result).toBeErr(
      Cl.uint(ERR.AMOUNT_BELOW_MINIMUM)
    );
    expect(
      call("record-shield", [Cl.uint(1_000_000_000_001)], pool).result
    ).toBeErr(Cl.uint(ERR.AMOUNT_ABOVE_MAXIMUM));
  });

  it("records withdrawals, decreasing the shielded balance", () => {
    authorize(pool);
    call("record-shield", [Cl.uint(10 * ONE_STX)], pool);
    expect(call("record-withdrawal", [Cl.uint(4 * ONE_STX)], pool).result).toBeOk(
      Cl.bool(true)
    );
    expect(read("get-total-shielded-stx")).toBeUint(6 * ONE_STX);
    expect(read("get-total-withdrawals")).toBeUint(1);
  });

  it("rejects withdrawals exceeding the shielded balance", () => {
    authorize(pool);
    call("record-shield", [Cl.uint(2 * ONE_STX)], pool);
    expect(call("record-withdrawal", [Cl.uint(5 * ONE_STX)], pool).result).toBeErr(
      Cl.uint(ERR.INSUFFICIENT_SHIELDED_BALANCE)
    );
  });

  it("enforces withdrawal limits", () => {
    authorize(pool);
    call("record-shield", [Cl.uint(1_000_000_000_000)], pool);
    expect(call("record-withdrawal", [Cl.uint(ONE_STX - 1)], pool).result).toBeErr(
      Cl.uint(ERR.AMOUNT_BELOW_MINIMUM)
    );
  });

  it("records transfers", () => {
    authorize(pool);
    call("record-transfer", [], pool);
    call("record-transfer", [], pool);
    expect(read("get-total-transfers")).toBeUint(2);
  });

  it("records notes and enforces the note capacity limit", () => {
    authorize(pool);
    call("update-protocol-limits", [limitsCV({ "max-notes": 2 })], deployer);
    expect(call("record-note-created", [], pool).result).toBeOk(Cl.bool(true));
    expect(call("record-note-created", [], pool).result).toBeOk(Cl.bool(true));
    expect(call("record-note-created", [], pool).result).toBeErr(
      Cl.uint(ERR.NOTE_LIMIT_EXCEEDED)
    );
    expect(read("get-total-notes")).toBeUint(2);
  });

  it("rejects statistics updates from unauthorized callers", () => {
    expect(call("record-shield", [Cl.uint(ONE_STX)], attacker).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED_CALLER)
    );
    expect(call("record-withdrawal", [Cl.uint(ONE_STX)], attacker).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED_CALLER)
    );
    expect(call("record-transfer", [], attacker).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED_CALLER)
    );
    expect(call("record-note-created", [], attacker).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED_CALLER)
    );
  });

  it("rejects statistics updates while paused", () => {
    authorize(pool);
    pause();
    expect(call("record-shield", [Cl.uint(ONE_STX)], pool).result).toBeErr(
      Cl.uint(ERR.PROTOCOL_PAUSED)
    );
    expect(call("record-transfer", [], pool).result).toBeErr(
      Cl.uint(ERR.PROTOCOL_PAUSED)
    );
    expect(call("record-note-created", [], pool).result).toBeErr(
      Cl.uint(ERR.PROTOCOL_PAUSED)
    );
  });
});

// ===========================================================================
// Integration flow: registry driven the way privacy-pool will drive it
// ===========================================================================

describe("integration: full protocol flow", () => {
  it("shield -> root update -> transfer -> withdrawal, with consistent statistics", () => {
    // bootstrap: authorize the pool contract stand-in
    authorize(pool);

    // -- user shields 100 STX --------------------------------------------
    expect(call("record-shield", [Cl.uint(100 * ONE_STX)], pool).result).toBeOk(
      Cl.bool(true)
    );
    expect(registerCommitment(1).result).toBeOk(Cl.uint(0));
    expect(call("record-note-created", [], pool).result).toBeOk(Cl.bool(true));
    expect(updateRoot(1).result).toBeOk(Cl.bool(true));

    // -- private transfer: consume note 1, create note 2 ------------------
    expect(registerNullifier(1).result).toBeOk(Cl.bool(true));
    expect(registerCommitment(2).result).toBeOk(Cl.uint(1));
    expect(call("record-note-created", [], pool).result).toBeOk(Cl.bool(true));
    expect(updateRoot(2).result).toBeOk(Cl.bool(true));
    expect(call("record-transfer", [], pool).result).toBeOk(Cl.bool(true));

    // proof against the pre-transfer root must still be validatable
    expect(read("is-known-root", [hash32(2001)])).toBeBool(true);

    // -- withdrawal of 40 STX: consume note 2 -----------------------------
    expect(registerNullifier(2).result).toBeOk(Cl.bool(true));
    expect(call("record-withdrawal", [Cl.uint(40 * ONE_STX)], pool).result).toBeOk(
      Cl.bool(true)
    );

    // -- aggregate statistics are consistent ------------------------------
    expect(read("get-statistics")).toBeTuple({
      "total-commitments": Cl.uint(2),
      "total-nullifiers": Cl.uint(2),
      "total-notes": Cl.uint(2),
      "total-transfers": Cl.uint(1),
      "total-withdrawals": Cl.uint(1),
      "total-shielded-stx": Cl.uint(60 * ONE_STX),
    });

    // double spend of either note is impossible
    expect(registerNullifier(1).result).toBeErr(Cl.uint(ERR.DUPLICATE_NULLIFIER));
    expect(registerNullifier(2).result).toBeErr(Cl.uint(ERR.DUPLICATE_NULLIFIER));
  });

  it("a paused protocol blocks the entire flow and resumes cleanly", () => {
    authorize(pool);
    call("record-shield", [Cl.uint(10 * ONE_STX)], pool);
    registerCommitment(1);

    pause();
    expect(registerCommitment(2).result).toBeErr(Cl.uint(ERR.PROTOCOL_PAUSED));
    expect(registerNullifier(1).result).toBeErr(Cl.uint(ERR.PROTOCOL_PAUSED));
    expect(updateRoot(1).result).toBeErr(Cl.uint(ERR.PROTOCOL_PAUSED));
    expect(
      call("record-withdrawal", [Cl.uint(10 * ONE_STX)], pool).result
    ).toBeErr(Cl.uint(ERR.PROTOCOL_PAUSED));

    unpause();
    expect(registerCommitment(2).result).toBeOk(Cl.uint(1));
    expect(registerNullifier(1).result).toBeOk(Cl.bool(true));
  });

  it("deauthorizing a compromised protocol contract cuts off all writes", () => {
    authorize(pool);
    registerCommitment(1);
    call("remove-authorized-caller", [Cl.principal(pool)], deployer);
    expect(registerCommitment(2).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED_CALLER));
    expect(registerNullifier(1).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED_CALLER));
    expect(updateRoot(1).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED_CALLER));
    expect(call("record-transfer", [], pool).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED_CALLER)
    );
  });
});

// ===========================================================================
// Security freeze: STX supply ceiling (arithmetic audit)
// ===========================================================================

describe("security freeze: supply ceiling", () => {
  it("amount limits can never exceed the STX supply ceiling", () => {
    expect(
      call(
        "update-protocol-limits",
        [limitsCV({ "max-shield": STX_SUPPLY_CEILING + 1 })],
        deployer
      ).result
    ).toBeErr(Cl.uint(ERR.INVALID_LIMITS));
    expect(
      call(
        "update-protocol-limits",
        [limitsCV({ "max-withdrawal": STX_SUPPLY_CEILING + 1 })],
        deployer
      ).result
    ).toBeErr(Cl.uint(ERR.INVALID_LIMITS));
    // exactly the ceiling is a valid configuration
    expect(
      call(
        "update-protocol-limits",
        [
          limitsCV({
            "max-shield": STX_SUPPLY_CEILING,
            "max-withdrawal": STX_SUPPLY_CEILING,
          }),
        ],
        deployer
      ).result
    ).toBeOk(Cl.bool(true));
  });

  it("the aggregate shielded balance can never exceed the STX supply", () => {
    authorize(pool);
    call(
      "update-protocol-limits",
      [
        limitsCV({
          "max-shield": STX_SUPPLY_CEILING,
          "max-withdrawal": STX_SUPPLY_CEILING,
        }),
      ],
      deployer
    );
    expect(call("record-shield", [Cl.uint(STX_SUPPLY_CEILING)], pool).result).toBeOk(
      Cl.bool(true)
    );
    // one more micro-STX would exceed everything that exists
    expect(call("record-shield", [Cl.uint(ONE_STX)], pool).result).toBeErr(
      Cl.uint(ERR.SHIELDED_SUPPLY_OVERFLOW)
    );
    expect(read("get-total-shielded-stx")).toBeUint(STX_SUPPLY_CEILING);
  });

  it("record-shield accepts the exact configured maximum", () => {
    authorize(pool);
    expect(call("record-shield", [Cl.uint(1_000_000_000_000)], pool).result).toBeOk(
      Cl.bool(true)
    );
  });
});

// ===========================================================================
// Security freeze: configuration lockdown during EMERGENCY
// ===========================================================================

describe("security freeze: emergency configuration lockdown", () => {
  it("non-owner admins cannot change limits during an emergency; the owner can", () => {
    grantRole(protocolAdmin, ROLE.PROTOCOL);
    grantRole(feeAdmin, ROLE.FEE);
    grantRole(emergencyAdmin, ROLE.EMERGENCY);
    call("emergency-pause-protocol", [], emergencyAdmin);

    // a compromised admin key cannot stage malicious limits mid-incident
    expect(
      call("update-protocol-limits", [limitsCV()], protocolAdmin).result
    ).toBeErr(Cl.uint(ERR.PROTOCOL_EMERGENCY));
    expect(call("set-max-fee-bps", [Cl.uint(999)], feeAdmin).result).toBeErr(
      Cl.uint(ERR.PROTOCOL_EMERGENCY)
    );

    // the owner retains full incident-response capability
    expect(
      call(
        "update-protocol-limits",
        [limitsCV({ "min-shield": 2 * ONE_STX })],
        deployer
      ).result
    ).toBeOk(Cl.bool(true));
    expect(call("set-max-fee-bps", [Cl.uint(50)], deployer).result).toBeOk(
      Cl.bool(true)
    );
  });

  it("limit changes work again for admins once the emergency is resolved", () => {
    grantRole(protocolAdmin, ROLE.PROTOCOL);
    grantRole(emergencyAdmin, ROLE.EMERGENCY);
    call("emergency-pause-protocol", [], emergencyAdmin);
    call("resolve-emergency", [], deployer);
    expect(
      call("update-protocol-limits", [limitsCV()], protocolAdmin).result
    ).toBeOk(Cl.bool(true));
  });

  it("authorization is checked before any storage probe in set-root-status", () => {
    // unknown root + unauthorized caller must fail on authorization,
    // not reveal whether the root exists
    expect(
      call("set-root-status", [hash32(2099), Cl.bool(false)], attacker).result
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
  });
});

// ===========================================================================
// Security freeze: aggregate read-onlys for integrators
// ===========================================================================

describe("security freeze: aggregate reads", () => {
  it("get-protocol-constants exposes the hard protocol constants", () => {
    expect(read("get-protocol-constants")).toBeTuple({
      "merkle-tree-capacity": Cl.uint(1_048_576),
      "max-fee-bps-ceiling": Cl.uint(1000),
      "bps-denominator": Cl.uint(10_000),
      "stx-supply-ceiling": Cl.uint(STX_SUPPLY_CEILING),
      "zero-hash": ZERO_HASH,
    });
  });

  it("get-protocol-info returns a consistent full snapshot", () => {
    authorize(pool);
    registerCommitment(1);
    updateRoot(1);
    const rootHeight = simnet.blockHeight;
    expect(read("get-protocol-info")).toBeTuple({
      state: Cl.uint(STATE.ACTIVE),
      owner: Cl.principal(deployer),
      "current-root": Cl.tuple({
        root: hash32(2001),
        version: Cl.uint(1),
        "updated-at": Cl.uint(rootHeight),
      }),
      versions: uintTuple(DEFAULT_VERSIONS),
      limits: limitsCV(),
      statistics: uintTuple({
        "total-commitments": 1,
        "total-nullifiers": 0,
        "total-notes": 0,
        "total-transfers": 0,
        "total-withdrawals": 0,
        "total-shielded-stx": 0,
      }),
    });
  });
});

// ===========================================================================
// Security freeze: randomized batch behavior (property test)
// ===========================================================================

describe("security freeze: randomized batch properties", () => {
  it("random commitments get sequential indices; replays never corrupt counters", () => {
    authorize(pool);

    // deterministic MINSTD generator: reproducible pseudo-random 31-bit values
    let seed = 0xc0ffee;
    const next = () => (seed = (seed * 48271) % 2147483647);

    const values: number[] = [];
    const seen = new Set<number>();
    while (values.length < 40) {
      const v = next();
      if (!seen.has(v)) {
        seen.add(v);
        values.push(v);
      }
    }

    values.forEach((v, i) => {
      expect(call("register-commitment", [hash32(v), Cl.uint(1)], pool).result).toBeOk(
        Cl.uint(i)
      );
    });
    expect(read("get-total-commitments")).toBeUint(40);

    // replaying a sample of already-registered commitments must fail without
    // disturbing the counter
    for (let i = 0; i < 40; i += 5) {
      expect(
        call("register-commitment", [hash32(values[i]!), Cl.uint(1)], pool).result
      ).toBeErr(Cl.uint(ERR.DUPLICATE_COMMITMENT));
    }
    expect(read("get-total-commitments")).toBeUint(40);

    // an independent stream of random nullifiers stays within the invariant
    for (let i = 0; i < 20; i++) {
      expect(call("register-nullifier", [hash32(next())], pool).result).toBeOk(
        Cl.bool(true)
      );
    }
    expect(read("get-total-nullifiers")).toBeUint(20);
  });
});
