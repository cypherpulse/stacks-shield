// =============================================================================
// STX Shield relayer -- request/response types
// =============================================================================
// The relayer submits a user's operation to Stacks and pays the transaction
// fee, so the chain sees ONLY the relayer's address. The user never appears.
//
// SECURITY MODEL — the relayer is trustless by construction:
//
//   Every operation parameter (nullifiers, commitments, amount, recipient,
//   roots) is hashed into the public-inputs hash, which is hashed into the
//   zkVerify statement leaf, which must appear in a published aggregation
//   root. Change ANY field and the leaf changes, the inclusion proof stops
//   verifying, and the transaction reverts.
//
//   So a relayer cannot: alter amounts, redirect recipients, swap
//   commitments, forge nullifiers, or replay someone else's operation for
//   its own benefit. It can only submit-or-not. Censorship is handled by
//   using several relayers (see the SDK's failover client).
//
// The relayer DOES see the operation's public parameters in the clear. It
// learns "someone withdrew N to address X" but never which note funded it,
// and never links it to the user's own address. Users who want to hide even
// that should use a relayer they do not otherwise transact with.

import { z } from "zod";

/** 32-byte value, hex, 0x-prefixed. */
export const Bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 32-byte hex");

/** Stacks principal (standard or contract). */
export const Principal = z
  .string()
  .regex(/^S[0-9A-Z]{38,40}(\.[a-zA-Z][a-zA-Z0-9-]*)?$/, "expected a Stacks principal");

/** The zkVerify inclusion proof every relayed operation carries. */
export const InclusionSchema = z.object({
  domainId: z.number().int().nonnegative(),
  aggregationId: z.number().int().nonnegative(),
  merklePath: z.array(Bytes32).max(32),
  leafIndex: z.number().int().nonnegative(),
});

/** Optional user authorization. NOT required for integrity — the proof
 *  already binds every parameter. Relayers may require it for fee policy or
 *  anti-spam, and may reject requests without it. */
export const AuthorizationSchema = z
  .object({
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    publicKey: z.string().regex(/^0x[0-9a-fA-F]{66}$/),
  })
  .optional();

const base = {
  inclusion: InclusionSchema,
  authorization: AuthorizationSchema,
  /** Opaque encrypted note payload for the receiver, echoed on chain in the
   *  operation's metadata field. The relayer cannot read it. */
  encryptedPayload: z.string().optional(),
};

export const TransferRequestSchema = z.object({
  ...base,
  nullifier: Bytes32,
  newCommitment: Bytes32,
  newOwnerCommitment: Bytes32,
  newMetadata: Bytes32,
  currentRoot: Bytes32,
  newRoot: Bytes32,
});

export const WithdrawRequestSchema = z.object({
  ...base,
  nullifier: Bytes32,
  amount: z.string().regex(/^\d+$/, "micro-STX as a decimal string"),
  recipient: Principal,
  root: Bytes32,
});

export const SplitRequestSchema = z.object({
  ...base,
  nullifier: Bytes32,
  commitment1: Bytes32,
  ownerCommitment1: Bytes32,
  metadata1: Bytes32,
  commitment2: Bytes32,
  ownerCommitment2: Bytes32,
  metadata2: Bytes32,
  currentRoot: Bytes32,
  newRoot: Bytes32,
});

export const MergeRequestSchema = z.object({
  ...base,
  nullifier1: Bytes32,
  nullifier2: Bytes32,
  commitment: Bytes32,
  ownerCommitment: Bytes32,
  metadata: Bytes32,
  currentRoot: Bytes32,
  newRoot: Bytes32,
});

/** Shield is deliberately NOT relayable: it moves STX *from* the caller, so
 *  the depositor must sign it themselves. Relaying it would mean handing the
 *  relayer your funds, and the deposit is public regardless. */
export const OPERATIONS = ["transfer", "withdraw", "split", "merge"] as const;
export type Operation = (typeof OPERATIONS)[number];

export type TransferRequest = z.infer<typeof TransferRequestSchema>;
export type WithdrawRequest = z.infer<typeof WithdrawRequestSchema>;
export type SplitRequest = z.infer<typeof SplitRequestSchema>;
export type MergeRequest = z.infer<typeof MergeRequestSchema>;
export type RelayRequest =
  | TransferRequest
  | WithdrawRequest
  | SplitRequest
  | MergeRequest;

export const SCHEMAS = {
  transfer: TransferRequestSchema,
  withdraw: WithdrawRequestSchema,
  split: SplitRequestSchema,
  merge: MergeRequestSchema,
} as const;

export type JobState = "queued" | "validating" | "submitting" | "confirmed" | "failed";

export interface RelayJob {
  id: string;
  operation: Operation;
  request: RelayRequest;
  state: JobState;
  txid?: string;
  error?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface RelayAccepted {
  jobId: string;
  operation: Operation;
  state: JobState;
}

export interface RelayerInfo {
  address: string;
  network: string;
  operations: readonly Operation[];
  /** Flat fee in micro-STX the relayer charges on top of the protocol fee. */
  relayFeeMicroStx: string;
  minRelayFeeMicroStx: string;
  accepting: boolean;
  contracts: { pool: string; splitMerge: string; verifier: string };
}

export class RelayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
