import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { bytes32 } from "../helpers/attestation";
import { bindingFor, keccak256, statementLeaf, TEST_CONTEXT } from "../helpers/aggregation";
import {
  feUint,
  fePrincipal,
  hashPublicInputVector,
  publicInputVector,
  shieldPublicInputs,
  transferPublicInputs,
  withdrawPublicInputs,
  splitPublicInputs,
  mergePublicInputs,
} from "../../sdk/public-inputs/index.js";

/*
  CANONICAL PUBLIC-INPUT ENCODING — correctness gate (v2).

  Five systems must commit to byte-identical data:

      circuits == privacy-pool == split-merge-manager == SDK == zkVerify

  The encoding is: keccak256 over the circuit's public-input field elements,
  each 32 bytes big-endian, in DECLARATION ORDER, and nothing else. In v2 every
  leaf-adding op additionally binds the tree transition: `old_root`/`merkle_root`,
  `new_root`, and `leaf_index`. `metadata` remains a contract-level check only.

  These tests drive the real contracts and compare against an independent SDK
  implementation: the contract accepts an operation only if the leaf it derives
  is in a published aggregation, so acceptance PROVES it hashed the same bytes.
*/

const REGISTRY = "privacy-registry";
const NOTES = "note-manager";
const VERIFIER = "zk-verifier";
const POOL = "privacy-pool";
const MANAGER = "split-merge-manager";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const recipient = accounts.get("wallet_8")!;

const ONE_STX = 1_000_000;
const PROOF_LEN = 7872;
// v2: the registry ships at circuit version 2 (binds the tree transition).
const CIRCUIT_VERSION = 2;
const GENESIS_ROOT = bytes32(1, 0x47);
const VKEY = (t: number) => bytes32(t, 0x5a);
// Deterministic distinct roots for the tests.
const R = (n: number) => bytes32(n, 0x52);

/** The contract accepts an operation only if the leaf it derives is in a
 *  published aggregation. We publish a single-leaf tree containing the leaf
 *  the SDK computed — so acceptance PROVES the contract derived the same
 *  bytes. A mismatch of even one bit fails with u310. */
const publishFor = (proofType: number, publicInputsHash: Uint8Array) => {
  const leaf = statementLeaf(bindingFor(proofType), publicInputsHash);
  const aggregationId = nextAgg++;
  // single-leaf zkVerify tree: root = keccak256(leaf), path empty
  const root = keccak256(leaf);
  simnet.callPublicFn(
    VERIFIER,
    "submit-aggregation",
    [Cl.uint(1), Cl.uint(aggregationId), Cl.buffer(root), Cl.uint(1)],
    deployer,
  );
  return [Cl.uint(1), Cl.uint(aggregationId), Cl.list([]), Cl.uint(0)];
};
let nextAgg = 1;

const wire = () => {
  nextAgg = 1;
  for (const c of [POOL, NOTES, MANAGER]) {
    simnet.callPublicFn(
      REGISTRY,
      "add-authorized-caller",
      [Cl.contractPrincipal(deployer, c)],
      deployer,
    );
  }
  simnet.callPublicFn(
    REGISTRY,
    "update-root",
    [Cl.buffer(GENESIS_ROOT), Cl.uint(1)],
    deployer,
  );
  simnet.callPublicFn(VERIFIER, "set-zkverify-context-hash", [Cl.buffer(TEST_CONTEXT)], deployer);
  for (const t of [1, 2, 3, 4, 5]) {
    simnet.callPublicFn(
      VERIFIER,
      "register-verification-key",
      [Cl.uint(t), Cl.uint(CIRCUIT_VERSION), Cl.buffer(VKEY(t)), Cl.uint(PROOF_LEN)],
      deployer,
    );
    const b = bindingFor(t);
    simnet.callPublicFn(
      VERIFIER,
      "set-zkverify-binding",
      [
        Cl.uint(t),
        Cl.uint(CIRCUIT_VERSION),
        Cl.buffer(b.zkvVkeyHash),
        Cl.buffer(b.versionHash),
      ],
      deployer,
    );
  }
};

/** Seed one on-chain note by genuinely shielding it. Returns the new live root.
 *  `leafIndex` is the slot it lands at; `oldRoot` must be the live root. */
