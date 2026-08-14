import { CheckCircle2, Coins, Droplets, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/shared/components/States";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { EXPLORER_TX, FAUCET_ASSETS, type FaucetAsset } from "@/shared/constants/protocol";
import { useFaucet } from "@/features/faucet/useFaucet";
import { useWallet } from "@/features/wallet/useWallet";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/shared/utils/format";

const isStacksAddress = (v: string) => /^S[TP][0-9A-Za-z]{37,42}$/.test(v.trim());

export function FaucetPage() {
  const { address, isConnected, connect } = useWallet();
  const [target, setTarget] = useState("");
  const [asset, setAsset] = useState<FaucetAsset>(FAUCET_ASSETS[0]);
  const faucet = useFaucet();

  // Prefill with the connected wallet, but let the user send to any address.
  useEffect(() => {
    if (address && !target) setTarget(address);
  }, [address, target]);

  const valid = isStacksAddress(target);
  const result = faucet.data;

  const claim = () => {
    faucet.mutate(
      { address: target.trim(), asset },
      {
        onSuccess: () => toast.success(`${asset.amount} testnet ${asset.symbol} is on its way`),
        onError: (e) => toast.error("Faucet request failed", { description: errorMessage(e) }),
      },
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Testnet faucet"
        description="Claim free testnet STX, USDCx or sBTC to try shielding, transferring and withdrawing."
      />

      <Card className="glass max-w-xl gap-5 p-6">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary/12 text-primary">
            <Droplets className="size-5" />
          </span>
          <div>
            <p className="font-display text-2xl font-semibold tracking-tight">
              {asset.amount} {asset.symbol}
            </p>
            <p className="text-xs text-muted-foreground">Free testnet {asset.symbol}, once per address.</p>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Asset</Label>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Faucet asset">
            {FAUCET_ASSETS.map((a) => {
              const active = a.symbol === asset.symbol;
              return (
                <button
                  key={a.symbol}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={faucet.isPending}
                  onClick={() => {
                    setAsset(a);
                    faucet.reset();
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    active
                      ? "border-primary bg-primary/10 text-primary shadow-glow"
                      : "border-border bg-muted/30 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                  )}
                >
                  <Coins className="size-4" />
                  {a.amount} {a.symbol}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="target">Destination address</Label>
            {!isConnected && (
              <button
                type="button"
                onClick={() => void connect()}
                className="text-xs font-medium text-primary hover:underline"
              >
                Use my wallet
              </button>
            )}
          </div>
          <Input
            id="target"
            placeholder="ST…"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="font-mono text-sm"
          />
          {target && !valid && (
            <p className="text-xs text-warning">
              That doesn&apos;t look like a Stacks address (it should start with{" "}
              <code>ST</code>).
            </p>
          )}
        </div>

        {result ? (
          <div className="space-y-2 rounded-xl border border-success/30 bg-success/5 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-success">
              <CheckCircle2 className="size-4" />
              {result.message || `${asset.amount} ${asset.symbol} sent to your address.`}
            </p>
            {result.txid && (
              <a
                href={result.explorerUrl || EXPLORER_TX(result.txid)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground"
              >
                View transaction <ExternalLink className="size-3" />
              </a>
            )}
            <p className="text-xs text-muted-foreground">
              It can take a minute to confirm on chain. Then head to{" "}
              <span className="text-foreground">Shield</span> to make your first private note.
            </p>
          </div>
        ) : (
          <Button size="lg" className="w-full" disabled={!valid || faucet.isPending} onClick={claim}>
            {faucet.isPending ? "Requesting…" : `Claim ${asset.amount} ${asset.symbol}`}
          </Button>
        )}

        {result && (
          <Button variant="outline" size="sm" className="w-fit" onClick={() => faucet.reset()}>
            Claim again
          </Button>
        )}

        <p className="text-xs text-muted-foreground">
          Testnet assets only. They have no value and are for testing Stacks Shield.
        </p>
      </Card>
    </div>
  );
}
