// sip10-shield-note.nr -- SIP-10 shield circuit (transparent tokens -> 1 note).
// SIP-10 sibling of the STX shield circuit. Proves the new note commits to
// exactly the public `amount` FOR the public `asset_id`, and is well-formed.
// No tree membership (the note is a fresh leaf).
//
// Public inputs (order is CANONICAL; sip10-pool reproduces this exact tuple):
//   op=1, commitment, owner_commitment, amount, asset_id, circuit_version
use stx_shield_sip10_lib::{Note, assert_asset_bound};

fn main(
    op: pub Field,
    commitment: pub Field,
    owner_commitment: pub Field,
    amount: pub Field,
    asset_id: pub Field,
    circuit_version: pub Field,
    note: Note,
) {
    assert(op == 1, "wrong op for shield circuit");
    assert(circuit_version == 1, "unsupported circuit version");
    assert_asset_bound(asset_id);

    // the note commits to exactly the transparent deposit amount ...
    assert(note.amount == amount, "amount mismatch");
    amount.assert_max_bit_size::<64>();
    // ... FOR this asset: the commitment is a function of asset_id, so a proof
    // minted for one asset cannot be replayed to shield under another.
    assert(note.commitment(asset_id) == commitment, "commitment mismatch");
    assert(note.owner_commitment() == owner_commitment, "owner mismatch");
}
