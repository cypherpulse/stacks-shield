# Removing zkVerify from Stacks Shield — verification setups (SNARK vs STARK)

> A design preview: can Stacks Shield verify proofs without the external
> **zkVerify** aggregation layer, and if so how — keeping our current SNARKs, or
> switching to STARKs — while staying robust. Grounded in the **current** state
> of Clarity crypto (as of the Epoch 4.0 hardfork / Clarity 6, Aug 2026).

---

## 1. The constraint that drives everything

zkVerify is our one critical external dependency: it **verifies UltraHonk proofs
off chain** and aggregates them into a Merkle root the contracts trust. Removing
it means answering two separate questions:

1. **Who verifies the proof?** (today: zkVerify)
2. **What does the Clarity contract actually check?** (today: leaf ∈ published
   aggregation root)

The hard limit is what Clarity can compute on chain.

### What Clarity has today (Epoch 4.0 / Clarity 6)

- Hashes: `sha256`, `sha512`, `sha512/256`, `keccak256`, `hash160`, `ripemd160`
- `secp256k1-verify`, `secp256k1-recover?`
- **New in Clarity 6:** `verify-merkle-proof` (Bitcoin-style double-SHA256 Merkle
  inclusion against a known root) and `get-bitcoin-tx-output?`
- `uint` is **128-bit**

The recent hardfork added **Bitcoin-integration** primitives and a
signature-normalization consensus rule (SIP-005, rejecting high-S secp256k1
signatures) — **not** ZK precompiles.

### What Clarity still lacks for native SNARK verification

- **No BN254 / BLS12-381 pairing precompiles** (Ethereum EIP-196/197, Stellar
  Protocol 25, Cardano/Aiken all have these; Stacks does not).
- **No 254-bit field arithmetic** — a BN254 field element doesn't fit in a
  128-bit `uint`; you'd represent it as buffers and hand-roll modular arithmetic.
- No elliptic-curve group ops or pairings (Miller loop + final exponentiation).

**Consequence:** UltraHonk verification is KZG/pairing-based, so it **cannot run
natively in Clarity today** at any acceptable cost. "Remove zkVerify" is
therefore NOT the same as "verify on chain" — that door is still closed for
pairing SNARKs.

### The one thing the hardfork *does* give us

