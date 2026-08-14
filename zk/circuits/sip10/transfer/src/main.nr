// sip10-transfer-note.nr -- SIP-10 transfer circuit (1 note -> 1 note, private).
// SIP-10 sibling of the STX transfer circuit. Proves ownership + membership of
// the input, correct nullifier, and value conservation into a single output for
// the hidden recipient -- all bound to the public `asset_id`.
//
// Public inputs (CANONICAL order; sip10-pool reproduces this exact tuple):
//   op=2, nullifier, new_commitment, new_owner_commitment, merkle_root,
//   asset_id, circuit_version
use stx_shield_sip10_lib::{Note, compute_nullifier, assert_merkle_membership, assert_owner, assert_asset_bound, TREE_DEPTH};

fn main(
    op: pub Field,
    nullifier: pub Field,
    new_commitment: pub Field,
    new_owner_commitment: pub Field,
    merkle_root: pub Field,
    asset_id: pub Field,
    circuit_version: pub Field,
    input: Note,
    owner_sk: Field,
    merkle_index: [bool; TREE_DEPTH],
    merkle_siblings: [Field; TREE_DEPTH],
    output: Note,
) {
    assert(op == 2, "wrong op for transfer circuit");
    assert(circuit_version == 1, "unsupported circuit version");
    assert_asset_bound(asset_id);

    // The input commitment is PRIVATE and asset-bound: membership is proven
    // against the tree, so no observer can link this spend to the leaf it
    // consumes, and the leaf only exists in this asset's slice of the tree.
    let c = input.commitment(asset_id);
    assert_owner(owner_sk, input.owner_pk_x, input.owner_pk_y);
    assert(compute_nullifier(c, owner_sk) == nullifier, "nullifier mismatch");
    assert_merkle_membership(c, merkle_index, merkle_siblings, merkle_root);

    // full value moves to the single output (no fee taken from shielded value).
    // The output commitment is bound to the SAME asset_id, so a transfer cannot
    // change the asset of the moved value.
    assert(input.amount == output.amount, "value not conserved");
    output.amount.assert_max_bit_size::<64>();
    assert(output.commitment(asset_id) == new_commitment, "output commitment mismatch");
    assert(output.owner_commitment() == new_owner_commitment, "output owner mismatch");
}
