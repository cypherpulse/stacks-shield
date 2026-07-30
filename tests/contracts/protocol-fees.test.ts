import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";

/*
  Test suite for protocol-fees.clar -- fee configuration, collection, and
  treasury custody. Authority is fully delegated to the frozen
  privacy-registry: fee admin configures, authorized callers collect,
  the owner alone withdraws, the emergency admin freezes.

  wallet_5 stands in for privacy-pool (an authorized caller paying fees in).
*/

const REGISTRY = "privacy-registry";
const FEES = "protocol-fees";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const feeAdmin = accounts.get("wallet_4")!;
const emergencyAdmin = accounts.get("wallet_2")!;
const verifierAdmin = accounts.get("wallet_3")!;
const pool = accounts.get("wallet_5")!;
const attacker = accounts.get("wallet_6")!;
const treasuryDest = accounts.get("wallet_8")!;

const FEE_TYPE = { SHIELD: 1, TRANSFER: 2, WITHDRAWAL: 3, RELAYER: 4 };
const ROLE = { PROTOCOL: 1, EMERGENCY: 2, VERIFIER: 3, FEE: 4 };

const ERR = {
  UNAUTHORIZED: 200,
  UNAUTHORIZED_CALLER: 201,
  FEES_FROZEN: 202,
  TREASURY_FROZEN: 203,
  UNKNOWN_FEE_TYPE: 204,
  FEE_ABOVE_CEILING: 205,
  ZERO_AMOUNT: 206,
  INSUFFICIENT_TREASURY: 207,
  INVALID_RECIPIENT: 209,
};
const REG_ERR = { PROTOCOL_PAUSED: 102 };

const ONE_STX = 1_000_000;
const BURN = "SP000000000000000000002Q6VF78";

const call = (fn: string, args: unknown[], sender: string) =>
  simnet.callPublicFn(FEES, fn, args as any, sender);
const read = (fn: string, args: unknown[] = []) =>
  simnet.callReadOnlyFn(FEES, fn, args as any, deployer).result;
const regCall = (fn: string, args: unknown[], sender: string) =>
  simnet.callPublicFn(REGISTRY, fn, args as any, sender);

const authorizePool = () =>
  regCall("add-authorized-caller", [Cl.principal(pool)], deployer);
const grantRole = (account: string, role: number) =>
  regCall("grant-role", [Cl.principal(account), Cl.uint(role)], deployer);
const setFee = (type: number, bps: number, flat: number, enabled = true, sender = deployer) =>
  call("set-fee", [Cl.uint(type), Cl.uint(bps), Cl.uint(flat), Cl.bool(enabled)], sender);
const collect = (type: number, amount: number, sender = pool) =>
  call("collect-fee", [Cl.uint(type), Cl.uint(amount)], sender);
const calculate = (type: number, amount: number) =>
  read("calculate-fee", [Cl.uint(type), Cl.uint(amount)]);

const stxBalance = (who: string): bigint =>
  simnet.getAssetsMap().get("STX")?.get(who) ?? 0n;

// ===========================================================================
// Deployment
// ===========================================================================

describe("deployment", () => {
  it("initializes all four fee types enabled at zero", () => {
    for (const t of Object.values(FEE_TYPE)) {
      expect(read("get-fee-config", [Cl.uint(t)])).toBeSome(
        Cl.tuple({ bps: Cl.uint(0), flat: Cl.uint(0), enabled: Cl.bool(true) })
      );
    }
  });

  it("starts with an empty, unfrozen treasury", () => {
    expect(read("get-treasury")).toBeTuple({
      "total-collected": Cl.uint(0),
      "total-withdrawn": Cl.uint(0),
      balance: Cl.uint(0),
      "actual-balance": Cl.uint(0),
    });
    expect(read("is-fees-frozen")).toBeBool(false);
    expect(read("is-treasury-frozen")).toBeBool(false);
    expect(read("get-fees-contract-version")).toBeUint(1);
  });

  it("unknown fee types read as none and fail calculation", () => {
    expect(read("get-fee-config", [Cl.uint(9)])).toBeNone();
    expect(calculate(9, ONE_STX)).toBeErr(Cl.uint(ERR.UNKNOWN_FEE_TYPE));
  });
});

