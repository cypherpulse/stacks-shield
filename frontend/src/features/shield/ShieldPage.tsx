import { useState } from "react";

import { ConnectGate } from "@/shared/components/ConnectGate";
import { OperationProgress } from "@/shared/components/OperationProgress";
import { PageHeader } from "@/shared/components/States";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { MIN_SHIELD_STX } from "@/shared/constants/protocol";
import { useShield } from "@/features/shield/useShield";

export function ShieldPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Shield STX"
        description="Deposit transparent STX and receive a private note you fully control."
      />
      <ConnectGate>
        <ShieldForm />
      </ConnectGate>
    </div>
  );
}

function ShieldForm() {
  const [amount, setAmount] = useState("");
  const op = useShield();
  const value = Number(amount);
  const valid = Number.isFinite(value) && value >= MIN_SHIELD_STX;

  return (
    <Card className="glass max-w-xl gap-5 p-6">
      <div className="space-y-2">
        <Label htmlFor="amount">Amount</Label>
        <div className="relative">
          <Input
            id="amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="pr-16 font-mono text-lg"
          />
          <span className="absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-foreground">
            STX
          </span>
        </div>
        <p className="text-xs text-muted-foreground">Minimum {MIN_SHIELD_STX} STX.</p>
      </div>

      <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-4 text-sm">
        <Row label="You shield" value={valid ? `${value} STX` : "—"} />
        <Row label="Protocol fee" value="0 STX" />
        <Row label="Network" value="Stacks Testnet" />
      </div>

      <OperationProgress step={op.step} progress={op.progress} label={op.stepLabel} />

      <Button
        size="lg"
        disabled={!valid || op.isPending}
        onClick={() => op.mutate({ amount: value })}
      >
        {op.isPending ? "Shielding…" : "Shield STX"}
      </Button>
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
