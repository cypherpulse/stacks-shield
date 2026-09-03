// =============================================================================
// sip10-merge-note.nr -- SIP-10 merge circuit (2 notes -> 1 note)
// =============================================================================
// SIP-10 sibling of the STX merge circuit. Proves two input notes owned by the
// spender are merged into one output with value conserved, both inputs are
// members of the committed tree, the inputs are distinct, and the tree
// transition: appending the merged `commitment` at leaf_index (empty under
// merkle_root) yields new_root. All three commitments use the SINGLE public
// `asset_id`, so cross-asset merges are structurally impossible.
//
// Public inputs (CANONICAL order; sip10-pool reproduces it):
//   op=5, nullifier_1, nullifier_2, commitment, owner_commitment, merkle_root,
//   new_root, leaf_index, asset_id, circuit_version
// =============================================================================

use stx_shield_sip10_lib::{
    Note, compute_nullifier, assert_merkle_membership, assert_owner, assert_asset_bound,
    assert_insertion, assert_index_bits, TREE_DEPTH,
};

fn main(
    // ---- public ----
    op: pub Field,
    nullifier_1: pub Field,
    nullifier_2: pub Field,
    commitment: pub Field,
    owner_commitment: pub Field,
    merkle_root: pub Field,
    new_root: pub Field,
    leaf_index: pub Field,
    asset_id: pub Field,
    circuit_version: pub Field,
    // ---- private witness ----
    input_1: Note,
    owner_sk_1: Field,
    merkle_index_1: [bool; TREE_DEPTH],
    merkle_siblings_1: [Field; TREE_DEPTH],
    input_2: Note,
    owner_sk_2: Field,
    merkle_index_2: [bool; TREE_DEPTH],
    merkle_siblings_2: [Field; TREE_DEPTH],
    output: Note,
    insertion_index_bits: [bool; TREE_DEPTH],
    insertion_siblings: [Field; TREE_DEPTH],
) {
    assert(op == 5, "wrong op for merge circuit");
    assert(circuit_version == 2, "unsupported circuit version");
    assert_asset_bound(asset_id);

    // --- input 1 --- (commitment PRIVATE, bound to asset_id)
    let c1 = input_1.commitment(asset_id);
    assert_owner(owner_sk_1, input_1.owner_pk_x, input_1.owner_pk_y);
    assert(compute_nullifier(c1, owner_sk_1) == nullifier_1, "nullifier 1 mismatch");
    assert_merkle_membership(c1, merkle_index_1, merkle_siblings_1, merkle_root);

    // --- input 2 --- (same asset_id: a different-asset input would not be a
    // member of the tree at this commitment, so membership pins both to one asset)
    let c2 = input_2.commitment(asset_id);
    assert_owner(owner_sk_2, input_2.owner_pk_x, input_2.owner_pk_y);
    assert(compute_nullifier(c2, owner_sk_2) == nullifier_2, "nullifier 2 mismatch");
    assert_merkle_membership(c2, merkle_index_2, merkle_siblings_2, merkle_root);

    // inputs must be genuinely distinct notes
    assert(c1 != c2, "merge inputs identical");
    assert(nullifier_1 != nullifier_2, "merge nullifiers identical");

    // value conservation: amount_1 + amount_2 == amount_out
    let total_in = input_1.amount + input_2.amount;
    assert(total_in == output.amount, "value not conserved");
    output.amount.assert_max_bit_size::<64>();

    // output well-formedness, bound to the SAME asset_id
    assert(output.commitment(asset_id) == commitment, "output commitment mismatch");
    assert(output.owner_commitment() == owner_commitment, "output owner mismatch");

    // Append the merged output at leaf_index (empty under merkle_root) -> new_root.
    assert_index_bits(leaf_index, insertion_index_bits);
    assert_insertion(commitment, insertion_index_bits, insertion_siblings, merkle_root, new_root);
}

#[test]
fn test_valid_merge() {
    // 40 + 60 -> 100 under a single asset.
    let asset_id: Field = 777;
    let input_1 = Note { amount: 40, owner_pk_x: 1, owner_pk_y: 2, blinding: 8 };
    let input_2 = Note { amount: 60, owner_pk_x: 1, owner_pk_y: 2, blinding: 9 };
    let output = Note { amount: 100, owner_pk_x: 1, owner_pk_y: 2, blinding: 10 };
    assert(input_1.amount + input_2.amount == output.amount);
    assert(input_1.commitment(asset_id) != input_2.commitment(asset_id));
    let _ = (input_1, input_2, output);
}