// ===========================================================================
// Fee configuration
// ===========================================================================

describe("fee configuration", () => {
  it("fee admin and owner can set fees; others cannot", () => {
    grantRole(feeAdmin, ROLE.FEE);
    expect(setFee(FEE_TYPE.SHIELD, 50, 0, true, feeAdmin).result).toBeOk(Cl.bool(true));
    expect(setFee(FEE_TYPE.WITHDRAWAL, 25, 0, true, deployer).result).toBeOk(Cl.bool(true));
    expect(setFee(FEE_TYPE.SHIELD, 10, 0, true, attacker).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED)
    );
    grantRole(verifierAdmin, ROLE.VERIFIER);
    expect(setFee(FEE_TYPE.SHIELD, 10, 0, true, verifierAdmin).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED)
    );
  });

  it("rejects bps above the registry ceiling and flat above the hard cap", () => {
    // registry default max-fee-bps is 100 (1%)
    expect(setFee(FEE_TYPE.SHIELD, 101, 0).result).toBeErr(Cl.uint(ERR.FEE_ABOVE_CEILING));
    expect(setFee(FEE_TYPE.SHIELD, 100, 0).result).toBeOk(Cl.bool(true));
    // flat ceiling is 10 STX
    expect(setFee(FEE_TYPE.TRANSFER, 0, 10 * ONE_STX + 1).result).toBeErr(
      Cl.uint(ERR.FEE_ABOVE_CEILING)
    );
    expect(setFee(FEE_TYPE.TRANSFER, 0, 10 * ONE_STX).result).toBeOk(Cl.bool(true));
  });

  it("rejects unknown fee types", () => {
    expect(setFee(9, 10, 0).result).toBeErr(Cl.uint(ERR.UNKNOWN_FEE_TYPE));
    expect(setFee(0, 10, 0).result).toBeErr(Cl.uint(ERR.UNKNOWN_FEE_TYPE));
  });

  it("calculates flat + percentage with floor rounding", () => {
    setFee(FEE_TYPE.SHIELD, 100, 0); // 1%
    expect(calculate(FEE_TYPE.SHIELD, 100 * ONE_STX)).toBeOk(Cl.uint(ONE_STX));
    // floor: 999 uSTX at 1% -> 9.99 -> 9
    expect(calculate(FEE_TYPE.SHIELD, 999)).toBeOk(Cl.uint(9));
    // combined flat + bps
    setFee(FEE_TYPE.WITHDRAWAL, 50, 2 * ONE_STX); // 0.5% + 2 STX
    expect(calculate(FEE_TYPE.WITHDRAWAL, 100 * ONE_STX)).toBeOk(
      Cl.uint(2 * ONE_STX + ONE_STX / 2)
    );
  });

  it("disabled fee types always charge zero", () => {
    setFee(FEE_TYPE.SHIELD, 100, ONE_STX, false);
    expect(calculate(FEE_TYPE.SHIELD, 100 * ONE_STX)).toBeOk(Cl.uint(0));
  });

  it("charge-time clamp: lowering the registry ceiling instantly caps fees", () => {
    setFee(FEE_TYPE.SHIELD, 100, 0); // 1%, legal now
    // lower the governance ceiling to 0.1%
    regCall(
      "update-protocol-limits",
      [
        Cl.tuple({
          "min-shield": Cl.uint(ONE_STX),
          "max-shield": Cl.uint(1_000_000_000_000),
          "min-withdrawal": Cl.uint(ONE_STX),
          "max-withdrawal": Cl.uint(1_000_000_000_000),
          "max-commitments": Cl.uint(1_048_576),
          "max-notes": Cl.uint(1_048_576),
          "max-fee-bps": Cl.uint(10),
        }),
      ],
      deployer
    );
    // stored config says 100 bps, but the live ceiling wins: 0.1%
    expect(calculate(FEE_TYPE.SHIELD, 100 * ONE_STX)).toBeOk(Cl.uint(ONE_STX / 10));
  });
});

// ===========================================================================
// Fee collection
// ===========================================================================

