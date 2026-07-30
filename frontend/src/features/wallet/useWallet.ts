import { useCallback, useEffect } from "react";
import { toast } from "sonner";

import { ShieldService } from "@/services/sdk/shield.service";
import {
  connectWallet,
  createWalletSigner,
  disconnectWallet,
  restoreWallet,
} from "@/services/sdk/wallet";
import { useWalletStore } from "@/store/wallet";
import { errorMessage } from "@/shared/utils/format";

let bootstrapped = false;

export function useWallet() {
  const { status, address, shieldAddress, setStatus, setSession, setShieldAddress } =
    useWalletStore();

  useEffect(() => {
    if (bootstrapped) return;
    bootstrapped = true;
    restoreWallet()
      .then((session) => {
        if (!session) return;
        ShieldService.setSigner(createWalletSigner(session.address));
        setSession(session);
      })
      .catch(() => undefined);
  }, [setSession]);

  const connect = useCallback(async () => {
    try {
      setStatus("connecting");
      const session = await connectWallet();
      ShieldService.setSigner(createWalletSigner(session.address));
      setSession(session);
      toast.success("Wallet connected", { description: session.address });
      return session;
    } catch (error) {
      setStatus("disconnected");
      toast.error("Could not connect wallet", { description: errorMessage(error) });
      return null;
    }
  }, [setSession, setStatus]);

  const disconnect = useCallback(async () => {
    await disconnectWallet();
    ShieldService.reset();
    setSession(null);
    setShieldAddress(null);
    toast("Wallet disconnected");
  }, [setSession, setShieldAddress]);

  return {
    status,
    address,
    shieldAddress,
    isConnected: status === "connected" && Boolean(address),
    isConnecting: status === "connecting",
    connect,
    disconnect,
    setShieldAddress,
  };
}
