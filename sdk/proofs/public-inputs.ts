// =============================================================================
// STX Shield SDK -- public-inputs hashing
// =============================================================================
// Reproduces the EXACT public-inputs-hash each contract computes:
//   sha256( to-consensus-buff? { ...operation params } )
// mirrored here with sha256(serializeCVBytes(Cl.tuple({...}))). These MUST
// match the contracts (privacy-pool + split-merge-manager) field-for-field,
// or on-chain proof binding fails. Verified equivalent by the passing
// contract test suite, which uses the identical construction.

import { Cl, serializeCVBytes } from "@stacks/transactions";
import { sha256, toHex } from "../utilities/crypto.js";
import { ProofType, type Bytes32 } from "../types.js";

const buf = (b: Bytes32) => Cl.buffer(b);
const hashTuple = (cv: ReturnType<typeof Cl.tuple>): Bytes32 =>
  sha256(serializeCVBytes(cv));

export interface ShieldInputs {
  commitment: Bytes32;
  ownerCommitment: Bytes32;
  metadata: Bytes32;
  amount: bigint;
  currentRoot: Bytes32;
  newRoot: Bytes32;
}
export const shieldInputsHash = (o: ShieldInputs): Bytes32 =>
  hashTuple(
    Cl.tuple({
      op: Cl.uint(ProofType.Shield),
      commitment: buf(o.commitment),
      "owner-commitment": buf(o.ownerCommitment),
      metadata: buf(o.metadata),
      amount: Cl.uint(o.amount),
      "current-root": buf(o.currentRoot),
      "new-root": buf(o.newRoot),
    }),
  );

export interface TransferInputs {
  oldNote: Bytes32;
  nullifier: Bytes32;
  newCommitment: Bytes32;
  newOwnerCommitment: Bytes32;
  newMetadata: Bytes32;
  currentRoot: Bytes32;
  newRoot: Bytes32;
}
export const transferInputsHash = (o: TransferInputs): Bytes32 =>
  hashTuple(
    Cl.tuple({
      op: Cl.uint(ProofType.Transfer),
      "old-note": buf(o.oldNote),
      nullifier: buf(o.nullifier),
      "new-commitment": buf(o.newCommitment),
      "new-owner-commitment": buf(o.newOwnerCommitment),
      "new-metadata": buf(o.newMetadata),
      "current-root": buf(o.currentRoot),
      "new-root": buf(o.newRoot),
    }),
  );

export interface WithdrawInputs {
  noteId: Bytes32;
  nullifier: Bytes32;
  amount: bigint;
  recipient: string;
  root: Bytes32;
}
export const withdrawInputsHash = (o: WithdrawInputs): Bytes32 =>
  hashTuple(
    Cl.tuple({
      op: Cl.uint(ProofType.Withdrawal),
      "note-id": buf(o.noteId),
      nullifier: buf(o.nullifier),
      amount: Cl.uint(o.amount),
      recipient: Cl.principal(o.recipient),
      root: buf(o.root),
    }),
  );

export interface SplitInputs {
  oldNote: Bytes32;
  nullifier: Bytes32;
  commitment1: Bytes32;
  ownerCommitment1: Bytes32;
  metadata1: Bytes32;
  commitment2: Bytes32;
  ownerCommitment2: Bytes32;
  metadata2: Bytes32;
  currentRoot: Bytes32;
  newRoot: Bytes32;
}
export const splitInputsHash = (o: SplitInputs): Bytes32 =>
  hashTuple(
    Cl.tuple({
      op: Cl.uint(ProofType.Split),
      "old-note": buf(o.oldNote),
      nullifier: buf(o.nullifier),
      "commitment-1": buf(o.commitment1),
      "owner-commitment-1": buf(o.ownerCommitment1),
      "metadata-1": buf(o.metadata1),
      "commitment-2": buf(o.commitment2),
      "owner-commitment-2": buf(o.ownerCommitment2),
      "metadata-2": buf(o.metadata2),
      "current-root": buf(o.currentRoot),
      "new-root": buf(o.newRoot),
    }),
  );

export interface MergeInputs {
  oldNote1: Bytes32;
  nullifier1: Bytes32;
  oldNote2: Bytes32;
  nullifier2: Bytes32;
  commitment: Bytes32;
  ownerCommitment: Bytes32;
  metadata: Bytes32;
  currentRoot: Bytes32;
  newRoot: Bytes32;
}
export const mergeInputsHash = (o: MergeInputs): Bytes32 =>
  hashTuple(
    Cl.tuple({
      op: Cl.uint(ProofType.Merge),
      "old-note-1": buf(o.oldNote1),
      "nullifier-1": buf(o.nullifier1),
      "old-note-2": buf(o.oldNote2),
      "nullifier-2": buf(o.nullifier2),
      commitment: buf(o.commitment),
      "owner-commitment": buf(o.ownerCommitment),
      metadata: buf(o.metadata),
      "current-root": buf(o.currentRoot),
      "new-root": buf(o.newRoot),
    }),
  );

/** Debug helper: the hex of a public-inputs hash. */
export const inputsHashHex = (h: Bytes32): string => toHex(h);
