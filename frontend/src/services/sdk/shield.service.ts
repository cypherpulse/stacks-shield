import { STXShield } from "@stx-shield/sdk";
import { createWebEngine } from "@stx-shield/sdk/web";

import { API_URL, NETWORK, RELAYER_URL, ZKVERIFY_URL } from "@/shared/constants/protocol";
import type { STXShieldClient, WalletSigner } from "@/shared/types/shield";

/**
 * The single, mandatory entry point to `@stx-shield/sdk` (a workspace package).
 *
 * The SDK is a hard dependency: it is imported statically, so if it cannot be
 * resolved the frontend BUILD fails — there is no runtime fallback, mock or
 * feature flag. Every protocol interaction goes through this one long-lived
 * client; the frontend never talks to contracts, relayers or zkVerify itself.
 */

/** WASM multithreaded proving requires cross-origin isolation (COOP/COEP). */
function threadCount(): number {
  if (typeof window === "undefined") return 1;
  return window.crossOriginIsolated ? 4 : 1;
}

export class ShieldService {
  private static instance: STXShieldClient | null = null;
  private static signer: WalletSigner | null = null;
  private static address: string | null = null;

  /**
   * Set the active signer. The instance is rebuilt ONLY when the wallet ADDRESS
   * changes — `createWalletSigner` returns a new object each call, so comparing
   * by object identity would needlessly churn the client (and re-trigger auth
   * on every render, causing duplicate sign prompts).
   */
  static setSigner(signer: WalletSigner | null, address: string | null = null) {
    if (ShieldService.address !== address) ShieldService.instance = null;
    ShieldService.signer = signer;
    ShieldService.address = address;
  }

  /** The one SDK instance for the life of the session. */
  static getInstance(): STXShieldClient {
    if (ShieldService.instance) return ShieldService.instance;

    const client = new STXShield({
      network: NETWORK,
      apiUrl: API_URL,
      relayerUrls: [RELAYER_URL],
      proofEngine: createWebEngine({ artifactsBaseUrl: "/circuits", threads: threadCount() }),
      ...(ShieldService.signer ? { signer: ShieldService.signer } : {}),
      ...(ZKVERIFY_URL ? { zkVerify: { endpointUrl: ZKVERIFY_URL } } : {}),
    } as unknown as ConstructorParameters<typeof STXShield>[0]);

    ShieldService.instance = client as unknown as STXShieldClient;
    return ShieldService.instance;
  }

  static reset() {
    ShieldService.instance = null;
    ShieldService.signer = null;
    ShieldService.address = null;
  }
}

export const getShield = (): STXShieldClient => ShieldService.getInstance();
