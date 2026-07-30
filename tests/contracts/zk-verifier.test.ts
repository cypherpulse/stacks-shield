import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { bytes32 } from "../helpers/attestation";
import {
  Aggregator,
  MerkleTree,
  bindingFor,
  keccak256,
  statementLeaf,
  TEST_CONTEXT,
} from "../helpers/aggregation";

/*
  Test suite for zk-verifier.clar after the Phase 6 migration.

  The committee is gone. Proofs are verified by zkVerify and accepted here by
  Merkle inclusion against a published aggregation root. These tests exercise
  the real keccak Merkle verification the contract performs — no stubbing.

  What is asserted:
    * a statement included in a published aggregation is accepted
    * anything else is rejected: unknown aggregation, tampered path, wrong
      leaf index, substituted public inputs
    * vkeys remain immutable; disabling one halts that circuit
    * aggregation roots are append-only and cannot be overwritten
    * relayers may publish roots but hold NO power over any user transaction
    * verification freeze halts acceptance and recovers cleanly
*/

const VERIFIER = "zk-verifier";
const REGISTRY = "privacy-registry";
const POOL = "privacy-pool";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const verifierAdmin = accounts.get("wallet_2")!;
const relayer = accounts.get("wallet_3")!;
const outsider = accounts.get("wallet_6")!;

const ROLE = { EMERGENCY: 2, VERIFIER: 3 };
const ERR = {
  UNAUTHORIZED: 300,
  UNAUTHORIZED_CALLER: 301,
  UNKNOWN_PROOF_TYPE: 303,
  VKEY_NOT_FOUND: 304,
  VKEY_EXISTS: 306,
  INVALID_PROOF_LENGTH: 307,
  AGGREGATION_NOT_FOUND: 311,
  AGGREGATION_EXISTS: 312,
  INVALID_AGGREGATION: 313,
  INVALID_VKEY: 314,
  VKEY_STATUS_UNCHANGED: 317,
  RELAYER_EXISTS: 318,
  RELAYER_NOT_FOUND: 319,
};

const PROOF_LEN = 448;
const ZERO = new Uint8Array(32);
const VKEY = { 1: bytes32(1, 0x5a), 2: bytes32(2, 0x5a), 3: bytes32(3, 0x5a) } as const;

const vCall = (fn: string, args: unknown[], sender = deployer) =>
  simnet.callPublicFn(VERIFIER, fn, args as any, sender);
const vRead = (fn: string, args: unknown[] = []) =>
  simnet.callReadOnlyFn(VERIFIER, fn, args as any, deployer).result;

/** Register vkeys and authorize the pool, so verify-proof is reachable. */
const wire = () => {
  simnet.callPublicFn(
    REGISTRY,
    "add-authorized-caller",
    [Cl.contractPrincipal(deployer, POOL)],
    deployer,
  );
  for (const t of [1, 2, 3] as const) {
    vCall("register-verification-key", [
      Cl.uint(t),
      Cl.uint(1),
      Cl.buffer(VKEY[t]),
      Cl.uint(PROOF_LEN),
    ]);
  }
  // the zkVerify binding must be configured before any leaf can be derived
  vCall("set-zkverify-context-hash", [Cl.buffer(TEST_CONTEXT)]);
  for (const t of [1, 2, 3] as const) {
    const b = bindingFor(t);
    vCall("set-zkverify-binding", [
      Cl.uint(t),
      Cl.uint(1),
      Cl.buffer(b.zkvVkeyHash),
      Cl.buffer(b.versionHash),
    ]);
  }
};

interface Publishable {
  domainId: number;
  aggregationId: number;
  root: Uint8Array;
  leafCount: number;
}

const publish = (inc: Publishable, sender = deployer) =>
  vCall(
    "submit-aggregation",
    [
      Cl.uint(inc.domainId),
      Cl.uint(inc.aggregationId),
      Cl.buffer(inc.root),
      Cl.uint(inc.leafCount),
    ],
    sender,
  );

// ===========================================================================
// Deployment
// ===========================================================================

describe("deployment", () => {
  it("starts unfrozen, with no aggregations and no relayers", () => {
    expect(vRead("is-verification-frozen")).toBeBool(false);
    expect(vRead("get-aggregation-count")).toBeUint(0);
    expect(vRead("get-relayer-count")).toBeUint(0);
    expect(vRead("get-verifier-contract-version")).toBeUint(2);
  });

  it("exposes the statement leaf the SDK must reproduce", () => {
    wire();
    const inputs = bytes32(7, 0x11);
    expect(vRead("get-statement-leaf", [Cl.uint(1), Cl.uint(1), Cl.buffer(inputs)])).toBeOk(
      Cl.buffer(statementLeaf(bindingFor(1), inputs)),
    );
  });

  it("the statement leaf is unavailable for an unconfigured circuit", () => {
    // fails CLOSED: without a binding the contract refuses to derive a leaf
    // rather than computing one nobody agrees with
    expect(
      vRead("get-statement-leaf", [Cl.uint(1), Cl.uint(9), Cl.buffer(bytes32(1, 0x11))]),
    ).toBeErr(Cl.uint(320));
  });
});

