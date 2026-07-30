import { describe, expect, it } from "vitest";
import {
  encryptNote,
  tryDecryptNote,
  generateViewingKeyPair,
  encodeEncryptedNote,
  decodeEncryptedNote,
  NOTE_PAYLOAD_VERSION,
  type NotePayload,
} from "../../sdk/encryption/index.js";
import { CommitmentTree, verifyMerkleProof, TREE_DEPTH } from "../../sdk/merkle-tree/index.js";
import { NoteScanner, type ChainSource, type PublishedNote } from "../../sdk/note-discovery/index.js";

/*
  Receiver-privacy tests.

  These cover the half of privacy the contracts cannot provide: a receiver must
  be able to FIND a note addressed to them, and nobody else may learn who a
  note is for. That rests on trial decryption over per-note ephemeral keys.
*/

const b32 = (n: number, p = 0x3c): Uint8Array => {
  const b = new Uint8Array(32);
  b[0] = p;
  b[31] = n & 0xff;
  b[30] = (n >> 8) & 0xff;
  return b;
};

const payload = (n: number, amount = 1_000_000n): NotePayload => ({
  version: NOTE_PAYLOAD_VERSION,
  amount,
  blinding: BigInt(1000 + n),
  ownerSk: BigInt(7777 + n),
  nonce: BigInt(n),
  commitment: b32(n),
  treePosition: n,
});

// ===========================================================================
// Encryption
// ===========================================================================

describe("encrypted note delivery", () => {
  it("the receiver recovers the exact note; nobody else can", () => {
    const bob = generateViewingKeyPair();
    const eve = generateViewingKeyPair();
    const p = payload(1);

    const sealed = encryptNote(p, bob.publicKey);
    const recovered = tryDecryptNote(sealed, bob.secretKey);

    expect(recovered).not.toBeNull();
    expect(recovered!.amount).toBe(p.amount);
    expect(recovered!.blinding).toBe(p.blinding);
    expect(recovered!.ownerSk).toBe(p.ownerSk);
    expect(recovered!.treePosition).toBe(p.treePosition);

    // Eve holds a valid key -- just not the right one. She learns nothing,
    // and crucially gets null rather than an error she could distinguish.
    expect(tryDecryptNote(sealed, eve.secretKey)).toBeNull();
  });

  it("two notes to the SAME receiver share nothing on chain (unlinkable)", () => {
    const bob = generateViewingKeyPair();
    const a = encodeEncryptedNote(encryptNote(payload(1), bob.publicKey));
    const b = encodeEncryptedNote(encryptNote(payload(2), bob.publicKey));

    // A fresh ephemeral key per note means no shared bytes anywhere -- an
    // observer cannot cluster payloads by recipient.
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
    expect(a.slice(0, 32)).not.toEqual(b.slice(0, 32)); // distinct ephemeral keys
  });

  it("identical payloads to the same receiver still produce distinct ciphertexts", () => {
    const bob = generateViewingKeyPair();
    const p = payload(3);
    const first = encryptNote(p, bob.publicKey);
    const second = encryptNote(p, bob.publicKey);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    // both still decrypt correctly
    expect(tryDecryptNote(first, bob.secretKey)!.amount).toBe(p.amount);
    expect(tryDecryptNote(second, bob.secretKey)!.amount).toBe(p.amount);
  });

  it("a tampered ciphertext is rejected, not silently mangled", () => {
    const bob = generateViewingKeyPair();
    const sealed = encryptNote(payload(4), bob.publicKey);
    sealed.ciphertext[5] ^= 0xff; // flip a bit
    // Poly1305 authentication catches it -- forged payloads cannot inject
    // a fake note into a receiver's wallet.
    expect(tryDecryptNote(sealed, bob.secretKey)).toBeNull();
  });

  it("a forged ephemeral key cannot impersonate a sender's note", () => {
    const bob = generateViewingKeyPair();
    const sealed = encryptNote(payload(5), bob.publicKey);
    sealed.ephemeralPublicKey = generateViewingKeyPair().publicKey;
    expect(tryDecryptNote(sealed, bob.secretKey)).toBeNull();
  });

  it("survives the wire encoding round trip", () => {
    const bob = generateViewingKeyPair();
    const sealed = encryptNote(payload(6, 42_000_000n), bob.publicKey);
    const decoded = decodeEncryptedNote(encodeEncryptedNote(sealed));
    expect(tryDecryptNote(decoded, bob.secretKey)!.amount).toBe(42_000_000n);
  });
});

// ===========================================================================
// Merkle tree
// ===========================================================================

describe("commitment tree", () => {
  it("produces proofs that verify, at every position", () => {
    const tree = new CommitmentTree(8);
    for (let i = 0; i < 13; i++) tree.insert(b32(i + 1));
    for (let i = 0; i < 13; i++) {
      expect(verifyMerkleProof(tree.proof(i))).toBe(true);
    }
  });

  it("a proof for the wrong leaf does not verify", () => {
    const tree = new CommitmentTree(8);
    for (let i = 0; i < 5; i++) tree.insert(b32(i + 1));
    const proof = tree.proof(2);
    proof.leaf = b32(99);
    expect(verifyMerkleProof(proof)).toBe(false);
  });

  it("the root advances with every insertion", () => {
    const tree = new CommitmentTree(8);
    const roots = new Set<string>();
    for (let i = 0; i < 6; i++) {
      tree.insert(b32(i + 1));
      roots.add(Buffer.from(tree.root).toString("hex"));
    }
    expect(roots.size).toBe(6);
  });

  it("defaults to the circuit's depth", () => {
    expect(new CommitmentTree().depth).toBe(TREE_DEPTH);
  });

  it("refuses a proof for a leaf that was never inserted", () => {
    const tree = new CommitmentTree(8);
    tree.insert(b32(1));
    expect(() => tree.proof(5)).toThrow(/not in the tree/);
  });
});

