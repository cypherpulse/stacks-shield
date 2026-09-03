// =============================================================================
// STX Shield SDK -- canonical public-input encoding
// =============================================================================
// THE single source of truth for what every operation commits to. The circuits,
// both contracts, this module, and zkVerify must all hash identical bytes; if
// any of them disagrees, proofs are rejected and the protocol is unusable.
//
// A circuit public input is a BN254 field element. Barretenberg serializes each
// as 32 bytes BIG-ENDIAN and zkVerify hashes the concatenation with keccak256:
//
//     publicInputsHash = keccak256( fe_0 ‖ fe_1 ‖ … ‖ fe_n )
//
// in the circuit's DECLARATION ORDER.
//
// CORRECTNESS RULE:
//   Hash exactly the circuit's public inputs, in declaration order — no more, no
//   less. The tree transition IS part of the statement: every leaf-adding op
//   binds `old_root`/`merkle_root`, `new_root`, and `leaf_index`. `metadata` and
//   note ids are NOT circuit inputs — they stay contract-level checks.
//
// Mirrors `fe-uint` / `fe-principal` and the per-operation constructions in
// privacy-pool.clar and split-merge-manager.clar.

import { serializeCVBytes, principalCV } from "@stacks/transactions";
import { keccak256, sha256 } from "../utilities/crypto.js";
import type { Bytes32 } from "../types.js";

export const OP = {
  SHIELD: 1,
  TRANSFER: 2,
  WITHDRAW: 3,
  SPLIT: 4,
  MERGE: 5,
} as const;

const concatAll = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};

/** uint -> 32-byte big-endian field element. Mirrors `fe-uint`. */
export const feUint = (n: bigint | number): Bytes32 => {
  const v = BigInt(n);
  if (v < 0n) throw new Error("field elements are unsigned");
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x > 0n) throw new Error("value does not fit in a 32-byte field element");
  return out;
};

/**
 * principal -> field element. Mirrors `fe-principal`: sha256 over the Clarity
 * consensus encoding with the top byte zeroed.
 *
 * The zeroing is not cosmetic — a raw 32-byte hash can exceed the BN254
 * modulus and then is not a valid field element at all. Forcing the high byte
 * to zero bounds the value below 2^248 < p.
 */
export const fePrincipal = (address: string): Bytes32 => {
  const digest = sha256(serializeCVBytes(principalCV(address)));
  const out = new Uint8Array(digest);
  out[0] = 0;
  return out;
};

/** Field elements are already 32 bytes; validated rather than assumed. */
const fe32 = (b: Bytes32): Bytes32 => {
  if (b.length !== 32) throw new Error(`field element must be 32 bytes, got ${b.length}`);
  return b;
};

const hash = (fields: Bytes32[]): Bytes32 => keccak256(concatAll(fields));

// ---------------------------------------------------------------------------
// One function per circuit. The field list IS the specification.
// ---------------------------------------------------------------------------

/** shield: op, commitment, owner_commitment, amount, old_root, new_root, leaf_index, circuit_version */
export const shieldPublicInputs = (o: {
  commitment: Bytes32;
  ownerCommitment: Bytes32;
  amount: bigint;
  oldRoot: Bytes32;
  newRoot: Bytes32;
  leafIndex: number | bigint;
  circuitVersion: number;
}): Bytes32 =>
  hash([
    feUint(OP.SHIELD),
    fe32(o.commitment),
    fe32(o.ownerCommitment),
    feUint(o.amount),
    fe32(o.oldRoot),
    fe32(o.newRoot),
    feUint(o.leafIndex),
    feUint(o.circuitVersion),
  ]);

/** transfer: op, nullifier, new_commitment, new_owner_commitment, merkle_root, new_root, leaf_index, circuit_version */
export const transferPublicInputs = (o: {
  nullifier: Bytes32;
  newCommitment: Bytes32;
  newOwnerCommitment: Bytes32;
  merkleRoot: Bytes32;
  newRoot: Bytes32;
  leafIndex: number | bigint;
  circuitVersion: number;
}): Bytes32 =>
  hash([
    feUint(OP.TRANSFER),
    fe32(o.nullifier),
    fe32(o.newCommitment),
    fe32(o.newOwnerCommitment),
    fe32(o.merkleRoot),
    fe32(o.newRoot),
    feUint(o.leafIndex),
    feUint(o.circuitVersion),
  ]);

