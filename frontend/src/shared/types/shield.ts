/**
 * Types mirroring the Stacks Shield SDK surface documented in frontendguide.md.
 * The SDK is the single source of truth — these are structural mirrors only,
 * so the UI stays type-safe while the workspace package provides the runtime.
 */

export type ShieldNetwork = "testnet" | "mainnet";

/**
 * A protocol asset — native STX or a registered SIP-10 token. Structural mirror
 * of the SDK's `AssetInfo` (sourced from GET /assets → on-chain asset-registry).
 */
export interface AssetInfo {
  id: number;
  symbol: string;
  /** SIP-10 token contract principal ("ADDR.name"), or null for native STX. */
  token: string | null;
  /** Base-unit decimals (STX = 6, sBTC = 8, USDCx = 6). */
  decimals: number;
  /** Shieldable right now (native STX is always active). */
  active: boolean;
  native: boolean;
  [key: string]: unknown;
}

/** How the UI names an asset to the SDK: symbol, token principal, AssetInfo, or
 *  undefined/null ⇒ native STX (the default). */
export type AssetRef = string | AssetInfo | null | undefined;

export interface ShieldNote {
  id?: string;
  commitment?: string;
  /** Amount in the asset's base units (µSTX for native STX). */
  amount: bigint | number;
  /** The asset this note holds. Undefined ⇒ native STX. */
  asset?: AssetInfo;
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

/** Per-asset protocol totals (shielded + fees), each in its own display units. */
export interface AssetStat {
  id: number;
  symbol: string;
  decimals: number;
  native: boolean;
  shielded: number;
  fees: number;
}

export interface Stats {
  shielded: number;
  notes: number;
  operations: number;
  users: number;
  fees: number;
  /** Per-asset breakdown (STX / sBTC / USDCx …). Absent on a legacy API. */
  byAsset?: AssetStat[];
  updatedAt: string;
}

export type OperationType = "shield" | "transfer" | "split" | "merge" | "withdraw";

export interface HistoryEntry {
  id?: string;
  type: OperationType | string;
  amount?: bigint | number;
  commitment?: string;
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

/** The client surface the frontend is allowed to use. No extra methods.
 *  Asset params are optional and default to native STX, so existing STX flows
 *  are unchanged while SIP-10 assets (sBTC, USDCx) route by symbol/token. */
export interface STXShieldClient {
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  getAddress(): Promise<string>;
  getStats(): Promise<Stats>;
  getAssets(): Promise<AssetInfo[]>;
  getNotes(asset?: AssetRef): Promise<ShieldNote[]>;
  getHistory(): Promise<HistoryEntry[]>;
  shield(amount: number, asset?: AssetRef): Promise<ShieldResponse>;
  transfer(amount: number, recipient: string, asset?: AssetRef): Promise<OperationResponse>;
  split(note: ShieldNote, amounts: [number, number]): Promise<SplitResponse>;
  merge(notes: [ShieldNote, ShieldNote]): Promise<MergeResponse>;
  withdraw(note: ShieldNote, recipient?: string): Promise<WithdrawResponse>;
}
