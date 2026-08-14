// sip10-withdraw-note.nr -- SIP-10 withdraw circuit (1 note -> transparent tokens).
// SIP-10 sibling of the STX withdraw circuit. Proves ownership + membership of
// the note, correct nullifier, and that the note's hidden amount equals the
// public withdrawal `amount` -- all bound to the public `asset_id`. The recipient
// is bound as a public input so the attestation cannot be re-pointed.
//
// Public inputs (CANONICAL order; sip10-pool reproduces this exact tuple):
//   op=3, nullifier, amount, recipient_hash, merkle_root, asset_id, circuit_version
use stx_shield_sip10_lib::{Note, compute_nullifier, assert_merkle_membership, assert_owner, assert_asset_bound, TREE_DEPTH};

fn main(
    op: pub Field,
    nullifier: pub Field,
    amount: pub Field,
    recipient_hash: pub Field,
    merkle_root: pub Field,
    asset_id: pub Field,
    circuit_version: pub Field,
    input: Note,
    owner_sk: Field,
    merkle_index: [bool; TREE_DEPTH],
    merkle_siblings: [Field; TREE_DEPTH],
) {
    assert(op == 3, "wrong op for withdraw circuit");
    assert(circuit_version == 1, "unsupported circuit version");
    assert_asset_bound(asset_id);

    // The note commitment stays PRIVATE and asset-bound; membership is proven
    // against the tree, so the withdrawal cannot be linked to the leaf it
    // consumes, and only this asset's notes can produce a valid statement.
    let c = input.commitment(asset_id);
    assert_owner(owner_sk, input.owner_pk_x, input.owner_pk_y);
    assert(compute_nullifier(c, owner_sk) == nullifier, "nullifier mismatch");
    assert_merkle_membership(c, merkle_index, merkle_siblings, merkle_root);

    // the note's hidden amount must equal the public withdrawal amount exactly
    assert(input.amount == amount, "withdraw amount mismatch");
    amount.assert_max_bit_size::<64>();

    // recipient_hash is a public commitment to the recipient; the on-chain
    // contract binds the actual principal, and the circuit ties the proof to
    // this recipient so it cannot authorize a payout to anyone else.
    assert(recipient_hash != 0, "recipient must be bound");
}