// ===========================================================================
// Note discovery
// ===========================================================================

class FakeChain implements ChainSource {
  notes: PublishedNote[] = [];
  nullifiers: Uint8Array[] = [];
  async fetchNotes(fromIndex: number) {
    return this.notes.filter((n) => n.leafIndex >= fromIndex);
  }
  async fetchNullifiers() {
    return this.nullifiers;
  }
}

describe("note discovery", () => {
  const publish = (chain: FakeChain, toPk: Uint8Array, n: number, amount: bigint) => {
    const leafIndex = chain.notes.length;
    const p = { ...payload(n, amount), treePosition: leafIndex, commitment: b32(n) };
    chain.notes.push({
      commitment: p.commitment,
      leafIndex,
      payload: encodeEncryptedNote(encryptNote(p, toPk)),
    });
    return p;
  };

  it("finds only the notes addressed to this viewing key", async () => {
    const chain = new FakeChain();
    const bob = generateViewingKeyPair();
    const carol = generateViewingKeyPair();

    publish(chain, carol.publicKey, 1, 5_000_000n);
    publish(chain, bob.publicKey, 2, 3_000_000n);
    publish(chain, carol.publicKey, 3, 9_000_000n);
    publish(chain, bob.publicKey, 4, 1_000_000n);

    const scanner = new NoteScanner(bob, chain);
    const { scanned, found } = await scanner.sync();

    // Bob scans everything -- asking only for "his" notes would reveal who he
    // is. He locally keeps the two that decrypt.
    expect(scanned).toBe(4);
    expect(found).toBe(2);
    expect(scanner.balance()).toBe(4_000_000n);
  });

  it("builds the whole tree, not just our leaves, so proofs stay valid", async () => {
    const chain = new FakeChain();
    const bob = generateViewingKeyPair();
    const carol = generateViewingKeyPair();
    publish(chain, carol.publicKey, 1, 1n);
    const mine = publish(chain, bob.publicKey, 2, 7_000_000n);
    publish(chain, carol.publicKey, 3, 1n);

    const scanner = new NoteScanner(bob, chain);
    await scanner.sync();

    expect(scanner.tree.size).toBe(3); // every commitment, not just Bob's
    const proof = scanner.proofFor(mine.commitment);
    expect(proof.index).toBe(1);
    expect(verifyMerkleProof(proof)).toBe(true);
  });

  it("resumes incrementally without rescanning", async () => {
    const chain = new FakeChain();
    const bob = generateViewingKeyPair();
    publish(chain, bob.publicKey, 1, 1_000_000n);

    const scanner = new NoteScanner(bob, chain);
    expect((await scanner.sync()).scanned).toBe(1);
    expect((await scanner.sync()).scanned).toBe(0); // nothing new

    publish(chain, bob.publicKey, 2, 2_000_000n);
    expect((await scanner.sync()).scanned).toBe(1);
    expect(scanner.balance()).toBe(3_000_000n);
  });

  it("marks notes spent once their nullifier appears on chain", async () => {
    const chain = new FakeChain();
    const bob = generateViewingKeyPair();
    const note = publish(chain, bob.publicKey, 1, 5_000_000n);
    publish(chain, bob.publicKey, 2, 2_000_000n);

    const scanner = new NoteScanner(bob, chain);
    // Only Bob can compute this link -- he holds the spending secrets.
    scanner.nullifierFor = (n) => (n.nonce === 1n ? b32(1, 0x4e) : b32(2, 0x4e));
    await scanner.sync();
    expect(scanner.balance()).toBe(7_000_000n);

    chain.nullifiers.push(b32(1, 0x4e));
    await scanner.sync();
    expect(scanner.balance()).toBe(2_000_000n);
    expect(scanner.notes().every((n) => n.commitment[31] !== note.commitment[31])).toBe(true);
  });

  it("selects notes covering an amount, and refuses when short", async () => {
    const chain = new FakeChain();
    const bob = generateViewingKeyPair();
    publish(chain, bob.publicKey, 1, 1_000_000n);
    publish(chain, bob.publicKey, 2, 5_000_000n);
    publish(chain, bob.publicKey, 3, 2_000_000n);

    const scanner = new NoteScanner(bob, chain);
    await scanner.sync();

    const chosen = scanner.select(6_000_000n);
    expect(chosen[0]!.amount).toBe(5_000_000n); // largest first
    expect(chosen.reduce((s, n) => s + n.amount, 0n)).toBeGreaterThanOrEqual(6_000_000n);
    expect(() => scanner.select(100_000_000n)).toThrow(/insufficient/);
  });

  it("ignores malformed payloads from unrelated senders", async () => {
    const chain = new FakeChain();
    const bob = generateViewingKeyPair();
    chain.notes.push({ commitment: b32(1), leafIndex: 0, payload: new Uint8Array([1, 2, 3]) });
    publish(chain, bob.publicKey, 2, 4_000_000n);

    const scanner = new NoteScanner(bob, chain);
    const { found } = await scanner.sync();
    expect(found).toBe(1);
    expect(scanner.balance()).toBe(4_000_000n);
    expect(scanner.tree.size).toBe(2); // the junk leaf still occupies its slot
  });
});