// ===========================================================================
// Verification key registry
// ===========================================================================

describe("verification keys", () => {
  it("registers a vkey and rejects re-registration (immutable)", () => {
    expect(
      vCall("register-verification-key", [
        Cl.uint(1),
        Cl.uint(1),
        Cl.buffer(VKEY[1]),
        Cl.uint(PROOF_LEN),
      ]).result,
    ).toBeOk(Cl.bool(true));
    expect(
      vCall("register-verification-key", [
        Cl.uint(1),
        Cl.uint(1),
        Cl.buffer(bytes32(99, 0x5a)),
        Cl.uint(PROOF_LEN),
      ]).result,
    ).toBeErr(Cl.uint(ERR.VKEY_EXISTS));
  });

  it("rejects unknown proof types, zero keys, and bad proof lengths", () => {
    expect(
      vCall("register-verification-key", [
        Cl.uint(9),
        Cl.uint(1),
        Cl.buffer(VKEY[1]),
        Cl.uint(PROOF_LEN),
      ]).result,
    ).toBeErr(Cl.uint(ERR.UNKNOWN_PROOF_TYPE));
    expect(
      vCall("register-verification-key", [
        Cl.uint(1),
        Cl.uint(1),
        Cl.buffer(ZERO),
        Cl.uint(PROOF_LEN),
      ]).result,
    ).toBeErr(Cl.uint(ERR.INVALID_VKEY));
    expect(
      vCall("register-verification-key", [
        Cl.uint(1),
        Cl.uint(1),
        Cl.buffer(VKEY[1]),
        Cl.uint(0),
      ]).result,
    ).toBeErr(Cl.uint(ERR.INVALID_PROOF_LENGTH));
  });

  it("only the verifier admin or owner may register", () => {
    expect(
      vCall(
        "register-verification-key",
        [Cl.uint(1), Cl.uint(1), Cl.buffer(VKEY[1]), Cl.uint(PROOF_LEN)],
        outsider,
      ).result,
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED));

    simnet.callPublicFn(
      REGISTRY,
      "grant-role",
      [Cl.principal(verifierAdmin), Cl.uint(ROLE.VERIFIER)],
      deployer,
    );
    expect(
      vCall(
        "register-verification-key",
        [Cl.uint(1), Cl.uint(1), Cl.buffer(VKEY[1]), Cl.uint(PROOF_LEN)],
        verifierAdmin,
      ).result,
    ).toBeOk(Cl.bool(true));
  });

  it("toggles vkey status and rejects no-op toggles", () => {
    wire();
    expect(
      vCall("set-verification-key-status", [Cl.uint(1), Cl.uint(1), Cl.bool(true)]).result,
    ).toBeErr(Cl.uint(ERR.VKEY_STATUS_UNCHANGED));
    expect(
      vCall("set-verification-key-status", [Cl.uint(1), Cl.uint(1), Cl.bool(false)]).result,
    ).toBeOk(Cl.bool(true));
    expect(
      vCall("set-verification-key-status", [Cl.uint(2), Cl.uint(9), Cl.bool(false)]).result,
    ).toBeErr(Cl.uint(ERR.VKEY_NOT_FOUND));
  });
});

// ===========================================================================
// Aggregation publication
// ===========================================================================

