// =============================================================================
// STX Shield SDK -- commitment Merkle tree
// =============================================================================
// The client-side mirror of the on-chain commitment tree. Its job is to
// produce the membership proof a spend needs:
//
//   assert_merkle_membership(commitment, index_bits, siblings, root)
//
// This is what replaced the old public note id. Because the spender proves
// "my note is *somewhere* in this tree" rather than naming the leaf, the
// chain never learns which note was consumed. The tree therefore has to be
// reconstructed client-side from public commitments.
//
// Hash: Poseidon-BN254 hash_2, matching `assert_merkle_membership` in
// zk/circuits/lib/src/lib.nr exactly. A mismatch here produces proofs that
// fail on chain, so the two must move together.

import { poseidonHash2, bytes32ToField, fieldToBytes32 } from "../utilities/crypto.js";
import type { Bytes32 } from "../types.js";

/** Must equal TREE_DEPTH in the circuits. */
export const TREE_DEPTH = 20;
export const MAX_LEAVES = 2 ** TREE_DEPTH;

export interface MerkleProof {
  /** Leaf being proven. */
  leaf: Bytes32;
  /** Index of the leaf; also the path directions. */
  index: number;
  /** false = leaf is the LEFT child at that level (matches the circuit). */
  indexBits: boolean[];
  /** Sibling at each level, bottom-up. */
  siblings: Bytes32[];
  root: Bytes32;
}

/** Witness proving the append of a commitment at the next free slot (C-1 fix). */
export interface InsertionWitness {
  /** The slot the commitment is appended at (= tree size before insert). */
  index: number;
  indexBits: boolean[];
  siblings: Bytes32[];
  /** The empty-leaf constant the slot held before insertion (32 zero bytes). */
  emptyLeaf: Bytes32;
  /** Root with the slot empty (equals the current tree root). */
  oldRoot: Bytes32;
  /** Root after inserting the commitment at `index` (same siblings). */
  newRoot: Bytes32;
}

const ZERO = new Uint8Array(32);

/**
 * Sparse incremental Merkle tree.
 *
 * Only populated nodes are stored, so a depth-20 tree (over a million leaves)
 * costs memory proportional to what has actually been inserted. Empty subtrees
 * collapse to precomputed zero hashes.
 */
export class CommitmentTree {
  /** Precomputed hash of an empty subtree at each level. */
  private readonly zeros: Bytes32[] = [];
  /** level -> index -> node. Level 0 is the leaves. */
  private readonly nodes: Map<number, Map<number, Bytes32>> = new Map();
  private count = 0;

  constructor(readonly depth: number = TREE_DEPTH) {
    let z: Bytes32 = ZERO;
    this.zeros.push(z);
    for (let i = 0; i < depth; i++) {
      z = this.hash(z, z);
      this.zeros.push(z);
    }
  }

  private hash(l: Bytes32, r: Bytes32): Bytes32 {
    return fieldToBytes32(
      bytes32ToField(poseidonHash2(bytes32ToField(l), bytes32ToField(r))),
    );
  }

  private get(level: number, index: number): Bytes32 {
    return this.nodes.get(level)?.get(index) ?? this.zeros[level]!;
  }

  private set(level: number, index: number, value: Bytes32): void {
    let lvl = this.nodes.get(level);
    if (!lvl) {
      lvl = new Map();
      this.nodes.set(level, lvl);
    }
    lvl.set(index, value);
  }

  get size(): number {
    return this.count;
  }

  get root(): Bytes32 {
    return this.get(this.depth, 0);
  }

  /** Append a commitment; returns its leaf index. */
  insert(commitment: Bytes32): number {
    if (this.count >= MAX_LEAVES) throw new Error("commitment tree is full");
    const index = this.count++;
    this.setLeaf(index, commitment);
    return index;
  }

  /** Bulk append, e.g. when syncing from chain history. */
  insertMany(commitments: Bytes32[]): number[] {
    return commitments.map((c) => this.insert(c));
  }

  private setLeaf(index: number, value: Bytes32): void {
    this.set(0, index, value);
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      const sibling = this.get(level, i ^ 1);
      const current = this.get(level, i);
      const [l, r] = (i & 1) === 0 ? [current, sibling] : [sibling, current];
      i >>= 1;
      this.set(level + 1, i, this.hash(l, r));
    }
  }

  /**
   * Witness for proving the APPEND of `commitment` at the next free slot — the
   * fix for C-1 (the circuit binds the tree transition instead of trusting a
   * caller-supplied new-root). Returns, for `index = count`:
   *   - `oldRoot`: the current root (that slot holds the empty leaf), and
   *   - `newRoot`: the root after inserting `commitment` at `index`,
   * both computed with the SAME `siblings`. The circuit asserts
   *   root(EMPTY_LEAF, siblings, indexBits) == oldRoot   AND
   *   root(commitment, siblings, indexBits) == newRoot
   * so a forged newRoot cannot verify. Does NOT mutate the tree.
   */
  insertionWitness(commitment: Bytes32): InsertionWitness {
    if (this.count >= MAX_LEAVES) throw new Error("commitment tree is full");
    const index = this.count; // the next free (currently empty) slot
    const siblings: Bytes32[] = [];
    const indexBits: boolean[] = [];
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      siblings.push(this.get(level, i ^ 1)); // empty subtrees collapse to zeros
      indexBits.push((i & 1) === 1);
      i >>= 1;
    }
    const fold = (leaf: Bytes32): Bytes32 => {
      let node = leaf;
      for (let level = 0; level < this.depth; level++) {
        const sibling = siblings[level]!;
        const [l, r] = indexBits[level] ? [sibling, node] : [node, sibling];
        node = this.hash(l, r);
      }
      return node;
    };
    return {
      index,
      indexBits,
      siblings,
      emptyLeaf: ZERO,
      oldRoot: fold(ZERO), // == this.root, since slot `index` is empty
      newRoot: fold(commitment),
    };
  }

  /** The membership proof for a leaf index. Feeds straight into the circuit. */
  proof(index: number): MerkleProof {
    if (index < 0 || index >= this.count) {
      throw new Error(`leaf ${index} is not in the tree (size ${this.count})`);
    }
    const siblings: Bytes32[] = [];
    const indexBits: boolean[] = [];
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      siblings.push(this.get(level, i ^ 1));
      indexBits.push((i & 1) === 1);
      i >>= 1;
    }
    return { leaf: this.get(0, index), index, indexBits, siblings, root: this.root };
  }

  /** Index of a commitment, or -1. Linear — callers syncing large trees should
   *  keep their own index, which `NoteScanner` does. */
  indexOf(commitment: Bytes32): number {
    const leaves = this.nodes.get(0);
    if (!leaves) return -1;
    for (const [index, value] of leaves) {
      if (value.length === commitment.length && value.every((b, k) => b === commitment[k])) {
        return index;
      }
    }
    return -1;
  }
}

/** Recompute a root from a proof — the client-side mirror of the circuit's
 *  check. Useful for validating a proof before paying to submit it. */
export const verifyMerkleProof = (proof: MerkleProof): boolean => {
  let node = proof.leaf;
  for (let level = 0; level < proof.siblings.length; level++) {
    const sibling = proof.siblings[level]!;
    const [l, r] = proof.indexBits[level] ? [sibling, node] : [node, sibling];
    node = fieldToBytes32(bytes32ToField(poseidonHash2(bytes32ToField(l), bytes32ToField(r))));
  }
  return node.every((b, i) => b === proof.root[i]);
};
