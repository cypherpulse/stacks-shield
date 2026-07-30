// shield-note.nr -- STX Shield shield circuit (transparent STX -> 1 note).
// Proves the new note commits to exactly the public `amount` and is
// well-formed. No tree membership (the note is a fresh leaf).
//
// Public inputs: op=1, commitment, owner_commitment, amount, circuit_version.
use stx_shield_lib::Note;

fn main(
    op: pub Field,
    commitment: pub Field,
    owner_commitment: pub Field,
    amount: pub Field,
    circuit_version: pub Field,
    note: Note,
) {
    assert(op == 1, "wrong op for shield circuit");
    assert(circuit_version == 1, "unsupported circuit version");
    // the note commits to exactly the transparent deposit amount
    assert(note.amount == amount, "amount mismatch");
    amount.assert_max_bit_size::<64>();
    assert(note.commitment() == commitment, "commitment mismatch");
    assert(note.owner_commitment() == owner_commitment, "owner mismatch");
}

