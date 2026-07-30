// =============================================================================
// STX Shield SDK -- transaction builders
// =============================================================================
// Builds the Stacks contract call for every user operation, in the exact
// argument order the Clarity functions expect so the on-chain public-inputs
// hash matches the SDK's.
//
// NOTE ON PRIVACY: spending operations carry NO note identifier. A spend
// publishes only its nullifier(s) plus the new commitment(s); which leaf was
// consumed is proven in-circuit against the Merkle root and never revealed.
// Adding a note id back to any of these argument lists would reintroduce the
// public transaction graph.

import { Cl, type ClarityValue } from "@stacks/transactions";
import type { Bytes32, ShieldConfig } from "../types.js";

/** zkVerify inclusion proof carried by every operation. */
export interface Inclusion {
  domainId: number;
  aggregationId: number;
  merklePath: readonly Bytes32[];
  leafIndex: number;
}

export interface ContractCall {
  readonly contractAddress: string;
  readonly contractName: string;
  readonly functionName: string;
  readonly functionArgs: readonly ClarityValue[];
}

const split = (id: string) => {
  const i = id.indexOf(".");
  return { address: id.slice(0, i), name: id.slice(i + 1) };
};

const inclusionArgs = (i: Inclusion): ClarityValue[] => [
  Cl.uint(i.domainId),
  Cl.uint(i.aggregationId),
  Cl.list(i.merklePath.map((p) => Cl.buffer(p))),
  Cl.uint(i.leafIndex),
];

export interface ShieldArgs {
  amount: bigint;
  commitment: Bytes32;
  ownerCommitment: Bytes32;
  metadata: Bytes32;
  currentRoot: Bytes32;
  newRoot: Bytes32;
  inclusion: Inclusion;
}

export interface TransferArgs {
  nullifier: Bytes32;
  newCommitment: Bytes32;
  newOwnerCommitment: Bytes32;
  newMetadata: Bytes32;
  currentRoot: Bytes32;
  newRoot: Bytes32;
  inclusion: Inclusion;
}

export interface WithdrawArgs {
  nullifier: Bytes32;
  amount: bigint;
  recipient: string;
  root: Bytes32;
  inclusion: Inclusion;
}

export interface SplitArgs {
  nullifier: Bytes32;
  commitment1: Bytes32;
  ownerCommitment1: Bytes32;
  metadata1: Bytes32;
  commitment2: Bytes32;
  ownerCommitment2: Bytes32;
  metadata2: Bytes32;
  currentRoot: Bytes32;
  newRoot: Bytes32;
  inclusion: Inclusion;
}

export interface MergeArgs {
  nullifier1: Bytes32;
  nullifier2: Bytes32;
  commitment: Bytes32;
  ownerCommitment: Bytes32;
  metadata: Bytes32;
  currentRoot: Bytes32;
  newRoot: Bytes32;
  inclusion: Inclusion;
}

export class TransactionBuilder {
  constructor(private readonly config: ShieldConfig) {}

  /** Shield is the one operation the USER must sign: it moves STX from their
   *  own account, so it can never be relayed. */
  shield(a: ShieldArgs): ContractCall {
    return this.call(this.config.contracts.pool, "shield", [
      Cl.uint(a.amount),
      Cl.buffer(a.commitment),
      Cl.buffer(a.ownerCommitment),
      Cl.buffer(a.metadata),
      Cl.buffer(a.currentRoot),
      Cl.buffer(a.newRoot),
      ...inclusionArgs(a.inclusion),
    ]);
  }

  transfer(a: TransferArgs): ContractCall {
    return this.call(this.config.contracts.pool, "transfer", [
      Cl.buffer(a.nullifier),
      Cl.buffer(a.newCommitment),
      Cl.buffer(a.newOwnerCommitment),
      Cl.buffer(a.newMetadata),
      Cl.buffer(a.currentRoot),
      Cl.buffer(a.newRoot),
      ...inclusionArgs(a.inclusion),
    ]);
  }

