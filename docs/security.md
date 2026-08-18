# Security

Threat model, guarantees, invariants, and trust assumptions. See the
[whitepaper §7](whitepaper.md#7-security-model) for the protocol context.

## Threat model

We consider:

- A **global passive observer** reading all chain data.
- **Active on-chain adversaries** submitting malformed operations, replays, or
  double-spend attempts.
- A **malicious relayer** trying to alter, forge, or steal from operations it
  submits.
- A **malicious SIP-10 token** (lying balances, fee-on-transfer, reentrancy).
- A **curious API/indexer operator** trying to learn amounts or ownership.

## Guarantees

- **Confidentiality.** Commitments, nullifiers, and encrypted payloads reveal no
  amount, owner, or linkage (see [privacy model](privacy-model.md)).
- **No forgery.** An operation is accepted only if a valid proof's statement — a
  keccak hash binding the vkey hash, version, and canonical public inputs
  (including `asset_id`) — is included in a published aggregation. Any parameter
  change invalidates the statement.
- **No double-spend / replay.** Three independent append-only guards:
  1. registry **nullifiers** (a nullifier registers exactly once),
  2. **note-state** transitions (a spent note never transitions again),
  3. the verifier's **per-aggregation** records.
- **Value conservation.** Enforced in every circuit (outputs + fee = inputs) and
  reinforced on chain by the per-pool conservation invariant, checked *before*
  any funds move.
- **Authority delegation.** Only `privacy-registry` stores the owner, roles, and
  the authorized-caller allowlist; every protected write is gated by
  `contract-caller`. Not even the owner writes commitments, nullifiers, notes, or
  fees directly.

## Key invariants

- **Native STX:** `privacy-pool` STX balance == registry `total-shielded-stx`.
- **Each SIP-10 asset A:** `token_A.balance(sip10-pool) == shielded-total[A]`
  (shield adds to both, withdraw subtracts from both). The accounting gate runs
  before any tokens move, so a pool can never pay out more than is shielded.

## Defences by threat

| Threat | Defence |
|---|---|
| Forged / altered operation | Parameters bound into the proof statement; only included statements are accepted |
| Double-spend / replay | Append-only nullifier set + note-state machine + per-aggregation records |
| Malicious relayer | Relayer can submit-or-not (liveness only); it cannot change amount, recipient, asset, or commitments |
| Lying / fee-on-transfer token | Pool measures its own token-balance **delta** and rejects any transfer whose observed movement ≠ the claimed amount (`ERR-TOKEN-TRANSFER-MISMATCH`) |
| Curious indexer/API | API stores only ciphertext + public locators; amounts/owners are recovered locally by trial-decryption |
| Protocol emergency | Registry state machine (ACTIVE/PAUSED/EMERGENCY/UPGRADING/DEPRECATED) + per-contract freezes + per-operation switches; roots, vkeys, and notes can be frozen |

## Trust assumptions (be explicit)

1. **Verification is delegated to zkVerify.** Clarity cannot verify an UltraHonk
   proof natively (no pairing precompiles), so the contracts trust zkVerify's
   verification and check only aggregation inclusion on chain. This is a real
   trust and **liveness** dependency. The roadmap to native, on-chain
   verification is in the
   [whitepaper §9](whitepaper.md#9-toward-native-zk-verification-on-stacks).
2. **Relayer liveness.** A single relayer is a censorship/liveness chokepoint (it
   cannot steal or alter). Decentralising the relayer set removes this.
3. **Deployer keys.** The registry owner holds governance/upgrade authority.
   Standard operational key-management assumptions apply.

## Assurance status

- **Not audited.** No third-party security audit has been performed.
- **Testnet only.** Not deployed to mainnet.
- Validated by a layered test suite (contract unit/attack/fuzz, integration,
  privacy, SDK, and live real-proof end-to-end for STX, USDCx and sBTC) — but
  tests are not a substitute for an audit.

Report a vulnerability privately — see [SECURITY.md](../SECURITY.md) — before any
public disclosure.

See also: [privacy model](privacy-model.md) · [architecture](architecture.md) ·
[whitepaper](whitepaper.md).
