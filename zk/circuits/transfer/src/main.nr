// transfer-note.nr -- STX Shield transfer circuit (1 note -> 1 note, private).
// Proves ownership + membership of the input, correct nullifier, value
// conservation into a single output for the hidden recipient.
//
// Public inputs: op=2, nullifier, new_commitment,
//                new_owner_commitment, merkle_root, circuit_version.
use stx_shield_lib::{Note, compute_nullifier, assert_merkle_membership, assert_owner, TREE_DEPTH};

fn main(
    op: pub Field,
    nullifier: pub Field,
    new_commitment: pub Field,
    new_owner_commitment: pub Field,
    merkle_root: pub Field,
    circuit_version: pub Field,
    input: Note,
    owner_sk: Field,
    merkle_index: [bool; TREE_DEPTH],
    merkle_siblings: [Field; TREE_DEPTH],
    output: Note,
) {
    assert(op == 2, "wrong op for transfer circuit");
    assert(circuit_version == 1, "unsupported circuit version");

    // The input commitment is PRIVATE: never published, so no
    // observer can link this spend to the leaf it consumes. Membership is
    // proven against the tree instead.
    let c = input.commitment();
    assert_owner(owner_sk, input.owner_pk_x, input.owner_pk_y);
    assert(compute_nullifier(c, owner_sk) == nullifier, "nullifier mismatch");
    assert_merkle_membership(c, merkle_index, merkle_siblings, merkle_root);

    // full value moves to the single output (no fee taken from shielded value)
    assert(input.amount == output.amount, "value not conserved");
    output.amount.assert_max_bit_size::<64>();
    assert(output.commitment() == new_commitment, "output commitment mismatch");
    assert(output.owner_commitment() == new_owner_commitment, "output owner mismatch");
}