`verify-merkle-proof` is a native, cheap Merkle-inclusion primitive. Our
`zk-verifier` / `sip10-zk-verifier` already do a hand-rolled version of exactly
this (proof's public-input leaf ∈ published aggregation root). We can replace the
hand-rolled logic with the native primitive: **cheaper, less code, smaller bug
surface** — regardless of which path below we take.

---

## 2. Path 1 — Keep our SNARKs (UltraHonk), remove zkVerify

Since on-chain UltraHonk verification is blocked, we replace the *external*
verifier + aggregator with one **we control**, and make it robust by
decentralising trust using primitives Clarity already has.

### Setup: self-hosted **federated** verifier + on-chain multisig attestation

```
proof ─▶ N independent verifier nodes
          each runs bb.js verify   (the SAME check zkVerify did)
          each signs the aggregation root  (secp256k1)
                    │
        M-of-N signatures + Merkle root ─▶ Relayer ─▶ Stacks
                    │
   Clarity: verify M-of-N secp256k1 sigs on the root   ← native
            verify leaf ∈ root via verify-merkle-proof ← native (Clarity 6)
```

- **Contracts barely change.** Instead of "this root came from zkVerify," the
  rule becomes "this root carries M-of-N valid signatures from the registered
  verifier set." Both `secp256k1-verify` and `verify-merkle-proof` are native and
  cheap.
- **Trust moves** from "trust zkVerify" to "trust that at most M−1 of N federation
  members are dishonest," hardened by:
  - **Public re-verifiability** — anyone re-runs `bb.js verify` on the published
    proofs; a bad root is publicly detectable.
  - **Bonding + slashing** — verifiers post a bond, slashed on a proven bad
    attestation.
- **Robustness:** no single external chain in the liveness path; N operators give
  censorship-resistance; only standard curve ops on chain. **No circuit rewrite,
  no new Clarity precompiles.**
- **Endgame upgrade:** if a **pairing SIP** lands, switch the proving system to
  **Groth16** and verify the single pairing check on chain — deleting even the
  federation. The existing circuit-version upgrade path supports this migration
  (old notes stay spendable).

This is the **shortest robust route** that removes zkVerify while keeping
everything we've built.

---

## 3. Path 2 — Switch to STARKs

STARKs (FRI) are **hash-based — no pairings** — which is exactly what makes them
Clarity-friendly. Bonus: a STARK over the **Goldilocks field
(2⁶⁴ − 2³² + 1) fits in Clarity's 128-bit `uint`**, so field arithmetic needs no
big-integer buffers. Three setups, increasing ambition:

### 2a — Native on-chain FRI verifier (the real prize)
Write the FRI verifier in Clarity using `sha256`/`keccak256` + `verify-merkle-proof`.
No trusted party, no external chain, **no new precompiles**.
**Caveat:** a full FRI verify is many hashes + Merkle openings + low-degree
checks → the risk is Clarity's **per-transaction cost budget**, not the math.
Needs a cost prototype and aggressive tuning (fewer FRI queries, blowup factor,
field choice), likely combined with recursion (2c).

### 2b — STARK + the same federated attestation as Path 1
If native verification is too costly now, verify STARKs off chain in the
federation and attest on chain (M-of-N `secp256k1`). Removes zkVerify
immediately; keeps the door open to move verification on chain later. (Doesn't
yet exploit STARKs' on-chain advantage.)

### 2c — Recursive STARK → tiny final check (frontier)
Recursively compress many spends into one proof whose **final** on-chain check is
a handful of hashes / a single Merkle proof Clarity verifies cheaply. Best of
both worlds: hash-only + Clarity-affordable.

**Cost:** rewrite circuits from Noir/UltraHonk to a STARK stack (Cairo /
Winterfell / Plonky3 / RISC Zero), larger proofs, slower/heavier client proving —
in exchange for the only genuinely *native-on-chain-verifiable* route that needs
no Clarity upgrade.

---

## 4. Comparison

| | Keep SNARKs + federation (1) | Groth16 native (1, future) | STARK native (2a/2c) | STARK + federation (2b) |
|---|---|---|---|---|
| Removes zkVerify | ✅ now | ✅ | ✅ | ✅ now |
| Needs new Clarity precompile | ❌ | ✅ pairing SIP | ❌ | ❌ |
| Circuit rewrite | ❌ | partial (Groth16) | ✅ full | ✅ full |
| On-chain verification | attested (M-of-N) | native pairing | **native (hashes)** | attested |
| Trust model | federation (mitigated) | trustless | trustless | federation |
| Feasible today | ✅ | ⛔ (no SIP) | ⚠️ cost-gated | ✅ |
| Client proving | fast (unchanged) | fast | slower / heavier | slower / heavier |
| On-chain cost | low (sigs + merkle) | low (one pairing) | high (FRI) → tune | low |
| Proof size | small | small | large | large |

---

## 5. Trade-off summary

- **Keep SNARKs (UltraHonk):** smallest proofs, fastest client proving (what we
  already have), BUT verification needs pairings → cannot be native on Clarity
  today → must self-host + attest (federation), or wait for a pairing SIP and
  switch to Groth16.
- **STARKs:** no trusted setup, hash-only (Clarity-friendly), Goldilocks fits
  `uint128` → the **only** path to genuinely native on-chain verification with no
  new precompiles — but heavier verifier cost, bigger proofs, and a full circuit
  rewrite.

---

## 6. Recommendation

1. **Remove zkVerify now without a rewrite → Path 1.** Federated self-hosted
   verifier + M-of-N `secp256k1` attestation + native `verify-merkle-proof`
   inclusion. Robust via public re-verifiability + bonding/slashing; uses only
   primitives Clarity already has.
2. **Want truly trustless verification without waiting on a Clarity precompile →
   STARKs (2a/2c).** Commit to the rewrite, but first build a **Clarity FRI-verifier
   cost prototype** (Goldilocks + recursion) to confirm it fits the budget.
3. **If a pairing SIP lands → migrate SNARKs to Groth16** and verify on chain —
   the cleanest endgame; the version-upgrade path already supports it.

**Pragmatic sequence:** ship **Path 1** to cut the external dependency
immediately, and in parallel prototype the **2a** on-chain FRI cost to decide
whether the STARK rewrite buys full trustlessness at an acceptable on-chain cost.

Independently, **decentralising the relayer** (multiple relayers / a relayer
marketplace) removes the *other* trusted component — sender-privacy liveness —
which together with Path 1 (or 2/3) makes Stacks Shield self-contained on Stacks.

---

## 7. Sources

- [Clarity Functions — Stacks Documentation](https://docs.stacks.co/reference/functions)
- [stacks-core releases (Epoch 4.0 / Clarity 6)](https://github.com/stacks-network/stacks-core/releases)
- [Adding WebAuthn (P-256) support to Clarity — Stacks Forum](https://forum.stacks.org/t/adding-webauthn-p-256-support-to-clarity-for-native-passkey-integration/17886)
- [Announcing Stellar X-Ray, Protocol 25 — BN254/BLS pairing precompiles (context)](https://stellar.org/blog/developers/announcing-stellar-x-ray-protocol-25)
- [Aiken's BLS12-381 primitives, Cardano (context)](https://cardanofoundation.org/blog/aiken-primitives-explained)

> Note: Clarity's crypto surface changes with hardforks. Before committing,
> re-confirm against the live [Clarity functions reference](https://docs.stacks.co/reference/functions)
> and open SIPs — a pairing precompile could appear in a later epoch and would
> make Groth16-native (the cleanest SNARK endgame) immediately viable.
