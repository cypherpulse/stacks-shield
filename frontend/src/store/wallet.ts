import { create } from "zustand";

import type { WalletSession } from "@/services/sdk/wallet";

export type WalletStatus = "disconnected" | "connecting" | "connected";

interface WalletState {
  status: WalletStatus;
  address: string | null;
  shieldAddress: string | null;
  setStatus: (status: WalletStatus) => void;
  setSession: (session: WalletSession | null) => void;
  setShieldAddress: (address: string | null) => void;
}

export const useWalletStore = create<WalletState>((set) => ({
  status: "disconnected",
  address: null,
  shieldAddress: null,
  setStatus: (status) => set({ status }),
  setSession: (session) =>
    set({
      address: session?.address ?? null,
      status: session ? "connected" : "disconnected",
      shieldAddress: session ? undefined : null,
    }),
  setShieldAddress: (shieldAddress) => set({ shieldAddress }),
}));
