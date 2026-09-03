// shield-note.nr -- STX Shield shield circuit (transparent STX -> 1 note).
// Proves the new note commits to exactly the public `amount`, is well-formed,
// and proves the tree transition: appending `commitment` at leaf_index (empty
// under old_root) yields new_root.
//
// Public inputs: op=1, commitment, owner_commitment, amount, old_root, new_root,
//                leaf_index, circuit_version.
use stx_shield_lib::{Note, assert_insertion, assert_index_bits, TREE_DEPTH};

fn main(
    op: pub Field,
    commitment: pub Field,
    owner_commitment: pub Field,
    amount: pub Field,
    old_root: pub Field,
    new_root: pub Field,
    leaf_index: pub Field,
    circuit_version: pub Field,
    note: Note,
    insertion_index_bits: [bool; TREE_DEPTH],
    insertion_siblings: [Field; TREE_DEPTH],
) {
    assert(op == 1, "wrong op for shield circuit");
    assert(circuit_version == 2, "unsupported circuit version");
    // the note commits to exactly the transparent deposit amount
    assert(note.amount == amount, "amount mismatch");
    amount.assert_max_bit_size::<64>();
    assert(note.commitment() == commitment, "commitment mismatch");
    assert(note.owner_commitment() == owner_commitment, "owner mismatch");

    // Append commitment at leaf_index (empty under old_root) to yield new_root.
    assert_index_bits(leaf_index, insertion_index_bits);
    assert_insertion(commitment, insertion_index_bits, insertion_siblings, old_root, new_root);
}