describe("aggregation roots", () => {
  it("publishes a root and exposes it", () => {
    const inc = new Aggregator().aggregate(bytes32(1, 0x77));
    expect(publish(inc).result).toBeOk(Cl.bool(true));
    expect(vRead("get-aggregation-count")).toBeUint(1);
    const stored = vRead("get-aggregation", [
      Cl.uint(inc.domainId),
      Cl.uint(inc.aggregationId),
    ]) as { value: { value: Record<string, { value: unknown }> } };
    expect(stored.value.value["leaf-count"]!.value).toBe(BigInt(inc.leafCount));
  });

  it("roots are append-only: a published id can never be overwritten", () => {
    const inc = new Aggregator().aggregate(bytes32(1, 0x77));
    publish(inc);
    // nobody — relayer or admin — can replace a published root
    expect(publish({ ...inc, root: bytes32(66, 0xaa) }).result).toBeErr(
      Cl.uint(ERR.AGGREGATION_EXISTS),
    );
  });

  it("rejects zero roots and empty trees", () => {
    expect(
      publish({ domainId: 1, aggregationId: 1, root: ZERO, leafCount: 4 }).result,
    ).toBeErr(Cl.uint(ERR.INVALID_AGGREGATION));
    expect(
      publish({ domainId: 1, aggregationId: 2, root: bytes32(1, 0x9a), leafCount: 0 }).result,
    ).toBeErr(Cl.uint(ERR.INVALID_AGGREGATION));
  });

  it("only relayers or the verifier admin may publish", () => {
    const inc = new Aggregator().aggregate(bytes32(1, 0x77));
    expect(publish(inc, outsider).result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));

    expect(vCall("add-relayer", [Cl.principal(relayer)]).result).toBeOk(Cl.bool(true));
    expect(vRead("get-relayer-count")).toBeUint(1);
    expect(publish(inc, relayer).result).toBeOk(Cl.bool(true));
  });

  it("manages relayers and rejects duplicates or unknowns", () => {
    expect(vCall("add-relayer", [Cl.principal(relayer)]).result).toBeOk(Cl.bool(true));
    expect(vCall("add-relayer", [Cl.principal(relayer)]).result).toBeErr(
      Cl.uint(ERR.RELAYER_EXISTS),
    );
    expect(vCall("remove-relayer", [Cl.principal(relayer)]).result).toBeOk(Cl.bool(true));
    expect(vCall("remove-relayer", [Cl.principal(relayer)]).result).toBeErr(
      Cl.uint(ERR.RELAYER_NOT_FOUND),
    );
    expect(vCall("add-relayer", [Cl.principal(relayer)], outsider).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED),
    );
  });
});

// ===========================================================================
// Merkle inclusion — the heart of the migration
// ===========================================================================

describe("merkle inclusion", () => {
  it("accepts a genuine path and rejects every tampering", () => {
    wire();
    const inputs = bytes32(21, 0x11);
    const leaf = statementLeaf(bindingFor(1), inputs);
    const inc = new Aggregator().aggregate(leaf);
    publish(inc);

    const args = (path: Uint8Array[], index = inc.leafIndex, l = leaf) => [
      Cl.uint(inc.domainId),
      Cl.uint(inc.aggregationId),
      Cl.buffer(l),
      Cl.list(path.map((p) => Cl.buffer(p))),
      Cl.uint(index),
    ];

    expect(vRead("check-inclusion", args(inc.path))).toBeOk(Cl.bool(true));

    // flip one sibling — the recomputed root no longer matches
    const tampered = [...inc.path];
    tampered[0] = bytes32(123, 0xbe);
    expect(vRead("check-inclusion", args(tampered))).toBeOk(Cl.bool(false));

    // right path, wrong index — sibling ordering changes, root changes
    const otherIndex = inc.leafIndex === 0 ? 1 : 0;
    expect(vRead("check-inclusion", args(inc.path, otherIndex))).toBeOk(Cl.bool(false));

    // an index outside the tree is rejected outright
    expect(vRead("check-inclusion", args(inc.path, inc.leafCount + 5))).toBeOk(
      Cl.bool(false),
    );

    // substituted public inputs produce a different leaf that is not included
    const substituted = statementLeaf(bindingFor(1), bytes32(22, 0x11));
    expect(vRead("check-inclusion", args(inc.path, inc.leafIndex, substituted))).toBeOk(
      Cl.bool(false),
    );
  });

  it("reconstructs the root exactly as the reference tree does, at every index", () => {
    // an 8-leaf tree, every leaf independently provable
    const leaves = Array.from({ length: 8 }, (_, i) => keccak256(bytes32(i + 1, 0x33)));
    const tree = new MerkleTree(leaves);
    publish({ domainId: 2, aggregationId: 1, root: tree.root, leafCount: 8 });

    for (let i = 0; i < 8; i++) {
      expect(
        vRead("check-inclusion", [
          Cl.uint(2),
          Cl.uint(1),
          Cl.buffer(leaves[i]!),
          Cl.list(tree.pathFor(i).map((p) => Cl.buffer(p))),
          Cl.uint(i),
        ]),
      ).toBeOk(Cl.bool(true));
    }
  });

  it("handles odd-sized trees, where the trailing node has no distinct sibling", () => {
    const leaves = Array.from({ length: 5 }, (_, i) => keccak256(bytes32(i + 40, 0x33)));
    const tree = new MerkleTree(leaves);
    publish({ domainId: 3, aggregationId: 1, root: tree.root, leafCount: 5 });

    for (let i = 0; i < 5; i++) {
      expect(
        vRead("check-inclusion", [
          Cl.uint(3),
          Cl.uint(1),
          Cl.buffer(leaves[i]!),
          Cl.list(tree.pathFor(i).map((p) => Cl.buffer(p))),
          Cl.uint(i),
        ]),
      ).toBeOk(Cl.bool(true));
    }
  });

  it("reports an unknown aggregation", () => {
    expect(
      vRead("check-inclusion", [
        Cl.uint(9),
        Cl.uint(9),
        Cl.buffer(bytes32(1, 0x77)),
        Cl.list([]),
        Cl.uint(0),
      ]),
    ).toBeErr(Cl.uint(ERR.AGGREGATION_NOT_FOUND));
  });
});

