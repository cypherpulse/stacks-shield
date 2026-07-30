// =============================================================================
// STX Shield SDK -- Merkle tree (roots)
// =============================================================================
// A fixed-depth (2^20) Poseidon Merkle tree over note commitments, mirroring
// circuits/lib. The SDK maintains it locally, appends leaves as commitments
// are registered on chain, and produces authentication paths for spend proofs.
//
// Empty subtrees use precomputed zero-hashes so an unfilled tree still has a
// well-defined root (the genesis root posted at deployment).

import { poseidonHash2, bytes32ToField, ZERO_HASH } from "../utilities/crypto.js";
import { TREE_DEPTH, type Bytes32, type MerklePath, ShieldError } from "../types.js";

export class MerkleTree {
  private readonly depth: number;
  private readonly zeros: Bytes32[]; // zeros[i] = root of an empty subtree of height i
  private leaves: Bytes32[] = [];
  /** level -> index -> node hash, filled lazily. */
  private nodes: Map<number, Map<number, Bytes32>>[] = [];

  constructor(depth: number = TREE_DEPTH) {
    this.depth = depth;
    this.zeros = [ZERO_HASH];
    for (let i = 1; i <= depth; i++) {
      const prev = this.zeros[i - 1]!;
      this.zeros.push(poseidonHash2(bytes32ToField(prev), bytes32ToField(prev)));
    }
    for (let i = 0; i <= depth; i++) this.nodes.push([new Map()] as never);
    this.nodes = Array.from({ length: depth + 1 }, () => new Map<number, Bytes32>()) as never;
  }

  /** The empty-tree root — post this at deployment via registry.update-root. */
  get genesisRoot(): Bytes32 {
    return this.zeros[this.depth]!;
  }

  get size(): number {
    return this.leaves.length;
  }

  /** Append a commitment leaf, returning its index. */
  append(leaf: Bytes32): number {
    if (this.leaves.length >= 2 ** this.depth)
      throw new ShieldError("TREE_FULL", "commitment tree is full");
    const index = this.leaves.length;
    this.leaves.push(leaf);
    this.setNode(0, index, leaf);
    this.recomputePath(index);
    return index;
  }

  /** Current Merkle root. */
  root(): Bytes32 {
    return this.getNode(this.depth, 0);
  }

  /** A deep, independent copy — used to project a post-insertion root
   *  without mutating the canonical tree before on-chain confirmation. */
  clone(): MerkleTree {
    const copy = new MerkleTree(this.depth);
    copy.leaves = this.leaves.slice();
    copy.nodes = this.nodes.map((level) => new Map(level));
    return copy;
  }

  /** Root the tree WOULD have after appending `newLeaves`, without mutating. */
  projectRoot(newLeaves: readonly Bytes32[]): Bytes32 {
    const scratch = this.clone();
    for (const leaf of newLeaves) scratch.append(leaf);
    return scratch.root();
  }

  /** Authentication path for the leaf at `index`. */
  proof(index: number): MerklePath {
    if (index < 0 || index >= this.leaves.length)
      throw new ShieldError("BAD_INDEX", `no leaf at index ${index}`);
    const siblings: Bytes32[] = [];
    const indexBits: (0 | 1)[] = [];
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      const isRight = i % 2 === 1;
      const siblingIndex = isRight ? i - 1 : i + 1;
      siblings.push(this.getNode(level, siblingIndex));
      indexBits.push(isRight ? 1 : 0);
      i = Math.floor(i / 2);
    }
    return {
      leaf: this.leaves[index]!,
      index,
      indexBits,
      siblings,
      root: this.root(),
    };
  }

  private recomputePath(index: number): void {
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      const left = i % 2 === 0 ? this.getNode(level, i) : this.getNode(level, i - 1);
      const right = i % 2 === 0 ? this.getNode(level, i + 1) : this.getNode(level, i);
      const parent = poseidonHash2(bytes32ToField(left), bytes32ToField(right));
      i = Math.floor(i / 2);
      this.setNode(level + 1, i, parent);
    }
  }

  private setNode(level: number, index: number, value: Bytes32): void {
    this.nodes[level]!.set(index, value);
  }

  private getNode(level: number, index: number): Bytes32 {
    return this.nodes[level]!.get(index) ?? this.zeros[level]!;
  }
}
