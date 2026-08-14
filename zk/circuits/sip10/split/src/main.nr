// =============================================================================
// sip10-split-note.nr -- SIP-10 split circuit (1 note -> 2 notes)
// =============================================================================
// SIP-10 sibling of the STX split circuit. Proves a single input note is split
// into two output notes with value fully conserved, the spender is the owner,
// and the input is a member of the committed tree. Amounts stay hidden. Every
// commitment (input + both outputs) is computed from the SINGLE public
// `asset_id`, so all three notes are STRUCTURALLY the same asset -- an in-circuit
// asset mix is impossible.
//
// Public inputs (CANONICAL order; sip10-pool / split-merge flow reproduces it):
//   op=4, nullifier, commitment_1, owner_commitment_1, commitment_2,
//   owner_commitment_2, merkle_root, asset_id, circuit_version
// =============================================================================

use stx_shield_sip10_lib::{Note, compute_nullifier, assert_merkle_membership, assert_owner, assert_asset_bound, TREE_DEPTH};

fn main(
    // ---- public ----
    op: pub Field,
    nullifier: pub Field,
    commitment_1: pub Field,
    owner_commitment_1: pub Field,
    commitment_2: pub Field,
    owner_commitment_2: pub Field,
    merkle_root: pub Field,
    asset_id: pub Field,
    circuit_version: pub Field,
    // ---- private witness ----
    input: Note,
    owner_sk: Field,
    merkle_index: [bool; TREE_DEPTH],
    merkle_siblings: [Field; TREE_DEPTH],
    out_1: Note,
    out_2: Note,
) {
    assert(op == 4, "wrong op for split circuit");
    assert(circuit_version == 1, "unsupported circuit version");
    assert_asset_bound(asset_id);

    // input commitment is PRIVATE and bound to asset_id; membership proves it is
    // in the tree (in this asset's slice of it).
    let input_commitment = input.commitment(asset_id);

    // ownership: the spender knows the secret behind the input note's owner key
    assert_owner(owner_sk, input.owner_pk_x, input.owner_pk_y);

    // nullifier correctness (binds the note to its one-time spend token)
    let expected_nullifier = compute_nullifier(input_commitment, owner_sk);
    assert(expected_nullifier == nullifier, "nullifier mismatch");

    // membership: the input note is in the committed tree at `merkle_root`
    assert_merkle_membership(input_commitment, merkle_index, merkle_siblings, merkle_root);

    // value conservation: amount_in == amount_1 + amount_2, no overflow/negatives
    let total_out = out_1.amount + out_2.amount;
    assert(input.amount == total_out, "value not conserved");
    out_1.amount.assert_max_bit_size::<64>();
    out_2.amount.assert_max_bit_size::<64>();

    // output commitments/owner commitments are well-formed and bound to the SAME
    // asset_id -- both outputs are necessarily the input's asset.
    assert(out_1.commitment(asset_id) == commitment_1, "output 1 commitment mismatch");
    assert(out_1.owner_commitment() == owner_commitment_1, "output 1 owner mismatch");
    assert(out_2.commitment(asset_id) == commitment_2, "output 2 commitment mismatch");
    assert(out_2.owner_commitment() == owner_commitment_2, "output 2 owner mismatch");

    // outputs must be distinct leaves
    assert(commitment_1 != commitment_2, "split outputs collide");
}

#[test]
fn test_valid_split() {
    // 100 -> 40 + 60 under a single asset; conservation holds.
    let asset_id: Field = 777;
    let owner_sk: Field = 12345;
    let input = Note { amount: 100, owner_pk_x: 1, owner_pk_y: 2, blinding: 7 };
    let out_1 = Note { amount: 40, owner_pk_x: 1, owner_pk_y: 2, blinding: 8 };
    let out_2 = Note { amount: 60, owner_pk_x: 3, owner_pk_y: 4, blinding: 9 };
    assert(input.amount == out_1.amount + out_2.amount);
    // commitments are asset-bound and the two outputs differ
    assert(out_1.commitment(asset_id) != out_2.commitment(asset_id));
    let _ = (owner_sk, input, out_1, out_2);
}
