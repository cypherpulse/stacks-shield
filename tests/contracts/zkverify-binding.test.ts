import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytes32 } from "../helpers/attestation";

/*
  PRIORITY 1 — zkVerify statement-leaf binding.

  The gate for this whole phase:

      contract statement leaf == SDK statement leaf == zkVerify statement leaf

  The first two are asserted here against the deployed contract. The third is
  asserted at runtime by ZkVerifyProvider.prove(), which compares the leaf
  zkVerify returns with the locally computed one and throws on mismatch.

  The construction is:

      keccak256( contextHash || zkvVkeyHash || versionHash || publicInputsHash )

  All three binding components are OBSERVED from zkVerify and stored as
  configuration. The previous code guessed them and was wrong; these tests
  exist so a wrong value can never pass silently again.
*/

const VERIFIER = "zk-verifier";
const REGISTRY = "privacy-registry";
const POOL = "privacy-pool";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const outsider = accounts.get("wallet_6")!;

const ERR = {
  UNAUTHORIZED: 300,
  UNKNOWN_PROOF_TYPE: 303,
  VKEY_NOT_FOUND: 304,
  BINDING_NOT_SET: 320,
  INVALID_BINDING: 321,
};

const PROOF_LEN = 7872;
const VKEY = bytes32(1, 0x5a);
const CONTEXT = bytes32(11, 0xc0);
const ZKV_VKEY = bytes32(22, 0xd0);
const VERSION = bytes32(33, 0xe0);

const vCall = (fn: string, args: unknown[], sender = deployer) =>
  simnet.callPublicFn(VERIFIER, fn, args as never, sender);
const vRead = (fn: string, args: unknown[] = []) =>
  simnet.callReadOnlyFn(VERIFIER, fn, args as never, deployer).result;

const cat = (...a: Uint8Array[]) => {
  const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let i = 0;
  for (const x of a) {
    out.set(x, i);
    i += x.length;
  }
  return out;
};

/** The SDK's construction, reproduced independently of the contract. */
const sdkStatementLeaf = (
  contextHash: Uint8Array,
  zkvVkeyHash: Uint8Array,
  versionHash: Uint8Array,
  publicInputsHash: Uint8Array,
): Uint8Array =>
  new Uint8Array(
    keccak_256(cat(cat(contextHash, zkvVkeyHash), cat(versionHash, publicInputsHash))),
  );

const wire = () => {
  simnet.callPublicFn(
    REGISTRY,
    "add-authorized-caller",
    [Cl.contractPrincipal(deployer, POOL)],
    deployer,
  );
  vCall("register-verification-key", [Cl.uint(1), Cl.uint(1), Cl.buffer(VKEY), Cl.uint(PROOF_LEN)]);
};

const configure = () => {
  vCall("set-zkverify-context-hash", [Cl.buffer(CONTEXT)]);
  vCall("set-zkverify-binding", [
    Cl.uint(1),
    Cl.uint(1),
    Cl.buffer(ZKV_VKEY),
    Cl.buffer(VERSION),
  ]);
};

// ===========================================================================
// The gate
// ===========================================================================

describe("statement leaf: contract == SDK", () => {
  it("produces byte-identical leaves for the same binding and inputs", () => {
    wire();
    configure();
    const inputs = bytes32(77, 0x11);

    const onChain = vRead("get-statement-leaf", [Cl.uint(1), Cl.uint(1), Cl.buffer(inputs)]);
    const local = sdkStatementLeaf(CONTEXT, ZKV_VKEY, VERSION, inputs);

    expect(onChain).toBeOk(Cl.buffer(local));
  });

  it("agrees across many independent inputs, not just one", () => {
    wire();
    configure();
    for (let i = 1; i <= 12; i++) {
      const inputs = bytes32(i * 13, 0x11);
      expect(vRead("get-statement-leaf", [Cl.uint(1), Cl.uint(1), Cl.buffer(inputs)])).toBeOk(
        Cl.buffer(sdkStatementLeaf(CONTEXT, ZKV_VKEY, VERSION, inputs)),
      );
    }
  });
});

