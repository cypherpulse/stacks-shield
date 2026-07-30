import { Wallet } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { useWallet } from "@/features/wallet/useWallet";

/** Renders children only once a wallet is connected. */
export function ConnectGate({ children }: { children: ReactNode }) {
  const { isConnected, isConnecting, connect } = useWallet();

  if (isConnected) return <>{children}</>;

  return (
    <Card className="glass items-center gap-4 p-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-primary/12 text-primary">
        <Wallet className="size-5" />
      </span>
      <div>
        <p className="font-display text-lg font-semibold">Connect your wallet</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Connect a Stacks wallet on Testnet to shield STX and manage your private balance.
        </p>
      </div>
      <Button onClick={() => void connect()} disabled={isConnecting}>
        {isConnecting ? "Connecting…" : "Connect Wallet"}
      </Button>
    </Card>
  );
}
