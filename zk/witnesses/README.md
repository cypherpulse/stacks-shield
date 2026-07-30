# zk/witnesses

Witness inputs for each circuit. In production these are generated
programmatically by `sdk/witness` (private note data + Merkle paths never
touch disk); the `Prover.toml.example` files here document the ABI shape each
circuit expects for `nargo prove` / local debugging.

One subdirectory per operation: `shield/`, `transfer/`, `withdraw/`, `split/`,
`merge/`. Public fields must match the corresponding contract's
public-inputs tuple exactly (the SDK guarantees this via
`sdk/proofs/public-inputs.ts`).
