// =============================================================================
// stx_shield_lib -- shared Noir primitives for the STX Shield circuits
// =============================================================================
// Target: Noir v1.0.0-beta.22 / Barretenberg UltraHonk.
//
// A shielded NOTE is a Pedersen/Poseidon commitment to (amount, owner, blinding):
//
//   note_commitment = Poseidon([amount, owner_pk_x, owner_pk_y, blinding])
//   owner_commitment = Poseidon([owner_pk_x, owner_pk_y])   // opaque, no principal
//   nullifier         = Poseidon([note_commitment, owner_sk])
//
// The nullifier binds a note to its owner's secret so that only the owner can
// spend it, and the same note always yields the same nullifier (double-spend
// detection) while revealing nothing about which note it consumes.
//
// The commitment tree is a fixed-depth (2^20) Merkle tree over note
// commitments. Membership proofs authorize spends against any historical root
// the registry still holds.
// =============================================================================

// Poseidon moved out of the Noir standard library; it now ships as the
// `poseidon` package (noir-lang/poseidon), pinned in Nargo.toml.
use poseidon::poseidon::bn254::{hash_2, hash_4};

pub global TREE_DEPTH: u32 = 20;

// A note's private witness. Amounts and secrets NEVER leave the circuit.
pub struct Note {
    pub amount: Field,
    pub owner_pk_x: Field,
    pub owner_pk_y: Field,
    pub blinding: Field,
}

impl Note {
    // The public note commitment (the tree leaf / on-chain note id).
    pub fn commitment(self) -> Field {
        hash_4([self.amount, self.owner_pk_x, self.owner_pk_y, self.blinding])
    }

    // The opaque owner commitment stored on-chain (never a principal).
    pub fn owner_commitment(self) -> Field {
        hash_2([self.owner_pk_x, self.owner_pk_y])
    }
}

// nullifier = Poseidon(note_commitment, owner_sk). Proving knowledge of
// owner_sk that matches the note's owner public key is the ownership proof.
pub fn compute_nullifier(note_commitment: Field, owner_sk: Field) -> Field {
    hash_2([note_commitment, owner_sk])
}

// Recompute the Merkle root from `leaf` and its authentication path.
// Matches CommitmentTree in the SDK (Poseidon hash_2, depth TREE_DEPTH).
//
// `index_bits[i] == false` means `current` is the left child at level i.
// (`u1` was removed from Noir; the path index is carried as bools.)
pub fn compute_merkle_root(
    leaf: Field,
    index_bits: [bool; TREE_DEPTH],
    siblings: [Field; TREE_DEPTH],
) -> Field {
    let mut current = leaf;
    for i in 0..TREE_DEPTH {
        let sibling = siblings[i];
        let (left, right) = if index_bits[i] {
            (sibling, current)
        } else {
            (current, sibling)
        };
        current = hash_2([left, right]);
    }
    current
}

// Verify a Merkle membership proof: recompute the root and assert equality.
pub fn assert_merkle_membership(
    leaf: Field,
    index_bits: [bool; TREE_DEPTH],
    siblings: [Field; TREE_DEPTH],
    root: Field,
) {
    assert(compute_merkle_root(leaf, index_bits, siblings) == root, "merkle membership check failed");
}

// The empty-leaf constant the SDK's CommitmentTree uses for an unfilled slot
// (32 zero bytes == field 0). `zeros[level+1] = hash(zeros[level], zeros[level])`.
pub global EMPTY_LEAF: Field = 0;

// Prove an append at an empty slot: the slot held EMPTY_LEAF (so recomputing the
// root from the siblings gives `old_root`), and placing `new_leaf` there with the
// SAME siblings gives `new_root`. `index_bits` is the position's little-endian
// bits (see `assert_index_bits`).
pub fn assert_insertion(
    new_leaf: Field,
    index_bits: [bool; TREE_DEPTH],
    siblings: [Field; TREE_DEPTH],
    old_root: Field,
    new_root: Field,
) {
    assert(compute_merkle_root(EMPTY_LEAF, index_bits, siblings) == old_root, "insertion: old_root mismatch (slot not empty)");
    assert(compute_merkle_root(new_leaf, index_bits, siblings) == new_root, "insertion: new_root not derived from this append");
}