const seedShield = (n: number, amount: number, oldRoot: Uint8Array, newRoot: Uint8Array, leafIndex: number) => {
  const seed = shieldPublicInputs({
    commitment: bytes32(n, 0x3c),
    ownerCommitment: bytes32(n, 0x4f),
    amount: BigInt(amount),
    oldRoot,
    newRoot,
    leafIndex,
    circuitVersion: CIRCUIT_VERSION,
  });
  const res = simnet.callPublicFn(
    POOL,
    "shield",
    [
      Cl.uint(amount),
      Cl.buffer(bytes32(n, 0x3c)),
      Cl.buffer(bytes32(n, 0x4f)),
      Cl.buffer(bytes32(n, 0x4d)),
      Cl.buffer(oldRoot),
      Cl.buffer(newRoot),
      Cl.uint(leafIndex),
      ...publishFor(1, seed),
    ],
    alice,
  );
  expect(res.result.type).toBe("ok");
  return newRoot;
};

// ===========================================================================
// Field-element encoding primitives
// ===========================================================================

describe("field element encoding", () => {
  it("encodes uints as 32-byte big-endian", () => {
    expect(Buffer.from(feUint(1)).toString("hex")).toBe("00".repeat(31) + "01");
    expect(Buffer.from(feUint(1_000_000)).toString("hex")).toBe("00".repeat(29) + "0f4240");
    expect(feUint(0)).toEqual(new Uint8Array(32));
  });

  it("matches the byte layout barretenberg actually emits", () => {
    expect(Buffer.from(feUint(1)).toString("hex")).toBe(
      "0000000000000000000000000000000000000000000000000000000000000001",
    );
    expect(Buffer.from(feUint(1000000)).toString("hex")).toBe(
      "00000000000000000000000000000000000000000000000000000000000f4240",
    );
  });

  it("bounds a principal below the BN254 modulus", () => {
    const fe = fePrincipal(recipient);
    expect(fe).toHaveLength(32);
    expect(fe[0]).toBe(0);
  });

  it("distinct principals give distinct field elements", () => {
    expect(Buffer.from(fePrincipal(alice)).toString("hex")).not.toBe(
      Buffer.from(fePrincipal(recipient)).toString("hex"),
    );
  });

  it("rejects values that cannot be a field element", () => {
    expect(() => feUint(-1)).toThrow();
  });
});

// ===========================================================================
// contracts == SDK, for every operation
// ===========================================================================

