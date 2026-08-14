// =============================================================================
// @stacks-shield/sdk -- wallet signer abstraction
// =============================================================================
// Wallet-agnostic. In the browser this is backed by @stacks/connect (Leather,
// Xverse, Asigna, ...); in Node by a key-based signer. The SDK never sees or
// stores a private key beyond what the signer chooses to expose.

import type { Network } from "./config.js";

export interface WalletSigner {
  /** The signer's Stacks address for the given network. */
  getAddress(network: Network): Promise<string> | string;

  /** Sign an arbitrary UTF-8 message; returns { signature, publicKey } (RSV
   *  hex) as produced by Stacks message signing. Used for API authentication. */
  signMessage(message: string): Promise<{ signature: string; publicKey: string }>;

  /**
   * Sign AND broadcast a contract call, returning the txid. Used ONLY for
   * shield (which moves the user's own STX). Relayed operations never touch
   * the signer. Implementations wrap @stacks/connect or makeContractCall.
   */
  signAndBroadcast(call: ContractCall, network: Network): Promise<string>;

  /**
   * A 32-byte secret the SDK deterministically derives the user's note owner
   * key and viewing key from. Never leaves the device. Browsers may derive it
   * from a wallet signature over a fixed message.
   */
  getShieldSecret(): Promise<Uint8Array> | Uint8Array;
}

export interface ContractCall {
  contractAddress: string;
  contractName: string;
  functionName: string;
  /** Clarity values, already encoded by the caller. */
  functionArgs: unknown[];
}
