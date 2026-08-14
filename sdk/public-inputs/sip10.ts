// =============================================================================
// STX Shield SDK -- canonical SIP-10 public-input encoding
// =============================================================================
// The asset-aware sibling of `./index.ts`. Identical construction, with one
// added field: `asset_id`, placed immediately before `circuit_version` in every
// tuple, exactly as the SIP-10 circuits declare it (zk/circuits/sip10/README.md)
// and as `sip10-pool.clar` reproduces it into `inputs-hash`.
//
//   asset_id = fePrincipal(token-contract-principal)
//
// This is THE single source of truth the SIP-10 circuits, sip10-pool, this
// module, the tests, and zkVerify must all agree on.

import { keccak256 } from "../utilities/crypto.js";
import { feUint, fePrincipal, OP } from "./index.js";
import type { Bytes32 } from "../types.js";

const concatAll = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

const fe32 = (b: Bytes32): Bytes32 => {
  if (b.length !== 32) throw new Error(`field element must be 32 bytes, got ${b.length}`);
  return b;
};

const hash = (fields: Bytes32[]): Bytes32 => keccak256(concatAll(fields));

/** asset_id field element derived from the token contract principal. */
export const assetIdOf = (tokenPrincipal: string): Bytes32 => fePrincipal(tokenPrincipal);

/** shield: op, commitment, owner_commitment, amount, asset_id, circuit_version */
export const shieldPublicInputsSip10 = (o: {
  commitment: Bytes32;
  ownerCommitment: Bytes32;
  amount: bigint;
  token: string;
  circuitVersion: number;
}): Bytes32 =>
  hash([
    feUint(OP.SHIELD),
    fe32(o.commitment),
    fe32(o.ownerCommitment),
    feUint(o.amount),
    assetIdOf(o.token),
    feUint(o.circuitVersion),
  ]);

/** transfer: op, nullifier, new_commitment, new_owner_commitment, merkle_root, asset_id, circuit_version */
export const transferPublicInputsSip10 = (o: {
  nullifier: Bytes32;
  newCommitment: Bytes32;
  newOwnerCommitment: Bytes32;
  merkleRoot: Bytes32;
  token: string;
  circuitVersion: number;
}): Bytes32 =>
  hash([
    feUint(OP.TRANSFER),
    fe32(o.nullifier),
    fe32(o.newCommitment),
    fe32(o.newOwnerCommitment),
    fe32(o.merkleRoot),
    assetIdOf(o.token),
    feUint(o.circuitVersion),
  ]);

/** withdraw: op, nullifier, amount, recipient_hash, merkle_root, asset_id, circuit_version */
export const withdrawPublicInputsSip10 = (o: {
  nullifier: Bytes32;
  amount: bigint;
  recipient: string;
  merkleRoot: Bytes32;
  token: string;
  circuitVersion: number;
}): Bytes32 =>
  hash([
    feUint(OP.WITHDRAW),
    fe32(o.nullifier),
    feUint(o.amount),
    fePrincipal(o.recipient),
    fe32(o.merkleRoot),
    assetIdOf(o.token),
    feUint(o.circuitVersion),
  ]);

/** split: op, nullifier, c1, oc1, c2, oc2, merkle_root, asset_id, circuit_version */
export const splitPublicInputsSip10 = (o: {
  nullifier: Bytes32;
  commitment1: Bytes32;
  ownerCommitment1: Bytes32;
  commitment2: Bytes32;
  ownerCommitment2: Bytes32;
  merkleRoot: Bytes32;
  token: string;
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
    assetIdOf(o.token),
    feUint(o.circuitVersion),
  ]);

/** merge: op, nullifier_1, nullifier_2, commitment, owner_commitment, merkle_root, asset_id, circuit_version */
export const mergePublicInputsSip10 = (o: {
  nullifier1: Bytes32;
  nullifier2: Bytes32;
  commitment: Bytes32;
  ownerCommitment: Bytes32;
  merkleRoot: Bytes32;
  token: string;
  circuitVersion: number;
}): Bytes32 =>
  hash([
    feUint(OP.MERGE),
    fe32(o.nullifier1),
    fe32(o.nullifier2),
    fe32(o.commitment),
    fe32(o.ownerCommitment),
    fe32(o.merkleRoot),
    assetIdOf(o.token),
    feUint(o.circuitVersion),
  ]);
