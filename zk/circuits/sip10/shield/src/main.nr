// sip10-shield-note.nr -- SIP-10 shield circuit (transparent tokens -> 1 note).
// SIP-10 sibling of the STX shield circuit. Proves the new note commits to
// exactly the public `amount` FOR the public `asset_id`, is well-formed, and
// proves the tree transition: appending `commitment` at leaf_index (empty under
// old_root) yields new_root.
//
// Public inputs (order is CANONICAL; sip10-pool reproduces this exact tuple):
//   op=1, commitment, owner_commitment, amount, old_root, new_root, leaf_index,
//   asset_id, circuit_version
use stx_shield_sip10_lib::{Note, assert_asset_bound, assert_insertion, assert_index_bits, TREE_DEPTH};

fn main(
    // ---- public ----
    op: pub Field,
    commitment: pub Field,
    owner_commitment: pub Field,
    amount: pub Field,
    old_root: pub Field,
    new_root: pub Field,
    leaf_index: pub Field,
    asset_id: pub Field,
    circuit_version: pub Field,
    // ---- private witness ----
    note: Note,
    insertion_index_bits: [bool; TREE_DEPTH],
    insertion_siblings: [Field; TREE_DEPTH],
) {
    assert(op == 1, "wrong op for shield circuit");
    assert(circuit_version == 2, "unsupported circuit version");
    assert_asset_bound(asset_id);

    // the note commits to exactly the transparent deposit amount ...
    assert(note.amount == amount, "amount mismatch");
    amount.assert_max_bit_size::<64>();
    // ... FOR this asset: the commitment is a function of asset_id, so a proof
    // minted for one asset cannot be replayed to shield under another.
    assert(note.commitment(asset_id) == commitment, "commitment mismatch");
    assert(note.owner_commitment() == owner_commitment, "owner mismatch");

    // Append commitment at leaf_index (empty under old_root) to yield new_root.
    assert_index_bits(leaf_index, insertion_index_bits);
    assert_insertion(commitment, insertion_index_bits, insertion_siblings, old_root, new_root);
}