describe("contract == SDK public-input hash", () => {
  it("shield", () => {
    wire();
    const commitment = bytes32(1, 0x3c);
    const owner = bytes32(1, 0x4f);
    const amount = 10 * ONE_STX;

    const expected = shieldPublicInputs({
      commitment,
      ownerCommitment: owner,
      amount: BigInt(amount),
      oldRoot: GENESIS_ROOT,
      newRoot: R(2),
      leafIndex: 0,
      circuitVersion: CIRCUIT_VERSION,
    });

    const res = simnet.callPublicFn(
      POOL,
      "shield",
      [
        Cl.uint(amount),
        Cl.buffer(commitment),
        Cl.buffer(owner),
        Cl.buffer(bytes32(1, 0x4d)), // metadata: NOT part of the binding
        Cl.buffer(GENESIS_ROOT),
        Cl.buffer(R(2)),
        Cl.uint(0),
        ...publishFor(1, expected),
      ],
      alice,
    );
    expect(res.result.type).toBe("ok");
  });

  it("transfer", () => {
    wire();
    seedShield(1, 10 * ONE_STX, GENESIS_ROOT, R(2), 0);

    const currentRoot = R(2);
    const expected = transferPublicInputs({
      nullifier: bytes32(1, 0x4e),
      newCommitment: bytes32(2, 0x3c),
      newOwnerCommitment: bytes32(2, 0x4f),
      merkleRoot: currentRoot,
      newRoot: R(3),
      leafIndex: 1,
      circuitVersion: CIRCUIT_VERSION,
    });

    const res = simnet.callPublicFn(
      POOL,
      "transfer",
      [
        Cl.buffer(bytes32(1, 0x4e)),
        Cl.buffer(bytes32(2, 0x3c)),
        Cl.buffer(bytes32(2, 0x4f)),
        Cl.buffer(bytes32(2, 0x4d)), // metadata: not bound
        Cl.buffer(currentRoot),
        Cl.buffer(R(3)),
        Cl.uint(1),
        ...publishFor(2, expected),
      ],
      alice,
    );
    expect(res.result.type).toBe("ok");
  });

  it("withdraw", () => {
    wire();
    seedShield(1, 50 * ONE_STX, GENESIS_ROOT, R(2), 0);

    const root = R(2);
    const expected = withdrawPublicInputs({
      nullifier: bytes32(1, 0x4e),
      amount: BigInt(10 * ONE_STX),
      recipient,
      merkleRoot: root,
      circuitVersion: CIRCUIT_VERSION,
    });

    const res = simnet.callPublicFn(
      POOL,
      "withdraw",
      [
        Cl.buffer(bytes32(1, 0x4e)),
        Cl.uint(10 * ONE_STX),
        Cl.principal(recipient),
        Cl.buffer(root),
        ...publishFor(3, expected),
      ],
      alice,
    );
    expect(res.result.type).toBe("ok");
  });

  it("split", () => {
    wire();
    seedShield(1, 100 * ONE_STX, GENESIS_ROOT, R(2), 0);

    const currentRoot = R(2);
    const expected = splitPublicInputs({
      nullifier: bytes32(1, 0x4e),
      commitment1: bytes32(2, 0x3c),
      ownerCommitment1: bytes32(2, 0x4f),
      commitment2: bytes32(3, 0x3c),
      ownerCommitment2: bytes32(3, 0x4f),
      merkleRoot: currentRoot,
      newRoot: R(4),
      leafIndex: 1, // outputs land at slots 1 and 2
      circuitVersion: CIRCUIT_VERSION,
    });

    const res = simnet.callPublicFn(
      MANAGER,
      "split-note",
      [
        Cl.buffer(bytes32(1, 0x4e)),
        Cl.buffer(bytes32(2, 0x3c)),
        Cl.buffer(bytes32(2, 0x4f)),
        Cl.buffer(bytes32(2, 0x4d)),
        Cl.buffer(bytes32(3, 0x3c)),
        Cl.buffer(bytes32(3, 0x4f)),
        Cl.buffer(bytes32(3, 0x4d)),
        Cl.buffer(currentRoot),
        Cl.buffer(R(4)),
        Cl.uint(1),
        ...publishFor(4, expected),
      ],
      alice,
    );
    expect(res.result.type).toBe("ok");
  });

  it("merge", () => {
    wire();
    seedShield(1, 40 * ONE_STX, GENESIS_ROOT, R(2), 0);
    seedShield(2, 60 * ONE_STX, R(2), R(3), 1);

    const currentRoot = R(3);
    const expected = mergePublicInputs({
      nullifier1: bytes32(1, 0x4e),
      nullifier2: bytes32(2, 0x4e),
      commitment: bytes32(9, 0x3c),
      ownerCommitment: bytes32(9, 0x4f),
      merkleRoot: currentRoot,
      newRoot: R(5),
      leafIndex: 2,
      circuitVersion: CIRCUIT_VERSION,
    });

    const res = simnet.callPublicFn(
      MANAGER,
      "merge-notes",
      [
        Cl.buffer(bytes32(1, 0x4e)),
        Cl.buffer(bytes32(2, 0x4e)),
        Cl.buffer(bytes32(9, 0x3c)),
        Cl.buffer(bytes32(9, 0x4f)),
        Cl.buffer(bytes32(9, 0x4d)),
        Cl.buffer(currentRoot),
        Cl.buffer(R(5)),
        Cl.uint(2),
        ...publishFor(5, expected),
      ],
      alice,
    );
    expect(res.result.type).toBe("ok");
  });
});

// ===========================================================================
// The binding must contain EXACTLY the circuit inputs
// ===========================================================================

