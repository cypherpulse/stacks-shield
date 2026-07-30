/**
 * Types mirroring the STX Shield SDK surface documented in frontendguide.md.
 * The SDK is the single source of truth — these are structural mirrors only,
 * so the UI stays type-safe while the workspace package provides the runtime.
 */

export type ShieldNetwork = "testnet" | "mainnet";

export interface ShieldNote {
  id?: string;
  commitment?: string;
  /** Amount in micro-STX (1 STX = 1_000_000 µSTX). */
  amount: bigint | number;
  status?: string;
  spent?: boolean;
  createdAt?: string | number;
  [key: string]: unknown;
}

export interface OperationResponse {
  txid: string;
  status: string;
  timestamp: string | number;
}

export interface ShieldResponse extends OperationResponse {
  note: ShieldNote;
}

export interface SplitResponse extends OperationResponse {
  notes: ShieldNote[];
}

export interface MergeResponse extends OperationResponse {
  note: ShieldNote;
}

export interface WithdrawResponse extends OperationResponse {
  recipient: string;
  amountReceived: bigint | number;
}

export interface Stats {
  shielded: number;
  notes: number;
  operations: number;
  users: number;
  fees: number;
  updatedAt: string;
}

export type OperationType = "shield" | "transfer" | "split" | "merge" | "withdraw";

export interface HistoryEntry {
  id?: string;
  type: OperationType | string;
  amount?: bigint | number;
  status?: string;
  txid?: string;
  timestamp?: string | number;
  createdAt?: string | number;
  [key: string]: unknown;
}

export interface ContractCall {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: unknown[];
}

export interface WalletSigner {
  getAddress(network: ShieldNetwork): Promise<string> | string;
  signMessage(message: string): Promise<{ signature: string; publicKey: string }>;
  signAndBroadcast(call: ContractCall, network: ShieldNetwork): Promise<string>;
  getShieldSecret(): Promise<Uint8Array> | Uint8Array;
}

/** The client surface the frontend is allowed to use. No extra methods. */
export interface STXShieldClient {
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  getAddress(): Promise<string>;
  getStats(): Promise<Stats>;
  getNotes(): Promise<ShieldNote[]>;
  getHistory(): Promise<HistoryEntry[]>;
  shield(amount: number): Promise<ShieldResponse>;
  transfer(amount: number, recipient: string): Promise<OperationResponse>;
  split(note: ShieldNote, amounts: [number, number]): Promise<SplitResponse>;
  merge(notes: [ShieldNote, ShieldNote]): Promise<MergeResponse>;
  withdraw(note: ShieldNote, recipient?: string): Promise<WithdrawResponse>;
}
