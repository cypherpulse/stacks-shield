# STX Shield — SIP-10 Circuit Family

The SIP-10 proving family: a faithful, asset-aware sibling of the frozen STX
circuits. The **only** cryptographic difference is that a note commitment binds
`asset_id`. Everything else — Grumpkin owner keys, the depth-20 tree, membership,
nullifier ownership binding, 64-bit amount range checks, `op`/`circuit_version`
binding — is identical to STX, so the same SDK witness generation and the same
zkVerify/UltraHonk proving pipeline are reused.

> STX circuits (`zk/circuits/{shield,transfer,split,merge,withdraw,lib}`) are
> **frozen and untouched**. This family lives beside them under
> `zk/circuits/sip10/` and shares no files.

Target toolchain (same as STX): Noir 1.0.0-beta.18 / bb 3.0.0-nightly.20260102,
`poseidon` package pinned at `v0.2.6`.

---

## 1. Architecture overview

```
zk/circuits/sip10/
  lib/       stx_shield_sip10_lib  -- Note (asset-aware commitment), nullifier,
             membership, owner binding, asset-bound assertion
  shield/    op=1  transparent tokens -> 1 note        (no membership)
  transfer/  op=2  1 note -> 1 note (private recipient)
  split/     op=4  1 note -> 2 notes
  merge/     op=5  2 notes -> 1 note
  withdraw/  op=3  1 note -> transparent tokens
```

Operation ids (`op`) reuse the protocol proof types u1–u5. Each circuit binds
its `op` and `circuit_version` as public inputs, exactly like STX.

---

## 2. Commitment specification

```
inner            = Poseidon4(amount, owner_pk_x, owner_pk_y, blinding)   // == the STX note hash
note_commitment  = Poseidon2(inner, asset_id)                           // binds the asset
owner_commitment = Poseidon2(owner_pk_x, owner_pk_y)
```

- The commitment is a **nested** hash (Poseidon-4 then Poseidon-2), using only the
  arities the frozen STX lib already uses (`hash_4` / `hash_2` from the `poseidon`
  package), so it compiles against the same pinned toolchain — verified with
  `nargo check` on 1.0.0-beta.18. It reads as exactly what it is: "bind the
  STX-style note hash to an asset."
- The SDK mirrors it with `poseidon-lite` `poseidon4` then `poseidon2` (the same
  functions the STX SDK already uses, same parameter set).
- `asset_id` is a **public** input of every circuit; the note struct does not
  store it, so a single public value governs every commitment in an operation.
- Domain separation from STX holds: an STX leaf is `Poseidon4(...)` directly,
  while a SIP-10 leaf is `Poseidon2(Poseidon4(...), asset_id)` — structurally
  different values that never coincide.

### asset_id derivation (must be byte-identical in circuit, SDK, and pool)

```
asset_id = field( sha256( consensus-serialize(token-principal) )[1..32] with top byte forced to 0 )
```

This is byte-for-byte the pool's existing `fe-principal` derivation (used today
for STX withdraw recipients), so the value the circuit binds, the value the SDK
hashes into the commitment, and the value `sip10-pool` folds into `inputs-hash`
are provably the same. Top byte zeroed ⇒ always `< 2^248 < p` (a valid field
element, never zero for a real principal).

---

## 3. Nullifier specification

```
nullifier = Poseidon2(note_commitment, owner_sk)
```

Same form as STX. Because `note_commitment` binds `asset_id`, nullifiers are
**asset-distinct automatically**: identical (owner, amount, blinding) under two
assets produce two different commitments and two different nullifiers. No
cross-asset nullifier collision or shared-namespace griefing is possible.

---

## 4. Public-input specification (CANONICAL — `sip10-pool` reproduces exactly)

Every value is serialized by the SDK/contract as a 32-byte big-endian BN254 field
element; `sip10-pool` computes `inputs_hash = keccak256(fe_0 ‖ … ‖ fe_n)` over
these, in this exact order. **`asset_id` is always the public input immediately
before `circuit_version`** — a uniform rule across the family.

| Circuit | Public inputs (declaration order) |
|---|---|
| **shield** (op=1) | `op, commitment, owner_commitment, amount, asset_id, circuit_version` |
| **transfer** (op=2) | `op, nullifier, new_commitment, new_owner_commitment, merkle_root, asset_id, circuit_version` |
| **withdraw** (op=3) | `op, nullifier, amount, recipient_hash, merkle_root, asset_id, circuit_version` |
| **split** (op=4) | `op, nullifier, commitment_1, owner_commitment_1, commitment_2, owner_commitment_2, merkle_root, asset_id, circuit_version` |
| **merge** (op=5) | `op, nullifier_1, nullifier_2, commitment, owner_commitment, merkle_root, asset_id, circuit_version` |

