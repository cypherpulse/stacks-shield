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
  CANONICAL PUBLIC-INPUT ENCODING — correctness gate.

  Five systems must commit to byte-identical data:

      circuits == privacy-pool == split-merge-manager == SDK == zkVerify

  The encoding is: keccak256 over the circuit's public-input field elements,
  each 32 bytes big-endian, in DECLARATION ORDER, and nothing else.

  These tests drive the real contracts and compare against an independent SDK
  implementation. The previous construction (sha256 over a Clarity tuple that
  also contained metadata and roots) is exactly what these catch.
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
const CIRCUIT_VERSION = 1;
const GENESIS_ROOT = bytes32(1, 0x47);
const VKEY = (t: number) => bytes32(t, 0x5a);

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
    // Observed from a real `public_inputs` file: op=1 and amount=1000000
    // appear as 32-byte big-endian values.
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
    // top byte zeroed => value < 2^248 < p, so it is always a valid field element
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
        Cl.buffer(bytes32(2, 0x52)), // new root: NOT part of the binding
        ...publishFor(1, expected),
      ],
      alice,
    );
    // acceptance proves the contract derived exactly `expected`
    expect(res.result.type).toBe("ok");
  });

  it("transfer", () => {
    wire();
    // seed a note
    const c0 = bytes32(1, 0x3c);
    const seed = shieldPublicInputs({
      commitment: c0,
      ownerCommitment: bytes32(1, 0x4f),
      amount: BigInt(10 * ONE_STX),
      circuitVersion: CIRCUIT_VERSION,
    });
    simnet.callPublicFn(
      POOL,
      "shield",
      [
        Cl.uint(10 * ONE_STX),
        Cl.buffer(c0),
        Cl.buffer(bytes32(1, 0x4f)),
        Cl.buffer(bytes32(1, 0x4d)),
        Cl.buffer(GENESIS_ROOT),
        Cl.buffer(bytes32(2, 0x52)),
        ...publishFor(1, seed),
      ],
      alice,
    );

    const currentRoot = bytes32(2, 0x52);
    const expected = transferPublicInputs({
      nullifier: bytes32(1, 0x4e),
      newCommitment: bytes32(2, 0x3c),
      newOwnerCommitment: bytes32(2, 0x4f),
      merkleRoot: currentRoot,
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
        Cl.buffer(bytes32(3, 0x52)), // new root: not bound
        ...publishFor(2, expected),
      ],
      alice,
    );
    expect(res.result.type).toBe("ok");
  });

  it("withdraw", () => {
    wire();
    const c0 = bytes32(1, 0x3c);
    const seed = shieldPublicInputs({
      commitment: c0,
      ownerCommitment: bytes32(1, 0x4f),
      amount: BigInt(50 * ONE_STX),
      circuitVersion: CIRCUIT_VERSION,
    });
    simnet.callPublicFn(
      POOL,
      "shield",
      [
        Cl.uint(50 * ONE_STX),
        Cl.buffer(c0),
        Cl.buffer(bytes32(1, 0x4f)),
        Cl.buffer(bytes32(1, 0x4d)),
        Cl.buffer(GENESIS_ROOT),
        Cl.buffer(bytes32(2, 0x52)),
        ...publishFor(1, seed),
      ],
      alice,
    );

    const root = bytes32(2, 0x52);
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
    const c0 = bytes32(1, 0x3c);
    const seed = shieldPublicInputs({
      commitment: c0,
      ownerCommitment: bytes32(1, 0x4f),
      amount: BigInt(100 * ONE_STX),
      circuitVersion: CIRCUIT_VERSION,
    });
    simnet.callPublicFn(
      POOL,
      "shield",
      [
        Cl.uint(100 * ONE_STX),
        Cl.buffer(c0),
        Cl.buffer(bytes32(1, 0x4f)),
        Cl.buffer(bytes32(1, 0x4d)),
        Cl.buffer(GENESIS_ROOT),
        Cl.buffer(bytes32(2, 0x52)),
        ...publishFor(1, seed),
      ],
      alice,
    );

    const currentRoot = bytes32(2, 0x52);
    const expected = splitPublicInputs({
      nullifier: bytes32(1, 0x4e),
      commitment1: bytes32(2, 0x3c),
      ownerCommitment1: bytes32(2, 0x4f),
      commitment2: bytes32(3, 0x3c),
      ownerCommitment2: bytes32(3, 0x4f),
      merkleRoot: currentRoot,
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
        Cl.buffer(bytes32(4, 0x52)),
        ...publishFor(4, expected),
      ],
      alice,
    );
    expect(res.result.type).toBe("ok");
  });

  it("merge", () => {
    wire();
    for (const [n, amt] of [
      [1, 40],
      [2, 60],
    ] as const) {
      const seed = shieldPublicInputs({
        commitment: bytes32(n, 0x3c),
        ownerCommitment: bytes32(n, 0x4f),
        amount: BigInt(amt * ONE_STX),
        circuitVersion: CIRCUIT_VERSION,
      });
      simnet.callPublicFn(
        POOL,
        "shield",
        [
          Cl.uint(amt * ONE_STX),
          Cl.buffer(bytes32(n, 0x3c)),
          Cl.buffer(bytes32(n, 0x4f)),
          Cl.buffer(bytes32(n, 0x4d)),
          Cl.buffer(n === 1 ? GENESIS_ROOT : bytes32(2, 0x52)),
          Cl.buffer(bytes32(n + 1, 0x52)),
          ...publishFor(1, seed),
        ],
        alice,
      );
    }

    const currentRoot = bytes32(3, 0x52);
    const expected = mergePublicInputs({
      nullifier1: bytes32(1, 0x4e),
      nullifier2: bytes32(2, 0x4e),
      commitment: bytes32(9, 0x3c),
      ownerCommitment: bytes32(9, 0x4f),
      merkleRoot: currentRoot,
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
        Cl.buffer(bytes32(5, 0x52)),
        ...publishFor(5, expected),
      ],
      alice,
    );
    expect(res.result.type).toBe("ok");
  });
});

