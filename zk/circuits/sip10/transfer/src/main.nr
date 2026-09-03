// sip10-transfer-note.nr -- SIP-10 transfer circuit (1 note -> 1 note, private).
// SIP-10 sibling of the STX transfer circuit. Proves ownership + membership of
// the input, correct nullifier, value conservation into a single output for the
// hidden recipient, and the tree transition: new_commitment is appended at
// leaf_index (empty under merkle_root) to yield new_root.
//
// Public inputs (CANONICAL order; sip10-pool reproduces this exact tuple):
//   op=2, nullifier, new_commitment, new_owner_commitment, merkle_root,
//   new_root, leaf_index, asset_id, circuit_version
use stx_shield_sip10_lib::{
    Note, compute_nullifier, assert_merkle_membership, assert_owner, assert_asset_bound,
    assert_insertion, assert_index_bits, TREE_DEPTH,
};

fn main(
    // ---- public ----
    op: pub Field,
    nullifier: pub Field,
    new_commitment: pub Field,
    new_owner_commitment: pub Field,
    merkle_root: pub Field,
    new_root: pub Field,
    leaf_index: pub Field,
    asset_id: pub Field,
    circuit_version: pub Field,
    // ---- private witness ----
    input: Note,
    owner_sk: Field,
    merkle_index: [bool; TREE_DEPTH],
    merkle_siblings: [Field; TREE_DEPTH],
    insertion_index_bits: [bool; TREE_DEPTH],
    insertion_siblings: [Field; TREE_DEPTH],
    output: Note,
) {
    assert(op == 2, "wrong op for transfer circuit");
    assert(circuit_version == 2, "unsupported circuit version");
    assert_asset_bound(asset_id);

    // Spend: the input commitment is PRIVATE and asset-bound; membership proves it
    // is in the tree, so no observer can link this spend to the leaf it consumes.
    let c = input.commitment(asset_id);
    assert_owner(owner_sk, input.owner_pk_x, input.owner_pk_y);
    assert(compute_nullifier(c, owner_sk) == nullifier, "nullifier mismatch");
    assert_merkle_membership(c, merkle_index, merkle_siblings, merkle_root);

    // Full value moves to the single output, bound to the SAME asset_id.
    assert(input.amount == output.amount, "value not conserved");
    output.amount.assert_max_bit_size::<64>();
    assert(output.commitment(asset_id) == new_commitment, "output commitment mismatch");
    assert(output.owner_commitment() == new_owner_commitment, "output owner mismatch");

    // Append new_commitment at leaf_index (empty under merkle_root) to yield
    // new_root, from the same siblings.
    assert_index_bits(leaf_index, insertion_index_bits);
    assert_insertion(
        new_commitment,
        insertion_index_bits,
        insertion_siblings,
        merkle_root, // the append's old_root == the membership root
        new_root,
    );
}
