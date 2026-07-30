/*
  zkVerify aggregation simulation for STX Shield tests.

  Reproduces, exactly, what zk-verifier.clar checks:

    leaf = keccak256(vkeyHash ‖ publicInputsHash)
    root = fold over the sibling path, ordering by index parity

  Tests build a real keccak Merkle tree over statement leaves, publish its
  root through `submit-aggregation`, and submit real inclusion paths — so the
  on-chain Merkle verification is genuinely exercised rather than stubbed.
*/

import { keccak_256 } from "@noble/hashes/sha3.js";
import { Cl } from "@stacks/transactions";

export const keccak256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(keccak_256(data));

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/** zkVerify binding constants, mirroring the contract's configuration. */
export interface Binding {
  contextHash: Uint8Array;
  zkvVkeyHash: Uint8Array;
  versionHash: Uint8Array;
}

/** Fixed test binding. The real values are OBSERVED from zkVerify; these
 *  stand in for them and must match what the harness writes on chain. */
export const TEST_CONTEXT = new Uint8Array(32).fill(0xc0);

export const bindingFor = (proofType: number): Binding => ({
  contextHash: TEST_CONTEXT,
  zkvVkeyHash: new Uint8Array(32).fill(0xd0 + proofType),
  versionHash: new Uint8Array(32).fill(0xe0 + proofType),
});

/** The statement leaf — mirrors `statement-leaf` in zk-verifier.clar:
 *  keccak256( contextHash ‖ zkvVkeyHash ‖ versionHash ‖ publicInputsHash ) */
export const statementLeaf = (
  binding: Binding,
  publicInputsHash: Uint8Array,
): Uint8Array =>
  keccak256(
    concat(
      concat(binding.contextHash, binding.zkvVkeyHash),
      concat(binding.versionHash, publicInputsHash),
    ),
  );

export interface Inclusion {
  domainId: number;
  aggregationId: number;
  root: Uint8Array;
  leafCount: number;
  leafIndex: number;
  path: Uint8Array[];
  leaf: Uint8Array;
}

/**
 * zkVerify's aggregation tree = Substrate `binary-merkle-tree`:
 *
 *   * leaves are HASHED into the tree: node = keccak256(statement).
 *   * internal nodes: keccak256(left ‖ right).
 *   * an odd trailing node carries UP UNCHANGED (it is NOT duplicated).
 *
 * `leaves` here are the raw statement leaves; level 0 stores their hashes.
 */
export class MerkleTree {
  /** level 0 = hashed leaves; each higher level combines pairs. */
  readonly levels: Uint8Array[][] = [];

  constructor(leaves: Uint8Array[]) {
    if (leaves.length === 0) throw new Error("aggregation must have >= 1 leaf");
    let level = leaves.map((l) => keccak256(l)); // leaves are hashed
    this.levels.push(level);
    while (level.length > 1) {
      const next: Uint8Array[] = [];
      for (let i = 0; i < level.length; i += 2) {
        if (i + 1 < level.length) {
          next.push(keccak256(concat(level[i]!, level[i + 1]!)));
        } else {
          next.push(level[i]!); // odd trailing node carries up unchanged
        }
      }
      this.levels.push(next);
      level = next;
    }
  }

  get root(): Uint8Array {
    return this.levels[this.levels.length - 1]![0]!;
  }

  get leafCount(): number {
    return this.levels[0]!.length;
  }

  /** Sibling hashes from `index` up to the root. A carried (unpaired) node
   *  contributes NO sibling at that level, exactly as Substrate emits. */
  pathFor(index: number): Uint8Array[] {
    const path: Uint8Array[] = [];
    let i = index;
    for (let l = 0; l < this.levels.length - 1; l++) {
      const level = this.levels[l]!;
      const siblingIdx = i % 2 === 0 ? i + 1 : i - 1;
      if (siblingIdx < level.length) path.push(level[siblingIdx]!);
      // else: node is the odd trailing one; it carries up, no sibling
      i = Math.floor(i / 2);
    }
    return path;
  }
}