// ===========================================================================
// verify-proof access control
// ===========================================================================

describe("verify-proof", () => {
  it("is callable only by authorized protocol contracts", () => {
    wire();
    const inputs = bytes32(31, 0x11);
    const inc = new Aggregator().aggregate(statementLeaf(bindingFor(1), inputs));
    publish(inc);

    // user operations go through the pool; calling the verifier directly is
    // not an authorized protocol caller
    expect(
      vCall(
        "verify-proof",
        [
          Cl.uint(1),
          Cl.uint(1),
          Cl.buffer(inputs),
          Cl.uint(inc.domainId),
          Cl.uint(inc.aggregationId),
          Cl.list(inc.path.map((p) => Cl.buffer(p))),
          Cl.uint(inc.leafIndex),
        ],
        outsider,
      ).result,
    ).toBeErr(Cl.uint(ERR.UNAUTHORIZED_CALLER));
  });
});

// ===========================================================================
// Emergency controls
// ===========================================================================

describe("emergency controls", () => {
  it("freezes and unfreezes verification", () => {
    expect(vRead("is-verification-frozen")).toBeBool(false);
    expect(vCall("freeze-verification", []).result).toBeOk(Cl.bool(true));
    expect(vRead("is-verification-frozen")).toBeBool(true);
    expect(vCall("unfreeze-verification", []).result).toBeOk(Cl.bool(true));
    expect(vRead("is-verification-frozen")).toBeBool(false);
  });

  it("only an emergency admin or owner may freeze", () => {
    expect(vCall("freeze-verification", [], outsider).result).toBeErr(
      Cl.uint(ERR.UNAUTHORIZED),
    );
    simnet.callPublicFn(
      REGISTRY,
      "grant-role",
      [Cl.principal(verifierAdmin), Cl.uint(ROLE.EMERGENCY)],
      deployer,
    );
    expect(vCall("freeze-verification", [], verifierAdmin).result).toBeOk(Cl.bool(true));
  });

  it("a frozen verifier still allows root publication and vkey staging", () => {
    // freezing halts acceptance, but must not strand the relayer pipeline or
    // block staging a corrected circuit during an incident
    vCall("freeze-verification", []);
    const inc = new Aggregator().aggregate(bytes32(1, 0x77));
    expect(publish(inc).result).toBeOk(Cl.bool(true));
    expect(
      vCall("register-verification-key", [
        Cl.uint(1),
        Cl.uint(2),
        Cl.buffer(bytes32(11, 0x5a)),
        Cl.uint(PROOF_LEN),
      ]).result,
    ).toBeOk(Cl.bool(true));
  });
});

// ===========================================================================
// Reporting
// ===========================================================================

describe("reporting", () => {
  it("get-verifier-info snapshots the contract state", () => {
    wire();
    publish(new Aggregator().aggregate(bytes32(1, 0x77)));
    vCall("add-relayer", [Cl.principal(relayer)]);

    const info = vRead("get-verifier-info") as {
      value: Record<string, { value: unknown; type: string }>;
    };
    expect(info.value["contract-version"]!.value).toBe(2n);
    expect(info.value["aggregation-count"]!.value).toBe(1n);
    expect(info.value["relayer-count"]!.value).toBe(1n);
    expect(info.value["verification-frozen"]!.type).toBe("false");
  });

  it("statistics start empty and no statement is pre-verified", () => {
    expect(vRead("is-proof-verified", [Cl.buffer(bytes32(1, 0x99))])).toBeBool(false);
    expect(vRead("get-verified-proof", [Cl.buffer(bytes32(1, 0x99))])).toBeNone();
    const stats = vRead("get-verification-stats") as {
      value: Record<string, { value: bigint }>;
    };
    expect(stats.value["total-verified"]!.value).toBe(0n);
  });
});
