// =============================================================================
// @stx-shield/sdk -- configuration types
// =============================================================================

import type { ProofEngine } from "../proving/engine.js";
import type { WalletSigner } from "./wallet.js";
import type { Logger } from "../utils/logger.js";

export type Network = "testnet" | "mainnet";

export interface SDKConfig {
  /** Which network to talk to. Sets sensible default URLs and contract addresses. */
  network: Network;

  /** Public API base URL. Defaults to the network's hosted API. */
  apiUrl?: string;
  /** Relayer base URL (single). Prefer `relayerUrls` for failover. */
  relayerUrl?: string;
  /** Multiple relayers for censorship-resistant failover. */
  relayerUrls?: string[];

  /** Contract deployer address (contracts derive from it). Defaults per network. */
  deployer?: string;

  /**
   * Signs shield transactions (which move the user's own STX) and the auth
   * nonce. In the browser this wraps @stacks/connect; in Node, a key-based
   * signer. If omitted, read-only + relayed operations still work where they
   * do not need a user signature.
   */
  signer?: WalletSigner;

  /**
   * Generates zero-knowledge proofs and derives owner keys. Defaults to the
   * Node CLI engine when the Noir/Barretenberg toolchain is available;
   * a browser (WASM) engine can be injected. Developers never call this
   * directly -- the SDK drives it.
   */
  proofEngine?: ProofEngine;

  /** Optional structured logger. Never logs secrets. */
  logger?: Logger;

  /** Per-request timeout (ms) for API/relayer calls. Default 30000. */
  timeoutMs?: number;

  /**
   * How proofs reach zkVerify. Provide `endpointUrl` (a hosted submitter,
   * recommended for end users) or `seed` (direct submission from a funded
   * zkVerify account — development / server-side). Omit to disable proving.
   */
  zkVerify?: { endpointUrl?: string; seed?: string; domainId?: number };
}

/** Fully-resolved runtime configuration (internal). */
export interface ResolvedConfig {
  network: Network;
  apiUrl: string;
  relayerUrls: string[];
  deployer: string;
  signer?: WalletSigner;
  proofEngine?: ProofEngine;
  logger: Logger;
  timeoutMs: number;
  zkVerify: { endpointUrl?: string; seed?: string; domainId: number };
}
