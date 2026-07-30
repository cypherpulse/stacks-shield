// =============================================================================
// @stx-shield/sdk -- network constants
// =============================================================================

import type { Network } from "../types/config.js";

export interface NetworkDefaults {
  apiUrl: string;
  relayerUrls: string[];
  deployer: string;
  hiroApiUrl: string;
  /** zkVerify aggregation domain used by the protocol. */
  zkVerifyDomainId: number;
}

export const NETWORKS: Record<Network, NetworkDefaults> = {
  testnet: {
    apiUrl: "https://api.stxshield.testnet",
    relayerUrls: ["https://relayer.stxshield.testnet"],
    // The live testnet deployment.
    deployer: "ST2HXRZ8A82JJAP14KD83JEXNRCF34J67088WJSJH",
    hiroApiUrl: "https://api.testnet.hiro.so",
    zkVerifyDomainId: 0,
  },
  mainnet: {
    apiUrl: "https://api.stxshield.io",
    relayerUrls: ["https://relayer.stxshield.io"],
    // Set once the protocol is deployed to mainnet.
    deployer: "",
    hiroApiUrl: "https://api.hiro.so",
    zkVerifyDomainId: 0,
  },
};

/** Depth of the commitment tree (frozen protocol parameter). */
export const TREE_DEPTH = 20;

/** Minimum shield and withdrawal amount, in micro-STX (1 STX). */
export const MIN_SHIELD = 1_000_000n;
export const MIN_WITHDRAWAL = 1_000_000n;
