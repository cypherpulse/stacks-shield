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

// Verify a Merkle membership proof: recompute the root from `leaf` and the
// authentication path, and assert it equals `root`.
//
// `index_bits[i] == false` means `current` is the left child at level i.
// (`u1` was removed from Noir; the path index is carried as bools.)
pub fn assert_merkle_membership(
    leaf: Field,
    index_bits: [bool; TREE_DEPTH],
    siblings: [Field; TREE_DEPTH],
    root: Field,
) {
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
    assert(current == root, "merkle membership check failed");
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