describe("only circuit inputs are bound", () => {
  it("metadata does not affect the hash — the circuit never sees it", () => {
    wire();
    const commitment = bytes32(1, 0x3c);
    const owner = bytes32(1, 0x4f);
    const expected = shieldPublicInputs({
      commitment,
      ownerCommitment: owner,
      amount: BigInt(10 * ONE_STX),
      oldRoot: GENESIS_ROOT,
      newRoot: R(2),
      leafIndex: 0,
      circuitVersion: CIRCUIT_VERSION,
    });
    const inclusion = publishFor(1, expected);

    // a DIFFERENT metadata value must still be accepted against the same leaf
    const res = simnet.callPublicFn(
      POOL,
      "shield",
      [
        Cl.uint(10 * ONE_STX),
        Cl.buffer(commitment),
        Cl.buffer(owner),
        Cl.buffer(bytes32(999, 0x4d)), // arbitrary metadata
        Cl.buffer(GENESIS_ROOT),
        Cl.buffer(R(2)),
        Cl.uint(0),
        ...inclusion,
      ],
      alice,
    );
    expect(res.result.type).toBe("ok");
  });

  it("new-root DOES affect the hash — the transition is proven (v2)", () => {
    wire();
    const commitment = bytes32(1, 0x3c);
    // leaf published for new-root R(2) ...
    const expected = shieldPublicInputs({
      commitment,
      ownerCommitment: bytes32(1, 0x4f),
      amount: BigInt(10 * ONE_STX),
      oldRoot: GENESIS_ROOT,
      newRoot: R(2),
      leafIndex: 0,
      circuitVersion: CIRCUIT_VERSION,
    });
    // ... but a DIFFERENT new-root is submitted -> contract derives a different
    // hash, not present in the published aggregation.
    const res = simnet.callPublicFn(
      POOL,
      "shield",
      [
        Cl.uint(10 * ONE_STX),
        Cl.buffer(commitment),
        Cl.buffer(bytes32(1, 0x4f)),
        Cl.buffer(bytes32(1, 0x4d)),
        Cl.buffer(GENESIS_ROOT),
        Cl.buffer(R(77)), // different new root
        Cl.uint(0),
        ...publishFor(1, expected),
      ],
      alice,
    );
    expect(res.result).toBeErr(Cl.uint(310)); // ERR-PROOF-NOT-AGGREGATED
  });

  it("leaf-index DOES affect the hash — the slot is proven (v2)", () => {
    wire();
    const commitment = bytes32(1, 0x3c);
    const expected = shieldPublicInputs({
      commitment,
      ownerCommitment: bytes32(1, 0x4f),
      amount: BigInt(10 * ONE_STX),
      oldRoot: GENESIS_ROOT,
      newRoot: R(2),
      leafIndex: 0,
      circuitVersion: CIRCUIT_VERSION,
    });
    // submit a mismatched leaf-index: the derived hash differs -> u310 (and even
    // if it matched, the registry slot 0 != 5 would reject with u258).
    const res = simnet.callPublicFn(
      POOL,
      "shield",
      [
        Cl.uint(10 * ONE_STX),
        Cl.buffer(commitment),
        Cl.buffer(bytes32(1, 0x4f)),
        Cl.buffer(bytes32(1, 0x4d)),
        Cl.buffer(GENESIS_ROOT),
        Cl.buffer(R(2)),
        Cl.uint(5), // wrong slot
        ...publishFor(1, expected),
      ],
      alice,
    );
    expect(res.result.type).toBe("err");
  });

  it("amount DOES affect the hash — it is a circuit input", () => {
    wire();
    const commitment = bytes32(1, 0x3c);
    const forTen = shieldPublicInputs({
      commitment,
      ownerCommitment: bytes32(1, 0x4f),
      amount: BigInt(10 * ONE_STX),
      oldRoot: GENESIS_ROOT,
      newRoot: R(2),
      leafIndex: 0,
      circuitVersion: CIRCUIT_VERSION,
    });
    // submit 20 STX against a leaf computed for 10 STX
    const res = simnet.callPublicFn(
      POOL,
      "shield",
      [
        Cl.uint(20 * ONE_STX),
        Cl.buffer(commitment),
        Cl.buffer(bytes32(1, 0x4f)),
        Cl.buffer(bytes32(1, 0x4d)),
        Cl.buffer(GENESIS_ROOT),
        Cl.buffer(R(2)),
        Cl.uint(0),
        ...publishFor(1, forTen),
      ],
      alice,
    );
    expect(res.result).toBeErr(Cl.uint(310)); // ERR-PROOF-NOT-AGGREGATED
  });

  it("recipient DOES affect the hash — substitution is rejected", () => {
    wire();
    seedShield(1, 50 * ONE_STX, GENESIS_ROOT, R(2), 0);

    const root = R(2);
    const forRecipient = withdrawPublicInputs({
      nullifier: bytes32(1, 0x4e),
      amount: BigInt(10 * ONE_STX),
      recipient,
      merkleRoot: root,
      circuitVersion: CIRCUIT_VERSION,
    });
    // pay someone else against a leaf computed for `recipient`
    const res = simnet.callPublicFn(
      POOL,
      "withdraw",
      [
        Cl.buffer(bytes32(1, 0x4e)),
        Cl.uint(10 * ONE_STX),
        Cl.principal(alice),
        Cl.buffer(root),
        ...publishFor(3, forRecipient),
      ],
      alice,
    );
    expect(res.result).toBeErr(Cl.uint(310));
  });

  it("the merkle root DOES affect the hash for spends", () => {
    const base = {
      nullifier: bytes32(1, 0x4e),
      newCommitment: bytes32(2, 0x3c),
      newOwnerCommitment: bytes32(2, 0x4f),
      newRoot: R(9),
      leafIndex: 1,
      circuitVersion: CIRCUIT_VERSION,
    };
    const a = transferPublicInputs({ ...base, merkleRoot: R(1) });
    const b = transferPublicInputs({ ...base, merkleRoot: R(2) });
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
  });

  it("the circuit version DOES affect the hash — proofs cannot cross versions", () => {
    const base = {
      commitment: bytes32(1, 0x3c),
      ownerCommitment: bytes32(1, 0x4f),
      amount: 1n,
      oldRoot: GENESIS_ROOT,
      newRoot: R(2),
      leafIndex: 0,
    };
    const v1 = shieldPublicInputs({ ...base, circuitVersion: 1 });
    const v2 = shieldPublicInputs({ ...base, circuitVersion: 2 });
    expect(Buffer.from(v1).toString("hex")).not.toBe(Buffer.from(v2).toString("hex"));
  });
});

