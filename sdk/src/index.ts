// =============================================================================
// @stx-shield/sdk -- public API
// =============================================================================
// Privacy for STX in minutes. Import the client, point it at a network, and
// shield / transfer / split / merge / withdraw — without ever touching Noir,
// UltraHonk, zkVerify, Merkle trees, nullifiers, commitments or relayers.
//
//   import { STXShield } from "@stx-shield/sdk";
//   const shield = new STXShield({ network: "testnet", signer });
//   await shield.shield(100);

export { STXShield } from "./client/STXShield.js";

// Public types a developer needs.
export type { SDKConfig, Network } from "./types/config.js";
export type { ShieldNote, NoteSecret, Recipient } from "./types/note.js";
export type {
  ShieldResponse, TransferResponse, SplitResponse, MergeResponse, WithdrawResponse,
  Stats, HistoryEntry, OperationStatus,
} from "./types/response.js";
export type { WalletSigner, ContractCall } from "./types/wallet.js";

// Wallet-address helpers (share/receive privately).
export { encodeAddress, decodeAddress, type ShieldAddress } from "./notes/index.js";

// Typed errors for precise handling.
export {
  STXShieldError, InvalidNoteError, RootNotFoundError, ProofGenerationError,
  RelayerError, AuthenticationError, ApiError, ConfigError,
} from "./errors/index.js";

// Proof engine seam — inject your own (browser WASM / Node toolchain).
export type {
  ProofEngine, OwnerKey, Inclusion,
  ShieldWitness, TransferWitness, SplitWitness, MergeWitness, WithdrawWitness,
} from "./proving/engine.js";

export type { Logger, LogLevel } from "./utils/logger.js";
