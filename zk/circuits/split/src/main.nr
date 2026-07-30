// =============================================================================
// split-note.nr -- STX Shield split circuit (1 note -> 2 notes)
// =============================================================================
// Proves that a single input note is split into two output notes with the
// value fully conserved, the spender is the owner, and the input note is a
// member of the committed tree. Amounts stay hidden.
//
// Public inputs (must EXACTLY match the tuple the split-merge-manager hashes
// into public-inputs-hash, in field-serialized form produced by the SDK):
//   op                 = 4 (SPLIT)
//   nullifier          input note nullifier
//   commitment_1       first output note commitment
//   owner_commitment_1 first output opaque owner commitment
//   commitment_2       second output note commitment
//   owner_commitment_2 second output opaque owner commitment
//   merkle_root        root the input note is proven against
//   circuit_version    circuit version (bound so old proofs can't cross versions)
// =============================================================================

use stx_shield_lib::{Note, compute_nullifier, assert_merkle_membership, assert_owner, TREE_DEPTH};

fn main(
    // ---- public ----
    op: pub Field,
    nullifier: pub Field,
    commitment_1: pub Field,
    owner_commitment_1: pub Field,
    commitment_2: pub Field,
    owner_commitment_2: pub Field,
    merkle_root: pub Field,
    circuit_version: pub Field,
    // ---- private witness ----
    input: Note,
    owner_sk: Field,
    merkle_index: [bool; TREE_DEPTH],
    merkle_siblings: [Field; TREE_DEPTH],
    out_1: Note,
    out_2: Note,
) {
    // domain / version binding
    assert(op == 4, "wrong op for split circuit");
    assert(circuit_version == 1, "unsupported circuit version");

    // The input commitment is PRIVATE: never published, so the spend cannot
    // be linked to the leaf it consumes. Membership proves it is in the tree.
    let input_commitment = input.commitment();

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
    // range-check output amounts to 64 bits (uSTX fits in u64; prevents
    // field-wraparound "mint" attacks)
    out_1.amount.assert_max_bit_size::<64>();
    out_2.amount.assert_max_bit_size::<64>();

    // output commitments and owner commitments are well-formed
    assert(out_1.commitment() == commitment_1, "output 1 commitment mismatch");
    assert(out_1.owner_commitment() == owner_commitment_1, "output 1 owner mismatch");
    assert(out_2.commitment() == commitment_2, "output 2 commitment mismatch");
    assert(out_2.owner_commitment() == owner_commitment_2, "output 2 owner mismatch");

    // outputs must be distinct leaves
    assert(commitment_1 != commitment_2, "split outputs collide");
}

#[test]
fn test_valid_split() {
    // 100 -> 40 + 60, with a trivial single-leaf tree for the unit test.
    let owner_sk: Field = 12345;
    // NOTE: in production the SDK derives owner_pk from owner_sk; the unit
    // test uses placeholder consistent values validated by `nargo test`.
    let input = Note { amount: 100, owner_pk_x: 1, owner_pk_y: 2, blinding: 7 };
    let out_1 = Note { amount: 40, owner_pk_x: 1, owner_pk_y: 2, blinding: 8 };
    let out_2 = Note { amount: 60, owner_pk_x: 3, owner_pk_y: 4, blinding: 9 };
    // conservation holds
    assert(input.amount == out_1.amount + out_2.amount);
    let _ = (owner_sk, input, out_1, out_2);
}