describe("fee collection", () => {
  it("authorized caller pays fees into the treasury with exact accounting", () => {
    authorizePool();
    const before = stxBalance(pool);
    expect(collect(FEE_TYPE.SHIELD, 5 * ONE_STX).result).toBeOk(Cl.uint(5 * ONE_STX));
    expect(collect(FEE_TYPE.WITHDRAWAL, 3 * ONE_STX).result).toBeOk(Cl.uint(3 * ONE_STX));
    expect(read("get-treasury")).toBeTuple({
      "total-collected": Cl.uint(8 * ONE_STX),
      "total-withdrawn": Cl.uint(0),
      balance: Cl.uint(8 * ONE_STX),
      "actual-balance": Cl.uint(8 * ONE_STX),
    });
    expect(read("get-fee-type-stats", [Cl.uint(FEE_TYPE.SHIELD)])).toBeTuple({
      collected: Cl.uint(5 * ONE_STX),
    });
    expect(stxBalance(pool)).toBe(before - BigInt(8 * ONE_STX));
  });

  it("rejects unauthorized callers -- accounting cannot be inflated", () => {
    expect(collect(FEE_TYPE.SHIELD, ONE_STX, attacker).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED_CALLER)
    );
    expect(collect(FEE_TYPE.SHIELD, ONE_STX, deployer).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED_CALLER)
    );
  });

  it("rejects zero amounts and unknown fee types", () => {
    authorizePool();
    expect(collect(FEE_TYPE.SHIELD, 0).result).toBeErr(Cl.uint(ERR.ZERO_AMOUNT));
    expect(collect(9, ONE_STX).result).toBeErr(Cl.uint(ERR.UNKNOWN_FEE_TYPE));
  });

  it("rejects collection while the protocol is paused", () => {
    authorizePool();
    regCall("pause-protocol", [], deployer);
    expect(collect(FEE_TYPE.SHIELD, ONE_STX).result).toBeErr(
      Cl.uint(REG_ERR.PROTOCOL_PAUSED)
    );
  });
});

// ===========================================================================
// Emergency: fee freeze
// ===========================================================================

