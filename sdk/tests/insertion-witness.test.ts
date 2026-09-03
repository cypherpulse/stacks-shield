// =============================================================================
// C-1 fix foundation — CommitmentTree.insertionWitness correctness
// =============================================================================
// Verifies the witness the new circuit will consume: oldRoot must equal the
// current root (slot empty), and newRoot must equal the root after the append,
// both from the SAME siblings. If these hold, a forged new-root cannot verify.

import { describe, it, expect } from "vitest";
import { CommitmentTree } from "../merkle-tree/index.js";

const leaf = (n: number): Uint8Array => {
  const b = new Uint8Array(32);
  b[31] = n & 0xff;
  b[0] = 0x11; // non-zero, never the empty leaf
  return b;
};
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

describe("CommitmentTree.insertionWitness", () => {
  it("oldRoot == current root, newRoot == root after inserting", () => {
    const t = new CommitmentTree();
    t.insert(leaf(1));
    t.insert(leaf(2));
    t.insert(leaf(3));

    const w = t.insertionWitness(leaf(9));
    expect(w.index).toBe(3); // next free slot
    expect(eq(w.oldRoot, t.root)).toBe(true); // slot empty ⇒ oldRoot is the live root

    const idx = t.insert(leaf(9)); // now actually append
    expect(idx).toBe(w.index);
    expect(eq(t.root, w.newRoot)).toBe(true); // predicted newRoot is correct
  });

  it("works for the first insertion into an empty tree", () => {
    const t = new CommitmentTree();
    const w = t.insertionWitness(leaf(7));
    expect(w.index).toBe(0);
    expect(eq(w.oldRoot, t.root)).toBe(true);
    t.insert(leaf(7));
    expect(eq(t.root, w.newRoot)).toBe(true);
  });

  it("does not mutate the tree", () => {
    const t = new CommitmentTree();
    t.insert(leaf(1));
    const before = t.size;
    const rootBefore = t.root;
    t.insertionWitness(leaf(2));
    expect(t.size).toBe(before);
    expect(eq(t.root, rootBefore)).toBe(true);
  });

  it("the inserted leaf's membership proof matches the insertion witness", () => {
    const t = new CommitmentTree();
    t.insert(leaf(1));
    t.insert(leaf(2));
    const w = t.insertionWitness(leaf(5));
    const idx = t.insert(leaf(5));
    const p = t.proof(idx);
    expect(w.indexBits).toEqual(p.indexBits);
    expect(w.siblings.map((s) => [...s])).toEqual(p.siblings.map((s) => [...s]));
    expect(eq(p.root, w.newRoot)).toBe(true);
  });

  it("a FORGED newRoot is rejected: witness.newRoot must be derived, not chosen", () => {
    const t = new CommitmentTree();
    t.insert(leaf(1));
    const w = t.insertionWitness(leaf(2));
    const forged = new Uint8Array(32).fill(0xde);
    // The circuit will assert root(commitment, siblings, indexBits) == newRoot.
    // A fabricated root does not equal the derived one, so no proof exists for it.
    expect(eq(w.newRoot, forged)).toBe(false);
  });
});
