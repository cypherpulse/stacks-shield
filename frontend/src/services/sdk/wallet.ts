import { sha256 } from "@noble/hashes/sha2.js";

import { NETWORK, SHIELD_SECRET_MSG } from "@/shared/constants/protocol";
import type { ContractCall, ShieldNetwork, WalletSigner } from "@/shared/types/shield";

/**
 * Browser wallet integration (@stacks/connect). The SDK never holds a key —
 * it calls this signer whenever a signature is required.
 */

export interface WalletSession {
  address: string;
  publicKey?: string;
}

const STORAGE_KEY = "stx-shield.session";

export function loadSession(): WalletSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as WalletSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: WalletSession | null) {
  if (typeof window === "undefined") return;
  if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  else window.localStorage.removeItem(STORAGE_KEY);
}

async function connectModule() {
  return await import("@stacks/connect");
}

export async function connectWallet(): Promise<WalletSession> {
  const { connect, getLocalStorage } = await connectModule();
  await connect();
  const data = getLocalStorage();
  const address = data?.addresses?.stx?.[0]?.address;
  if (!address) throw new Error("No Stacks address returned by the wallet.");
  const session: WalletSession = { address };
  saveSession(session);
  return session;
}

export async function restoreWallet(): Promise<WalletSession | null> {
  try {
    const { isConnected, getLocalStorage } = await connectModule();
    if (!isConnected()) return null;
    const address = getLocalStorage()?.addresses?.stx?.[0]?.address;
    if (!address) return null;
    const session: WalletSession = { address };
    saveSession(session);
    return session;
  } catch {
    return loadSession();
  }
}

export async function disconnectWallet(): Promise<void> {
  try {
    const { disconnect } = await connectModule();
    disconnect();
  } finally {
    saveSession(null);
  }
}

export function createWalletSigner(address: string): WalletSigner {
  const signer: WalletSigner = {
    getAddress: (_network: ShieldNetwork) => address,

    async signMessage(message: string) {
      const { request } = await connectModule();
      const res = (await request("stx_signMessage", { message })) as {
        signature: string;
        publicKey: string;
      };
      return { signature: res.signature, publicKey: res.publicKey };
    },

    async signAndBroadcast(call: ContractCall, _network: ShieldNetwork) {
      const { request } = await connectModule();
      const params = {
        contract: `${call.contractAddress}.${call.contractName}`,
        functionName: call.functionName,
        functionArgs: call.functionArgs,
        network: NETWORK,
      } as never;
      const res = (await request("stx_callContract", params)) as {
        txid?: string;
        txId?: string;
      };
      const txid = res.txid ?? res.txId;
      if (!txid) throw new Error("Wallet did not return a transaction id.");
      return txid;
    },

    async getShieldSecret() {
      // Deterministic per wallet: the same wallet must always derive the same
      // 32 bytes, or the user loses access to their notes.
      const { signature } = await signer.signMessage(SHIELD_SECRET_MSG);
      return sha256(new TextEncoder().encode(signature));
    },
  };

  return signer;
}