// ===========================================================================
// The binding must contain ONLY circuit inputs
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
        Cl.buffer(bytes32(2, 0x52)),
        ...inclusion,
      ],
      alice,
    );
    expect(res.result.type).toBe("ok");
  });

  it("new-root does not affect the hash — the circuit never proves it", () => {
    wire();
    const commitment = bytes32(1, 0x3c);
    const expected = shieldPublicInputs({
      commitment,
      ownerCommitment: bytes32(1, 0x4f),
      amount: BigInt(10 * ONE_STX),
      circuitVersion: CIRCUIT_VERSION,
    });
    const res = simnet.callPublicFn(
      POOL,
      "shield",
      [
        Cl.uint(10 * ONE_STX),
        Cl.buffer(commitment),
        Cl.buffer(bytes32(1, 0x4f)),
        Cl.buffer(bytes32(1, 0x4d)),
        Cl.buffer(GENESIS_ROOT),
        Cl.buffer(bytes32(77, 0x52)), // arbitrary new root
        ...publishFor(1, expected),
      ],
      alice,
    );
    expect(res.result.type).toBe("ok");
  });

  it("amount DOES affect the hash — it is a circuit input", () => {
    wire();
    const commitment = bytes32(1, 0x3c);
    const forTen = shieldPublicInputs({
      commitment,
      ownerCommitment: bytes32(1, 0x4f),
      amount: BigInt(10 * ONE_STX),
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
        Cl.buffer(bytes32(2, 0x52)),
        ...publishFor(1, forTen),
      ],
      alice,
    );
    expect(res.result).toBeErr(Cl.uint(310)); // ERR-PROOF-NOT-AGGREGATED
  });

  it("recipient DOES affect the hash — substitution is rejected", () => {
    wire();
    const c0 = bytes32(1, 0x3c);
    const seed = shieldPublicInputs({
      commitment: c0,
      ownerCommitment: bytes32(1, 0x4f),
      amount: BigInt(50 * ONE_STX),
      circuitVersion: CIRCUIT_VERSION,
    });
    simnet.callPublicFn(
      POOL,
      "shield",
      [
        Cl.uint(50 * ONE_STX),
        Cl.buffer(c0),
        Cl.buffer(bytes32(1, 0x4f)),
        Cl.buffer(bytes32(1, 0x4d)),
        Cl.buffer(GENESIS_ROOT),
        Cl.buffer(bytes32(2, 0x52)),
        ...publishFor(1, seed),
      ],
      alice,
    );

    const root = bytes32(2, 0x52);
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
    const a = transferPublicInputs({
      nullifier: bytes32(1, 0x4e),
      newCommitment: bytes32(2, 0x3c),
      newOwnerCommitment: bytes32(2, 0x4f),
      merkleRoot: bytes32(1, 0x52),
      circuitVersion: CIRCUIT_VERSION,
    });
    const b = transferPublicInputs({
      nullifier: bytes32(1, 0x4e),
      newCommitment: bytes32(2, 0x3c),
      newOwnerCommitment: bytes32(2, 0x4f),
      merkleRoot: bytes32(2, 0x52),
      circuitVersion: CIRCUIT_VERSION,
    });
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
  });

  it("the circuit version DOES affect the hash — proofs cannot cross versions", () => {
    const v1 = shieldPublicInputs({
      commitment: bytes32(1, 0x3c),
      ownerCommitment: bytes32(1, 0x4f),
      amount: 1n,
      circuitVersion: 1,
    });
    const v2 = shieldPublicInputs({
      commitment: bytes32(1, 0x3c),
      ownerCommitment: bytes32(1, 0x4f),
      amount: 1n,
      circuitVersion: 2,
    });
    expect(Buffer.from(v1).toString("hex")).not.toBe(Buffer.from(v2).toString("hex"));
  });
});

