import { useEffect, useState } from "react";

import { AssetSelector } from "@/shared/components/AssetSelector";
import { ConnectGate } from "@/shared/components/ConnectGate";
import { OperationProgress } from "@/shared/components/OperationProgress";
import { PageHeader } from "@/shared/components/States";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { MIN_SHIELD_STX } from "@/shared/constants/protocol";
import { useShield } from "@/features/shield/useShield";
import { shieldableAssets, useAssets } from "@/features/assets/useAssets";
import type { AssetInfo } from "@/shared/types/shield";
import { amountLabel } from "@/shared/utils/format";

export function ShieldPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Shield assets"
        description="Deposit transparent STX, sBTC or USDCx and receive a private note you fully control."
      />
      <ConnectGate>
        <ShieldForm />
      </ConnectGate>
    </div>
  );
}

function ShieldForm() {
  const { data: assets } = useAssets();
  const options = shieldableAssets(assets);
  const [asset, setAsset] = useState<AssetInfo | null>(null);
  const [amount, setAmount] = useState("");
  const op = useShield();

  // Default to native STX (or the first shieldable asset) once assets load.
  useEffect(() => {
    if (!asset && options.length > 0) setAsset(options.find((a) => a.native) ?? options[0]);
  }, [asset, options]);

  const symbol = asset?.symbol ?? "STX";
  const value = Number(amount);
  // Only native STX carries a protocol minimum; SIP-10 just needs a positive amount.
  const min = asset?.native ? MIN_SHIELD_STX : 0;
  const valid = Number.isFinite(value) && value > 0 && value >= min;

  return (
    <Card className="glass max-w-xl gap-5 p-6">
      <AssetSelector
        assets={options}
        value={asset}
        onChange={(a) => setAsset(a)}
        disabled={op.isPending}
      />

      <div className="space-y-2">
        <Label htmlFor="amount">Amount</Label>
        <div className="relative">
          <Input
            id="amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="pr-20 font-mono text-lg"
          />
          <span className="absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-foreground">
            {symbol}
          </span>
        </div>
        {min > 0 && <p className="text-xs text-muted-foreground">Minimum {min} {symbol}.</p>}
      </div>

      <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-4 text-sm">
        <Row label="You shield" value={valid ? amountLabel(value, symbol) : "—"} />
        <Row label="Protocol fee" value={amountLabel(0, symbol)} />
        <Row label="Network" value="Stacks Testnet" />
      </div>

      <OperationProgress
        step={op.step}
        progress={op.progress}
        label={op.stepLabel}
        txid={op.data?.txid}
        successTitle="Shield complete"
        successDetail={`${amountLabel(value, symbol)} is now shielded privately.`}
        onDone={() => {
          op.reset();
          setAmount("");
        }}
      />

      {op.step !== "done" && (
        <Button
          size="lg"
          className="w-full"
          disabled={!valid || op.isPending}
          onClick={() => op.mutate({ amount: value, asset: asset?.native ? undefined : (asset?.token ?? undefined) })}
        >
          {op.isPending ? "Shielding…" : `Shield ${symbol}`}
        </Button>
      )}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