  withdraw(a: WithdrawArgs): ContractCall {
    return this.call(this.config.contracts.pool, "withdraw", [
      Cl.buffer(a.nullifier),
      Cl.uint(a.amount),
      Cl.principal(a.recipient),
      Cl.buffer(a.root),
      ...inclusionArgs(a.inclusion),
    ]);
  }

  split(a: SplitArgs): ContractCall {
    return this.call(this.config.contracts.splitMerge, "split-note", [
      Cl.buffer(a.nullifier),
      Cl.buffer(a.commitment1),
      Cl.buffer(a.ownerCommitment1),
      Cl.buffer(a.metadata1),
      Cl.buffer(a.commitment2),
      Cl.buffer(a.ownerCommitment2),
      Cl.buffer(a.metadata2),
      Cl.buffer(a.currentRoot),
      Cl.buffer(a.newRoot),
      ...inclusionArgs(a.inclusion),
    ]);
  }

  merge(a: MergeArgs): ContractCall {
    return this.call(this.config.contracts.splitMerge, "merge-notes", [
      Cl.buffer(a.nullifier1),
      Cl.buffer(a.nullifier2),
      Cl.buffer(a.commitment),
      Cl.buffer(a.ownerCommitment),
      Cl.buffer(a.metadata),
      Cl.buffer(a.currentRoot),
      Cl.buffer(a.newRoot),
      ...inclusionArgs(a.inclusion),
    ]);
  }

  private call(id: string, fn: string, args: ClarityValue[]): ContractCall {
    const { address, name } = split(id);
    return {
      contractAddress: address,
      contractName: name,
      functionName: fn,
      functionArgs: args,
    };
  }
}

// ---------------------------------------------------------------------------
// Relay payloads
// ---------------------------------------------------------------------------
// The same operation, serialized for a relayer instead of signed locally.
// Hex strings rather than Clarity values, because it crosses an HTTP boundary.
// A relayer that alters any field produces a different statement leaf and its
// transaction reverts, so this crossing is safe.

const hex = (b: Bytes32): string => "0x" + Buffer.from(b).toString("hex");

const relayInclusion = (i: Inclusion) => ({
  domainId: i.domainId,
  aggregationId: i.aggregationId,
  merklePath: i.merklePath.map(hex),
  leafIndex: i.leafIndex,
});

export const toRelayPayload = {
  transfer: (a: TransferArgs, encryptedPayload?: string) => ({
    nullifier: hex(a.nullifier),
    newCommitment: hex(a.newCommitment),
    newOwnerCommitment: hex(a.newOwnerCommitment),
    newMetadata: hex(a.newMetadata),
    currentRoot: hex(a.currentRoot),
    newRoot: hex(a.newRoot),
    inclusion: relayInclusion(a.inclusion),
    encryptedPayload,
  }),
  withdraw: (a: WithdrawArgs) => ({
    nullifier: hex(a.nullifier),
    amount: a.amount.toString(),
    recipient: a.recipient,
    root: hex(a.root),
    inclusion: relayInclusion(a.inclusion),
  }),
  split: (a: SplitArgs, encryptedPayload?: string) => ({
    nullifier: hex(a.nullifier),
    commitment1: hex(a.commitment1),
    ownerCommitment1: hex(a.ownerCommitment1),
    metadata1: hex(a.metadata1),
    commitment2: hex(a.commitment2),
    ownerCommitment2: hex(a.ownerCommitment2),
    metadata2: hex(a.metadata2),
    currentRoot: hex(a.currentRoot),
    newRoot: hex(a.newRoot),
    inclusion: relayInclusion(a.inclusion),
    encryptedPayload,
  }),
  merge: (a: MergeArgs, encryptedPayload?: string) => ({
    nullifier1: hex(a.nullifier1),
    nullifier2: hex(a.nullifier2),
    commitment: hex(a.commitment),
    ownerCommitment: hex(a.ownerCommitment),
    metadata: hex(a.metadata),
    currentRoot: hex(a.currentRoot),
    newRoot: hex(a.newRoot),
    inclusion: relayInclusion(a.inclusion),
    encryptedPayload,
  }),
} as const;