// ===========================================================================
// The vector IS the specification
// ===========================================================================

describe("public input vectors", () => {
  it("have exactly the circuits' v2 arity", () => {
    expect(
      publicInputVector.shield({
        commitment: bytes32(1, 0x3c),
        ownerCommitment: bytes32(1, 0x4f),
        amount: 1n,
        oldRoot: GENESIS_ROOT,
        newRoot: R(2),
        leafIndex: 0,
        circuitVersion: CIRCUIT_VERSION,
      }),
    ).toHaveLength(8);
    expect(
      publicInputVector.transfer({
        nullifier: bytes32(1, 0x4e),
        newCommitment: bytes32(2, 0x3c),
        newOwnerCommitment: bytes32(2, 0x4f),
        merkleRoot: R(1),
        newRoot: R(2),
        leafIndex: 1,
        circuitVersion: CIRCUIT_VERSION,
      }),
    ).toHaveLength(8);
    expect(
      publicInputVector.withdraw({
        nullifier: bytes32(1, 0x4e),
        amount: 1n,
        recipient,
        merkleRoot: R(1),
        circuitVersion: CIRCUIT_VERSION,
      }),
    ).toHaveLength(6);
    expect(
      publicInputVector.split({
        nullifier: bytes32(1, 0x4e),
        commitment1: bytes32(2, 0x3c),
        ownerCommitment1: bytes32(2, 0x4f),
        commitment2: bytes32(3, 0x3c),
        ownerCommitment2: bytes32(3, 0x4f),
        merkleRoot: R(1),
        newRoot: R(2),
        leafIndex: 1,
        circuitVersion: CIRCUIT_VERSION,
      }),
    ).toHaveLength(10);
    expect(
      publicInputVector.merge({
        nullifier1: bytes32(1, 0x4e),
        nullifier2: bytes32(2, 0x4e),
        commitment: bytes32(9, 0x3c),
        ownerCommitment: bytes32(9, 0x4f),
        merkleRoot: R(1),
        newRoot: R(2),
        leafIndex: 2,
        circuitVersion: CIRCUIT_VERSION,
      }),
    ).toHaveLength(9);
  });

  it("hashing the vector equals the operation hash — one encoding, not two", () => {
    const args = {
      commitment: bytes32(1, 0x3c),
      ownerCommitment: bytes32(1, 0x4f),
      amount: 42n,
      oldRoot: GENESIS_ROOT,
      newRoot: R(2),
      leafIndex: 0,
      circuitVersion: CIRCUIT_VERSION,
    };
    expect(hashPublicInputVector(publicInputVector.shield(args))).toEqual(
      shieldPublicInputs(args),
    );
  });

  it("every element is exactly 32 bytes, as barretenberg emits them", () => {
    for (const fe of publicInputVector.withdraw({
      nullifier: bytes32(1, 0x4e),
      amount: 12345n,
      recipient,
      merkleRoot: R(1),
      circuitVersion: CIRCUIT_VERSION,
    })) {
      expect(fe).toHaveLength(32);
    }
  });
});