// Assert `index_bits` (little-endian) is the bit-decomposition of `leaf_index`,
// so the insertion position proven in-circuit equals the public leaf index.
pub fn assert_index_bits(leaf_index: Field, index_bits: [bool; TREE_DEPTH]) {
    let mut acc: Field = 0;
    let mut pow: Field = 1;
    for i in 0..TREE_DEPTH {
        if index_bits[i] {
            acc = acc + pow;
        }
        pow = pow * 2;
    }
    assert(acc == leaf_index, "index_bits do not decompose leaf_index");
}

#[test]
fn test_assert_index_bits() {
    // index 5 = 0b...00101 -> little-endian bits [1,0,1,0,0,...]
    let mut bits: [bool; TREE_DEPTH] = [false; TREE_DEPTH];
    bits[0] = true;
    bits[2] = true;
    assert_index_bits(5, bits);
}

#[test]
fn test_assert_insertion_roundtrip() {
    // Depth-TREE_DEPTH tree, single append at index 0 into an all-empty tree.
    // Empty siblings are the precomputed zero-subtree hashes.
    let mut zeros: [Field; TREE_DEPTH] = [0; TREE_DEPTH];
    let mut z: Field = EMPTY_LEAF;
    for i in 0..TREE_DEPTH {
        zeros[i] = z;
        z = hash_2([z, z]);
    }
    let index_bits: [bool; TREE_DEPTH] = [false; TREE_DEPTH]; // index 0
    let new_leaf: Field = 42;
    let old_root = compute_merkle_root(EMPTY_LEAF, index_bits, zeros);
    let new_root = compute_merkle_root(new_leaf, index_bits, zeros);
    // Both asserts inside must pass for the correct (old_root, new_root).
    assert_insertion(new_leaf, index_bits, zeros, old_root, new_root);
}

// A fabricated new_root that is NOT the real append cannot satisfy the circuit:
// this is the crux of the tree-transition binding (a published root is proven).
#[test(should_fail_with = "insertion: new_root not derived from this append")]
fn test_assert_insertion_rejects_forged_new_root() {
    let mut zeros: [Field; TREE_DEPTH] = [0; TREE_DEPTH];
    let mut z: Field = EMPTY_LEAF;
    for i in 0..TREE_DEPTH {
        zeros[i] = z;
        z = hash_2([z, z]);
    }
    let index_bits: [bool; TREE_DEPTH] = [false; TREE_DEPTH];
    let new_leaf: Field = 42;
    let old_root = compute_merkle_root(EMPTY_LEAF, index_bits, zeros);
    let forged_new_root: Field = 999999; // unrelated to the real append
    assert_insertion(new_leaf, index_bits, zeros, old_root, forged_new_root);
}

// The public leaf_index cannot disagree with the in-circuit index bits.
#[test(should_fail_with = "index_bits do not decompose leaf_index")]
fn test_assert_index_bits_rejects_wrong_index() {
    let mut bits: [bool; TREE_DEPTH] = [false; TREE_DEPTH];
    bits[0] = true; // bits decode to index 1
    assert_index_bits(2, bits); // but the public index claims 2
}

// Bind the owner secret to the note's owner public key: proves the spender is
// the legitimate owner. (Schnorr-style: owner_sk * G == owner_pk.)
pub fn assert_owner(owner_sk: Field, owner_pk_x: Field, owner_pk_y: Field) {
    let derived = std::embedded_curve_ops::fixed_base_scalar_mul(
        std::embedded_curve_ops::EmbeddedCurveScalar::from_field(owner_sk),
    );
    assert(derived.x == owner_pk_x, "owner pk x mismatch");
    assert(derived.y == owner_pk_y, "owner pk y mismatch");
}