describe("emergency: fee freeze", () => {
  it("emergency admin can freeze and unfreeze fee collection", () => {
    authorizePool();
    grantRole(emergencyAdmin, ROLE.EMERGENCY);
    expect(call("freeze-fees", [], emergencyAdmin).result).toBeOk(Cl.bool(true));
    expect(read("is-fees-frozen")).toBeBool(true);
    expect(collect(FEE_TYPE.SHIELD, ONE_STX).result).toBeErr(Cl.uint(ERR.FEES_FROZEN));
    expect(call("unfreeze-fees", [], emergencyAdmin).result).toBeOk(Cl.bool(true));
    expect(collect(FEE_TYPE.SHIELD, ONE_STX).result).toBeOk(Cl.uint(ONE_STX));
  });

  it("only emergency admin or owner control the freeze; no double freeze", () => {
    grantRole(feeAdmin, ROLE.FEE);
    expect(call("freeze-fees", [], feeAdmin).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(call("freeze-fees", [], attacker).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(call("freeze-fees", [], deployer).result).toBeOk(Cl.bool(true));
    expect(call("freeze-fees", [], deployer).result).toBeErr(Cl.uint(ERR.FEES_FROZEN));
    expect(call("unfreeze-fees", [], deployer).result).toBeOk(Cl.bool(true));
    expect(call("unfreeze-fees", [], deployer).result).toBeErr(Cl.uint(ERR.FEES_FROZEN));
  });
});

// ===========================================================================
// Treasury withdrawals
// ===========================================================================

describe("treasury withdrawals", () => {
  const fund = (amount: number) => {
    authorizePool();
    collect(FEE_TYPE.SHIELD, amount);
  };

  it("owner withdraws to a recipient with exact accounting", () => {
    fund(10 * ONE_STX);
    const before = stxBalance(treasuryDest);
    expect(
      call("withdraw-fees", [Cl.uint(4 * ONE_STX), Cl.principal(treasuryDest)], deployer)
        .result
    ).toBeOk(Cl.bool(true));
    expect(stxBalance(treasuryDest)).toBe(before + BigInt(4 * ONE_STX));
    expect(read("get-treasury")).toBeTuple({
      "total-collected": Cl.uint(10 * ONE_STX),
      "total-withdrawn": Cl.uint(4 * ONE_STX),
      balance: Cl.uint(6 * ONE_STX),
      "actual-balance": Cl.uint(6 * ONE_STX),
    });
  });

  it("nobody but the owner can withdraw -- not even the fee admin", () => {
    fund(10 * ONE_STX);
    grantRole(feeAdmin, ROLE.FEE);
    grantRole(emergencyAdmin, ROLE.EMERGENCY);
    for (const who of [feeAdmin, emergencyAdmin, attacker, pool]) {
      expect(
        call("withdraw-fees", [Cl.uint(ONE_STX), Cl.principal(who)], who).result
      ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    }
  });

  it("rejects overdrafts, zero amounts, and the burn address", () => {
    fund(2 * ONE_STX);
    expect(
      call("withdraw-fees", [Cl.uint(3 * ONE_STX), Cl.principal(treasuryDest)], deployer)
        .result
    ).toBeErr(Cl.uint(ERR.INSUFFICIENT_TREASURY));
    expect(
      call("withdraw-fees", [Cl.uint(0), Cl.principal(treasuryDest)], deployer).result
    ).toBeErr(Cl.uint(ERR.ZERO_AMOUNT));
    expect(
      call("withdraw-fees", [Cl.uint(ONE_STX), Cl.principal(BURN)], deployer).result
    ).toBeErr(Cl.uint(ERR.INVALID_RECIPIENT));
  });

  it("treasury freeze blocks even the owner until unfrozen", () => {
    fund(5 * ONE_STX);
    grantRole(emergencyAdmin, ROLE.EMERGENCY);
    call("freeze-treasury", [], emergencyAdmin);
    expect(
      call("withdraw-fees", [Cl.uint(ONE_STX), Cl.principal(treasuryDest)], deployer)
        .result
    ).toBeErr(Cl.uint(ERR.TREASURY_FROZEN));
    call("unfreeze-treasury", [], deployer);
    expect(
      call("withdraw-fees", [Cl.uint(ONE_STX), Cl.principal(treasuryDest)], deployer)
        .result
    ).toBeOk(Cl.bool(true));
  });

  it("treasury withdrawals work while the protocol is paused (funds recovery)", () => {
    fund(5 * ONE_STX);
    regCall("pause-protocol", [], deployer);
    expect(
      call("withdraw-fees", [Cl.uint(ONE_STX), Cl.principal(treasuryDest)], deployer)
        .result
    ).toBeOk(Cl.bool(true));
  });

  it("registry ownership transfer moves treasury control", () => {
    fund(5 * ONE_STX);
    const successor = accounts.get("wallet_7")!;
    regCall("transfer-ownership", [Cl.principal(successor)], deployer);
    regCall("accept-ownership", [], successor);
    expect(
      call("withdraw-fees", [Cl.uint(ONE_STX), Cl.principal(treasuryDest)], deployer)
        .result
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(
      call("withdraw-fees", [Cl.uint(ONE_STX), Cl.principal(treasuryDest)], successor)
        .result
    ).toBeOk(Cl.bool(true));
  });
});

// ===========================================================================
// Randomized accounting property
// ===========================================================================

describe("property: randomized accounting", () => {
  it("treasury accounting equals the sum of all randomized collections", () => {
    authorizePool();
    let seed = 0xacc0;
    const next = () => (seed = (seed * 48271) % 2147483647);
    let expected = 0n;
    const perType: Record<number, bigint> = { 1: 0n, 2: 0n, 3: 0n, 4: 0n };

    for (let i = 0; i < 25; i++) {
      const type = (next() % 4) + 1;
      const amount = (next() % 1000) + 1;
      expect(collect(type, amount).result).toBeOk(Cl.uint(amount));
      expected += BigInt(amount);
      perType[type] += BigInt(amount);
    }
    expect(read("get-treasury")).toBeTuple({
      "total-collected": Cl.uint(expected),
      "total-withdrawn": Cl.uint(0),
      balance: Cl.uint(expected),
      "actual-balance": Cl.uint(expected),
    });
    for (const t of [1, 2, 3, 4]) {
      expect(read("get-fee-type-stats", [Cl.uint(t)])).toBeTuple({
        collected: Cl.uint(perType[t]),
      });
    }
  });
});