`circuit_version == 1` in the **SIP-10 namespace** — verified by
`sip10-zk-verifier.clar` against its own VK registry. It is independent of the
STX registry's circuit version (which is also 1); they never collide because the
two families are verified by different contracts with different VKs.

This table is normative. `sip10-pool.clar` MUST hash these tuples in this order;
any reordering silently breaks verification.

---

## 5. Witness specification (private inputs)

| Circuit | Private witness |
|---|---|
| shield | `note: Note` |
| transfer | `input: Note, owner_sk, merkle_index[20], merkle_siblings[20], output: Note` |
| withdraw | `input: Note, owner_sk, merkle_index[20], merkle_siblings[20]` |
| split | `input: Note, owner_sk, merkle_index[20], merkle_siblings[20], out_1: Note, out_2: Note` |
| merge | `input_1, owner_sk_1, merkle_index_1[20], merkle_siblings_1[20], input_2, owner_sk_2, merkle_index_2[20], merkle_siblings_2[20], output: Note` |

`Note = { amount, owner_pk_x, owner_pk_y, blinding }` (identical to STX). `asset_id`
is public, not part of the note. `merkle_index` is `[bool; 20]` (left/right path).

---

## 6. Security review & per-circuit invariants

### Cross-cutting invariants (all circuits)
- **Asset binding:** every commitment is `Poseidon5(…, asset_id)` with `asset_id`
  a public input; `assert_asset_bound(asset_id)` rejects `asset_id == 0`.
- **Op/version binding:** `op` and `circuit_version` asserted, preventing a proof
  for one operation/version from being used as another.
- **Range safety:** all note amounts range-checked to 64 bits, preventing
  field-wraparound "mint" attacks.
- **Determinism:** only field arithmetic and fixed Poseidon calls; no
  nondeterminism.

### Threats → mitigations
- **Cross-asset proof reuse / asset substitution:** the statement is a function of
  `asset_id` (commitment → nullifier → membership → public inputs). A proof for
  asset A cannot satisfy asset B's statement. The pool additionally binds the
  token principal it will `transfer` to the same `asset_id`, so on-chain value
  movement and the proof agree on the asset.
- **In-circuit asset mixing (split/merge):** impossible — every commitment uses
  the single public `asset_id`, so inputs and outputs are structurally one asset;
  membership can hold for only one `asset_id` at a time.
- **Replay resistance:** nullifiers are one-time (registered by `privacy-registry`);
  statement-level replay is caught by `sip10-zk-verifier`'s verified-proof set.
- **Nullifier/commitment uniqueness:** split asserts `commitment_1 != commitment_2`;
  merge asserts `c1 != c2` and `nullifier_1 != nullifier_2`.
- **Witness consistency:** `assert_owner` binds `owner_sk` to `owner_pk` (Grumpkin
  `sk·G == pk`); the nullifier binds the note commitment to `owner_sk`; membership
  binds the commitment to the tree. A malformed witness fails one of these.
- **Malformed public inputs:** `asset_id != 0`, `recipient_hash != 0`, `op` and
  `circuit_version` fixed; the pool independently validates amounts/limits and the
  asset registration.
- **Field validity:** inputs are BN254 field elements by type; `asset_id`'s top
  byte is zeroed in derivation so it is always a valid element.
- **Domain separation from STX (three layers):** (1) commitment arity —
  Poseidon-5 vs STX Poseidon-4 (different permutations ⇒ an STX leaf can never
  equal a SIP-10 leaf); (2) a dedicated verifier with its own VKs; (3)
  `circuit_version` bound in the SIP-10 namespace.
- **Incorrect public-input ordering:** the §4 table is the single source of
  truth; the pool's `inputs-hash` construction must match it field-for-field.
- **Soundness assumptions:** UltraHonk soundness + BN254/Grumpkin hardness +
  Poseidon collision resistance, identical to the native STX family.

---

## 7. Integration notes

- **SDK:** `sdk/src/notes/sip10` computes `commitment = poseidon2([poseidon4([
  amount, owner_pk_x, owner_pk_y, blinding]), asset_id])` and derives `asset_id`
  from the token principal exactly as above; proving reuses the existing bb.js engine.
- **Pool:** `sip10-pool.clar` reproduces each §4 tuple into `inputs-hash` and
  calls `sip10-zk-verifier.verify-proof` with `circuit_version = 1`.
- **Verifier:** `sip10-zk-verifier.clar` holds the five VKs under proof-types
  u1–u5 at its own `circuit_version` 1, and reuses the frozen verifier's published
  aggregation roots.

## 8. Build / key material (operational — run with the frozen toolchain)

```
cd zk/circuits/sip10/<circuit> && nargo compile      # produces target/*.json
# then bb: generate proving + verification keys; register vk hashes on zkVerify
# Volta; set the (proof-type, circuit-version=1) bindings in sip10-zk-verifier.
```

`nargo test` runs the in-circuit unit tests in `split` and `merge`.
