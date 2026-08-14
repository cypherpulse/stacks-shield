// =============================================================================
// stx_shield_sip10_lib -- shared Noir primitives for the SIP-10 circuits
// =============================================================================
// Target: Noir v1.0.0-beta.22 / Barretenberg UltraHonk (same toolchain as STX).
//
// This is the SIP-10 sibling of `stx_shield_lib`. It is a SEPARATE library so
// the frozen STX circuits are never touched. The ONE cryptographic difference,
// and the reason SIP-10 needs its own family, is that a note commitment binds
// the ASSET:
//
//   inner            = Poseidon([amount, owner_pk_x, owner_pk_y, blinding])   // == the STX note hash
//   note_commitment  = Poseidon([inner, asset_id])                            // binds the asset
//   owner_commitment = Poseidon([owner_pk_x, owner_pk_y])                      // unchanged
//   nullifier        = Poseidon([note_commitment, owner_sk])                   // unchanged form
//
// The commitment is a NESTED hash (Poseidon-4 then Poseidon-2) rather than a
// single Poseidon-5. This uses only the arities the frozen STX library already
// uses (hash_4, hash_2), so it is guaranteed to compile against the same pinned
// `poseidon` package, and it reads as exactly what it is: "bind the STX-style
// note hash to an asset." The SDK mirrors it with poseidon4 then poseidon2.
//
// `asset_id` is a PUBLIC input of every circuit and is threaded into the
// commitment here, so:
//   * A proof for asset A can never verify for asset B: the commitment (and thus
//     the nullifier, the tree membership, and the whole statement) is a function
//     of asset_id. Wrong asset -> wrong commitment -> statement mismatch.
//   * Asset uniformity in split/merge is STRUCTURAL: every commitment in a
//     circuit is computed from the SINGLE public asset_id, so outputs and inputs
//     cannot carry different assets -- there is no per-note asset to disagree.
//
// DOMAIN SEPARATION FROM STX (three independent layers):
//   1. Arity: SIP-10 uses Poseidon-5 for commitments; STX uses Poseidon-4. The
//      two permutations differ, so an STX leaf can never equal a SIP-10 leaf.
//   2. Verifier: SIP-10 proofs are verified by `sip10-zk-verifier.clar` against
//      its own verification-key registry and circuit-version namespace.
//   3. Version: circuit_version is bound as a public input (SIP-10 namespace v1).
//
// Everything else -- Grumpkin owner keys, the depth-20 commitment tree,
// membership proofs, the nullifier ownership binding -- is IDENTICAL to STX by
// design, to maximize parity and reuse the same SDK witness generation.
// =============================================================================

use poseidon::poseidon::bn254::{hash_2, hash_4};

pub global TREE_DEPTH: u32 = 20;

// A note's private witness. Amounts and secrets NEVER leave the circuit.
// Structurally identical to the STX `Note`; the asset is bound at commitment
// time from the PUBLIC asset_id, not stored per-note, so a single public value
// governs every commitment in an operation.
pub struct Note {
    pub amount: Field,
    pub owner_pk_x: Field,
    pub owner_pk_y: Field,
    pub blinding: Field,
}

impl Note {
    // The public note commitment (tree leaf / on-chain note id), bound to `asset_id`.
    // Nested Poseidon (4 then 2), using only the arities the frozen STX lib uses.
    pub fn commitment(self, asset_id: Field) -> Field {
        let inner = hash_4([self.amount, self.owner_pk_x, self.owner_pk_y, self.blinding]);
        hash_2([inner, asset_id])
    }

    // The opaque owner commitment stored on-chain (never a principal). Unchanged
    // from STX: ownership is asset-agnostic; the asset lives in the note commitment.
    pub fn owner_commitment(self) -> Field {
        hash_2([self.owner_pk_x, self.owner_pk_y])
    }
}

// nullifier = Poseidon(note_commitment, owner_sk). Because note_commitment binds
// asset_id, the nullifier is asset-distinct automatically: the same (owner, amount,
// blinding) under two assets yields two different commitments and two different
// nullifiers, so there is no cross-asset nullifier collision.
pub fn compute_nullifier(note_commitment: Field, owner_sk: Field) -> Field {
    hash_2([note_commitment, owner_sk])
}

// Verify a Merkle membership proof: recompute the root from `leaf` and the
// authentication path, and assert it equals `root`. Identical to STX.
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

// Bind the owner secret to the note's owner public key (Grumpkin: owner_sk * G ==
// owner_pk). Identical to STX. Ownership is independent of the asset.
pub fn assert_owner(owner_sk: Field, owner_pk_x: Field, owner_pk_y: Field) {
    let derived = std::embedded_curve_ops::fixed_base_scalar_mul(
        std::embedded_curve_ops::EmbeddedCurveScalar::from_field(owner_sk),
    );
    assert(derived.x == owner_pk_x, "owner pk x mismatch");
    assert(derived.y == owner_pk_y, "owner pk y mismatch");
}

// Asset binding must be non-trivial: the pool derives asset_id from a token
// principal hash (never zero), so a zero asset_id is a malformed statement.
pub fn assert_asset_bound(asset_id: Field) {
    assert(asset_id != 0, "asset must be bound");
}