// ===========================================================================
// The vector IS the specification
// ===========================================================================

describe("public input vectors", () => {
  it("have exactly the circuits' arity", () => {
    const args = {
      commitment: bytes32(1, 0x3c),
      ownerCommitment: bytes32(1, 0x4f),
      amount: 1n,
      circuitVersion: 1,
    };
    expect(publicInputVector.shield(args)).toHaveLength(5);
    expect(
      publicInputVector.transfer({
        nullifier: bytes32(1, 0x4e),
        newCommitment: bytes32(2, 0x3c),
        newOwnerCommitment: bytes32(2, 0x4f),
        merkleRoot: bytes32(1, 0x52),
        circuitVersion: 1,
      }),
    ).toHaveLength(6);
    expect(
      publicInputVector.withdraw({
        nullifier: bytes32(1, 0x4e),
        amount: 1n,
        recipient,
        merkleRoot: bytes32(1, 0x52),
        circuitVersion: 1,
      }),
    ).toHaveLength(6);
    expect(
      publicInputVector.split({
        nullifier: bytes32(1, 0x4e),
        commitment1: bytes32(2, 0x3c),
        ownerCommitment1: bytes32(2, 0x4f),
        commitment2: bytes32(3, 0x3c),
        ownerCommitment2: bytes32(3, 0x4f),
        merkleRoot: bytes32(1, 0x52),
        circuitVersion: 1,
      }),
    ).toHaveLength(8);
    expect(
      publicInputVector.merge({
        nullifier1: bytes32(1, 0x4e),
        nullifier2: bytes32(2, 0x4e),
        commitment: bytes32(9, 0x3c),
        ownerCommitment: bytes32(9, 0x4f),
        merkleRoot: bytes32(1, 0x52),
        circuitVersion: 1,
      }),
    ).toHaveLength(7);
  });

  it("hashing the vector equals the operation hash — one encoding, not two", () => {
    const args = {
      commitment: bytes32(1, 0x3c),
      ownerCommitment: bytes32(1, 0x4f),
      amount: 42n,
      circuitVersion: 1,
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
      merkleRoot: bytes32(1, 0x52),
      circuitVersion: 1,
    })) {
      expect(fe).toHaveLength(32);
    }
  });
});