/**
 * Stands in for zkVerify: accepts verified statements, batches them into
 * aggregations, and issues inclusion proofs. Each `aggregate()` call mints a
 * new aggregation id, mirroring zkVerify's batching.
 */
export class Aggregator {
  private nextAggregationId = 1;
  readonly domainId: number;
  /** Filler leaves per aggregation, so paths have real depth. */
  private readonly padding: number;

  constructor(domainId = 1, padding = 3) {
    this.domainId = domainId;
    this.padding = padding;
  }

  /** Aggregate one statement leaf; returns its inclusion proof. */
  aggregate(leaf: Uint8Array): Inclusion {
    const aggregationId = this.nextAggregationId++;
    // Place the real leaf among deterministic filler statements, so the
    // Merkle path is non-trivial and index parity is exercised on both sides.
    const leaves: Uint8Array[] = [];
    const position = aggregationId % (this.padding + 1);
    for (let i = 0; i < this.padding + 1; i++) {
      leaves.push(i === position ? leaf : keccak256(filler(aggregationId, i)));
    }
    const tree = new MerkleTree(leaves);
    return {
      domainId: this.domainId,
      aggregationId,
      root: tree.root,
      leafCount: tree.leafCount,
      leafIndex: position,
      path: tree.pathFor(position),
      leaf,
    };
  }
}

/**
 * Test-side stand-in for the full zkVerify round trip, for suites that drive
 * the contracts directly rather than through the `Protocol` harness.
 *
 * `args(vkeyHash, inputsHash)` verifies + aggregates the statement, publishes
 * the root on chain, and returns the four Clarity arguments the pool and
 * split-merge-manager expect. No signatures are involved anywhere.
 */
export class LocalProver {
  private readonly aggregator: Aggregator;
  private readonly deployer: string;
  private readonly verifier: string;
  /** Set false to publish nothing — used to test the unknown-aggregation path. */
  publishRoots = true;

  constructor(deployer: string, verifier = "zk-verifier", aggregator = new Aggregator()) {
    this.deployer = deployer;
    this.verifier = verifier;
    this.aggregator = aggregator;
  }

  aggregate(proofType: number, publicInputsHash: Uint8Array): Inclusion {
    const inc = this.aggregator.aggregate(statementLeaf(bindingFor(proofType), publicInputsHash));
    if (this.publishRoots) this.publish(inc);
    return inc;
  }

  publish(inc: Inclusion) {
    return simnet.callPublicFn(
      this.verifier,
      "submit-aggregation",
      [
        Cl.uint(inc.domainId),
        Cl.uint(inc.aggregationId),
        Cl.buffer(inc.root),
        Cl.uint(inc.leafCount),
      ],
      this.deployer,
    );
  }

  /** The four inclusion arguments, for splicing into a call's argument list. */
  static argsOf(inc: Inclusion) {
    return [
      Cl.uint(inc.domainId),
      Cl.uint(inc.aggregationId),
      Cl.list(inc.path.map((p) => Cl.buffer(p))),
      Cl.uint(inc.leafIndex),
    ];
  }

  args(proofType: number, publicInputsHash: Uint8Array) {
    return LocalProver.argsOf(this.aggregate(proofType, publicInputsHash));
  }

  /** Configure the on-chain binding so verify-proof can derive the same leaf. */
  configureBindings(proofTypes: number[], circuitVersion = 1) {
    simnet.callPublicFn(
      this.verifier,
      "set-zkverify-context-hash",
      [Cl.buffer(TEST_CONTEXT)],
      this.deployer,
    );
    for (const t of proofTypes) {
      const b = bindingFor(t);
      simnet.callPublicFn(
        this.verifier,
        "set-zkverify-binding",
        [Cl.uint(t), Cl.uint(circuitVersion), Cl.buffer(b.zkvVkeyHash), Cl.buffer(b.versionHash)],
        this.deployer,
      );
    }
  }
}

const filler = (aggregationId: number, i: number): Uint8Array => {
  const b = new Uint8Array(32);
  b[0] = 0xfa;
  b[28] = (aggregationId >>> 8) & 0xff;
  b[29] = aggregationId & 0xff;
  b[31] = i & 0xff;
  return b;
};