// ===========================================================================
// Every component must matter — a wrong one must change the leaf
// ===========================================================================

describe("binding components are all load-bearing", () => {
  it("a wrong verifier context produces a different leaf", () => {
    wire();
    configure();
    const inputs = bytes32(5, 0x11);
    const correct = sdkStatementLeaf(CONTEXT, ZKV_VKEY, VERSION, inputs);
    const wrong = sdkStatementLeaf(bytes32(99, 0xc0), ZKV_VKEY, VERSION, inputs);
    expect(Buffer.from(wrong).toString("hex")).not.toBe(Buffer.from(correct).toString("hex"));
    expect(vRead("get-statement-leaf", [Cl.uint(1), Cl.uint(1), Cl.buffer(inputs)])).toBeOk(
      Cl.buffer(correct),
    );
  });

  it("a wrong zkVerify vk hash produces a different leaf", () => {
    const inputs = bytes32(6, 0x11);
    expect(
      Buffer.from(sdkStatementLeaf(CONTEXT, bytes32(98, 0xd0), VERSION, inputs)).toString("hex"),
    ).not.toBe(Buffer.from(sdkStatementLeaf(CONTEXT, ZKV_VKEY, VERSION, inputs)).toString("hex"));
  });

  it("a wrong version hash produces a different leaf", () => {
    const inputs = bytes32(7, 0x11);
    expect(
      Buffer.from(sdkStatementLeaf(CONTEXT, ZKV_VKEY, bytes32(97, 0xe0), inputs)).toString("hex"),
    ).not.toBe(Buffer.from(sdkStatementLeaf(CONTEXT, ZKV_VKEY, VERSION, inputs)).toString("hex"));
  });

  it("a wrong public-inputs hash produces a different leaf", () => {
    wire();
    configure();
    const a = vRead("get-statement-leaf", [Cl.uint(1), Cl.uint(1), Cl.buffer(bytes32(8, 0x11))]);
    const b = vRead("get-statement-leaf", [Cl.uint(1), Cl.uint(1), Cl.buffer(bytes32(9, 0x11))]);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("the barretenberg vk_hash is NOT the binding -- using it gives a different leaf", () => {
    // The original bug: bb's vk_hash was assumed to be zkVerify's. It is not.
    const inputs = bytes32(10, 0x11);
    expect(
      Buffer.from(sdkStatementLeaf(CONTEXT, VKEY, VERSION, inputs)).toString("hex"),
    ).not.toBe(Buffer.from(sdkStatementLeaf(CONTEXT, ZKV_VKEY, VERSION, inputs)).toString("hex"));
  });
});

// ===========================================================================
// Fail closed
// ===========================================================================

describe("unconfigured bindings fail closed", () => {
  it("no leaf can be computed before the binding is set", () => {
    wire();
    expect(
      vRead("get-statement-leaf", [Cl.uint(1), Cl.uint(1), Cl.buffer(bytes32(1, 0x11))]),
    ).toBeErr(Cl.uint(ERR.BINDING_NOT_SET));
  });

  it("reports readiness accurately", () => {
    wire();
    expect(vRead("is-binding-ready", [Cl.uint(1), Cl.uint(1)])).toBeBool(false);
    configure();
    expect(vRead("is-binding-ready", [Cl.uint(1), Cl.uint(1)])).toBeBool(true);
    // a circuit version with no binding is still not ready
    expect(vRead("is-binding-ready", [Cl.uint(1), Cl.uint(9)])).toBeBool(false);
  });

  it("context alone is not enough", () => {
    wire();
    vCall("set-zkverify-context-hash", [Cl.buffer(CONTEXT)]);
    expect(vRead("is-binding-ready", [Cl.uint(1), Cl.uint(1)])).toBeBool(false);
    expect(
      vRead("get-statement-leaf", [Cl.uint(1), Cl.uint(1), Cl.buffer(bytes32(1, 0x11))]),
    ).toBeErr(Cl.uint(ERR.BINDING_NOT_SET));
  });
});

// ===========================================================================
// Configuration access control and validation
// ===========================================================================

describe("binding configuration", () => {
  it("only the verifier admin or owner may set the context", () => {
    expect(
      vCall("set-zkverify-context-hash", [Cl.buffer(CONTEXT)], outsider).result,
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
    expect(vCall("set-zkverify-context-hash", [Cl.buffer(CONTEXT)]).result).toBeOk(Cl.bool(true));
  });

  it("only the verifier admin or owner may set a binding", () => {
    wire();
    expect(
      vCall(
        "set-zkverify-binding",
        [Cl.uint(1), Cl.uint(1), Cl.buffer(ZKV_VKEY), Cl.buffer(VERSION)],
        outsider,
      ).result,
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
  });

  it("rejects zero hashes -- a zero binding would silently break the leaf", () => {
    wire();
    const ZERO = new Uint8Array(32);
    expect(vCall("set-zkverify-context-hash", [Cl.buffer(ZERO)]).result).toBeErr(
      Cl.uint(ERR.INVALID_BINDING),
    );
    expect(
      vCall("set-zkverify-binding", [
        Cl.uint(1),
        Cl.uint(1),
        Cl.buffer(ZERO),
        Cl.buffer(VERSION),
      ]).result,
    ).toBeErr(Cl.uint(ERR.INVALID_BINDING));
    expect(
      vCall("set-zkverify-binding", [
        Cl.uint(1),
        Cl.uint(1),
        Cl.buffer(ZKV_VKEY),
        Cl.buffer(ZERO),
      ]).result,
    ).toBeErr(Cl.uint(ERR.INVALID_BINDING));
  });

  it("refuses a binding for a circuit that has no verification key", () => {
    expect(
      vCall("set-zkverify-binding", [
        Cl.uint(1),
        Cl.uint(7),
        Cl.buffer(ZKV_VKEY),
        Cl.buffer(VERSION),
      ]).result,
    ).toBeErr(Cl.uint(ERR.VKEY_NOT_FOUND));
  });

  it("rejects unknown proof types", () => {
    expect(
      vCall("set-zkverify-binding", [
        Cl.uint(9),
        Cl.uint(1),
        Cl.buffer(ZKV_VKEY),
        Cl.buffer(VERSION),
      ]).result,
    ).toBeErr(Cl.uint(ERR.UNKNOWN_PROOF_TYPE));
  });

  it("a binding is correctable -- a wrong observation must not be permanent", () => {
    wire();
    configure();
    const corrected = bytes32(44, 0xd0);
    expect(
      vCall("set-zkverify-binding", [
        Cl.uint(1),
        Cl.uint(1),
        Cl.buffer(corrected),
        Cl.buffer(VERSION),
      ]).result,
    ).toBeOk(Cl.bool(true));
    const inputs = bytes32(3, 0x11);
    expect(vRead("get-statement-leaf", [Cl.uint(1), Cl.uint(1), Cl.buffer(inputs)])).toBeOk(
      Cl.buffer(sdkStatementLeaf(CONTEXT, corrected, VERSION, inputs)),
    );
  });

  it("exposes the stored binding for operator verification", () => {
    wire();
    configure();
    const stored = vRead("get-zkverify-binding", [Cl.uint(1), Cl.uint(1)]) as {
      value: { value: Record<string, unknown> };
    };
    const fields = stored.value.value;
    expect(fields["zkv-vkey-hash"]).toStrictEqual(Cl.buffer(ZKV_VKEY));
    expect(fields["version-hash"]).toStrictEqual(Cl.buffer(VERSION));
  });
});
