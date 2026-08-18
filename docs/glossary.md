# Glossary

The vocabulary of Stacks Shield, in one place. For how these fit together see the
[whitepaper](whitepaper.md) and [privacy model](privacy-model.md).

### Note
A private balance: `{ amount, owner keypair, blinding }`. The unit you hold and
spend. Its public fingerprint is a **commitment**; its spendable data is stored
only as encrypted ciphertext.

### Commitment
A Poseidon hash of a note that reveals nothing about its contents. The chain
stores commitments, never amounts or owners. STX:
`Poseidon4(amount, ownerPkX, ownerPkY, blinding)`. SIP-10:
`Poseidon2(Poseidon4(...), asset_id)`.

### Blinding
A random field element mixed into a commitment so that two notes of equal amount
produce different, unlinkable commitments.

### Nullifier
A deterministic value published when a note is spent, derived from the note's
secret. Registering the same nullifier twice is rejected — this prevents
**double-spends** without revealing which note was spent.

### Viewing key
The key that decrypts a note's encrypted payload. Derived from the wallet; used
locally to discover and read your own notes. Never leaves the device.

### Merkle tree / root
The append-only tree of all commitments (all assets share one). Its **root** is
published on chain; a spend proves its input commitment is a member of a known
root, in zero knowledge.

### Shield / Transfer / Split / Merge / Withdraw
The five operations: deposit into a note; move a note to a new owner; one note →
two; two notes → one; a note → transparent tokens. Each is proven in zero
knowledge; all but shield can be submitted by a relayer.

### Shielded pool
The contract(s) that custody deposited assets and hold the commitment set.
Native STX uses `privacy-pool`; all SIP-10 assets share `sip10-pool`.

### asset_id
A field-element derived from a SIP-10 token's contract principal
(`fePrincipal(token)`), bound into the commitment so an asset can never be spent
as a different asset. Native STX has no `asset_id`.

### Asset registry
The on-chain contract (`asset-registry`) listing supported assets — uid, token
principal, decimals, limits, fee config. Adding a token needs only registration
here; clients discover assets via the API's `/assets`.

### SIP-10
The Stacks fungible-token standard (analogous to ERC-20). Stacks Shield shields
SIP-10 tokens (e.g. sBTC, USDCx) alongside native STX.

### Conservation invariant
The rule that a pool never holds less than it owes: for each asset,
`token.balance(pool) == shielded-total[asset]`. Checked before any funds move.

### Noir / UltraHonk / Barretenberg
Noir is the ZK circuit language; UltraHonk (from Aztec's Barretenberg library) is
the proof system. Proofs are generated client-side via `@aztec/bb.js`.

### Poseidon
A ZK-friendly hash function used for commitments and nullifiers (cheap to prove
inside a circuit, unlike SHA-256).

### zkVerify
An external verification network that verifies each proof off chain and
**aggregates** verified statements into a Merkle root. Used because Clarity
cannot verify a pairing-based SNARK natively (see
[whitepaper §4](whitepaper.md#4-verification-architecture)).

### Aggregation / aggregation root
A batch of verified proof statements committed to a single Merkle root. The
relayer publishes the root on chain; the verifier contract checks that an
operation's statement is included in a published root.

### Relayer
A service that submits transfer/split/merge/withdraw **on the user's behalf**, so
the operation lands from the relayer's address and the user never appears on
chain. Trustless — it cannot alter a proven operation, only submit or withhold.

### Anonymity set
The crowd of indistinguishable deposits/withdrawals a user hides among. Larger is
better; it bounds *practical* privacy regardless of the cryptography.

### Trial-decryption
How a client finds its notes: it attempts to decrypt every ciphertext in the
public feed with its viewing key and keeps the ones that decrypt — the server
learns nothing about ownership.