/** withdraw: op, nullifier, amount, recipient_hash, merkle_root, circuit_version */
export const withdrawPublicInputs = (o: {
  nullifier: Bytes32;
  amount: bigint;
  recipient: string;
  merkleRoot: Bytes32;
  circuitVersion: number;
}): Bytes32 =>
  hash([
    feUint(OP.WITHDRAW),
    fe32(o.nullifier),
    feUint(o.amount),
    fePrincipal(o.recipient),
    fe32(o.merkleRoot),
    feUint(o.circuitVersion),
  ]);

/** split: op, nullifier, commitment_1, owner_commitment_1, commitment_2, owner_commitment_2, merkle_root, new_root, leaf_index, circuit_version */
export const splitPublicInputs = (o: {
  nullifier: Bytes32;
  commitment1: Bytes32;
  ownerCommitment1: Bytes32;
  commitment2: Bytes32;
  ownerCommitment2: Bytes32;
  merkleRoot: Bytes32;
  newRoot: Bytes32;
  leafIndex: number | bigint;
  circuitVersion: number;
}): Bytes32 =>
  hash([
    feUint(OP.SPLIT),
    fe32(o.nullifier),
    fe32(o.commitment1),
    fe32(o.ownerCommitment1),
    fe32(o.commitment2),
    fe32(o.ownerCommitment2),
    fe32(o.merkleRoot),
    fe32(o.newRoot),
    feUint(o.leafIndex),
    feUint(o.circuitVersion),
  ]);

/** merge: op, nullifier_1, nullifier_2, commitment, owner_commitment, merkle_root, new_root, leaf_index, circuit_version */
export const mergePublicInputs = (o: {
  nullifier1: Bytes32;
  nullifier2: Bytes32;
  commitment: Bytes32;
  ownerCommitment: Bytes32;
  merkleRoot: Bytes32;
  newRoot: Bytes32;
  leafIndex: number | bigint;
  circuitVersion: number;
}): Bytes32 =>
  hash([
    feUint(OP.MERGE),
    fe32(o.nullifier1),
    fe32(o.nullifier2),
    fe32(o.commitment),
    fe32(o.ownerCommitment),
    fe32(o.merkleRoot),
    fe32(o.newRoot),
    feUint(o.leafIndex),
    feUint(o.circuitVersion),
  ]);

/**
 * The raw field-element vector for an operation, in circuit order. This is
 * what the prover feeds the circuit as public inputs and what zkVerify
 * hashes — exposed so tests can assert the SDK, the contracts, and the actual
 * `public_inputs` file barretenberg emits all agree.
 */
export const publicInputVector = {
  shield: (o: Parameters<typeof shieldPublicInputs>[0]): Bytes32[] => [
    feUint(OP.SHIELD),
    o.commitment,
    o.ownerCommitment,
    feUint(o.amount),
    o.oldRoot,
    o.newRoot,
    feUint(o.leafIndex),
    feUint(o.circuitVersion),
  ],
  transfer: (o: Parameters<typeof transferPublicInputs>[0]): Bytes32[] => [
    feUint(OP.TRANSFER),
    o.nullifier,
    o.newCommitment,
    o.newOwnerCommitment,
    o.merkleRoot,
    o.newRoot,
    feUint(o.leafIndex),
    feUint(o.circuitVersion),
  ],
  withdraw: (o: Parameters<typeof withdrawPublicInputs>[0]): Bytes32[] => [
    feUint(OP.WITHDRAW),
    o.nullifier,
    feUint(o.amount),
    fePrincipal(o.recipient),
    o.merkleRoot,
    feUint(o.circuitVersion),
  ],
  split: (o: Parameters<typeof splitPublicInputs>[0]): Bytes32[] => [
    feUint(OP.SPLIT),
    o.nullifier,
    o.commitment1,
    o.ownerCommitment1,
    o.commitment2,
    o.ownerCommitment2,
    o.merkleRoot,
    o.newRoot,
    feUint(o.leafIndex),
    feUint(o.circuitVersion),
  ],
  merge: (o: Parameters<typeof mergePublicInputs>[0]): Bytes32[] => [
    feUint(OP.MERGE),
    o.nullifier1,
    o.nullifier2,
    o.commitment,
    o.ownerCommitment,
    o.merkleRoot,
    o.newRoot,
    feUint(o.leafIndex),
    feUint(o.circuitVersion),
  ],
} as const;

/** Hash a raw vector — the exact operation zkVerify performs. */
export const hashPublicInputVector = (fields: Bytes32[]): Bytes32 =>
  keccak256(concatAll(fields.map(fe32)));
