# Privacy model

What Stacks Shield hides, what it necessarily reveals, and the cryptography that
draws the line. For the full protocol see the [whitepaper](whitepaper.md).

## What is hidden vs public

| | Hidden | Public |
|---|---|---|
| **Shield** | which note is created, its blinding | depositor address, amount, asset |
| **Transfer** | sender, recipient, amount, asset | that *some* shielded op happened (a nullifier + a new commitment) |
| **Split / Merge** | amounts, owner, asset | a nullifier + new commitment(s) |
| **Withdraw** | which note was spent, the depositor it came from | recipient address, amount, asset |

The **transparent edges**, shield and withdraw, expose an amount and an
address by construction. Privacy comes from *unlinkability*: nothing connects a
withdrawal to the deposit that funded it, and transfers/splits/merges reveal
neither value nor participants.

## The building blocks

### Notes and commitments
A note is `{ amount, owner keypair, blinding }`. Its on-chain fingerprint is a
Poseidon commitment:

- STX: `Poseidon4(amount, ownerPkX, ownerPkY, blinding)`
- SIP-10: `Poseidon2( Poseidon4(...), asset_id )`, `asset_id = fePrincipal(token)`

`blinding` (a random field element) makes two notes of the same amount
indistinguishable. The chain stores only the commitment, never the amount or
owner. Binding `asset_id` in makes the asset part of the note's identity, so a
note of one asset cannot be spent as another even though all assets share one
tree.

### Nullifiers
Spending publishes a nullifier derived from the note secret and its tree
position. The registry rejects a repeat, preventing double-spends. Because the
nullifier is computed from secrets absent from the commitment, observers cannot
link a nullifier to the commitment it spends, so a spend is unlinkable to the
note's creation.

### The shared Merkle tree
Every commitment (all assets) lives in one tree; spends prove membership under a
published root in zero knowledge. One shared tree means one shared **anonymity
set**: the crowd you hide in, rather than a smaller separate set per asset.

### Encrypted notes and viewing keys
The note's spendable data is encrypted to the owner's **viewing key** and
published as opaque ciphertext. To find their notes, a client **trial-decrypts**
the public feed locally; the amount is recovered on the device and never leaves
it. The API only ever stores ciphertext and public locators, no amounts,
secrets, or ownership.

### Sender privacy via the relayer
ZK hides *what* moved but not *who broadcast the transaction*. A **relayer**
submits transfer/split/merge/withdraw, so the operation lands from the relayer's
address and the user never appears on chain. The relayer cannot alter anything, every parameter is bound into the proof.

## The anonymity set, the honest caveat

Cryptography guarantees *unlinkability*; it does not manufacture a crowd. Your
practical privacy is bounded by how many other deposits and withdrawals look like
yours. Today the set is small, so real-world privacy is limited regardless of the
math. It improves with:

- **More users and volume** (a busier pool).
- **Common denominations** (round, shared amounts rather than unique ones).
- **Time** between shielding and withdrawing (breaking timing correlation).
- **The shared multi-asset tree**, which pools activity across STX, sBTC and USDCx
  rather than splitting it.

## What an observer can still infer

- Deposit and withdrawal **amounts and addresses** (the transparent edges).
- The **rate** of shielded activity (each spend emits a nullifier + commitment).
- Nothing linking a specific deposit to a specific withdrawal, and nothing about
  transferred amounts or counterparties.

See also: [security](security.md) · [architecture](architecture.md).
