import { useState } from "react";

import { ConnectGate } from "@/shared/components/ConnectGate";
import { OperationProgress } from "@/shared/components/OperationProgress";
import { PageHeader } from "@/shared/components/States";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { useNotes } from "@/features/notes/useNotes";
import { useTransfer } from "@/features/transfer/useTransfer";
import { toStx } from "@/shared/utils/format";

export function TransferPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Transfer"
        description="Send privately to a shield address. Requires a note of the exact amount."
      />
      <ConnectGate>
        <TransferForm />
      </ConnectGate>
    </div>
  );
}

function TransferForm() {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const op = useTransfer();
  const { data: notes } = useNotes();

  const value = Number(amount);
  const valid = recipient.trim().length > 10 && Number.isFinite(value) && value > 0;
  const hasExact = (notes ?? []).some((n) => !n.spent && Math.abs(toStx(n.amount) - value) < 1e-9);

  return (
    <Card className="glass max-w-xl gap-5 p-6">
      <div className="space-y-2">
        <Label htmlFor="recipient">Recipient shield address</Label>
        <Input
          id="recipient"
          placeholder="Paste the recipient's STX Shield address"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          className="font-mono text-sm"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="amount">Amount</Label>
        <Input
          id="amount"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="font-mono text-lg"
        />
        {valid && !hasExact && (
          <p className="text-xs text-warning">
            You don&apos;t have a note of exactly {value} STX. Split a note to this denomination
            first.
          </p>
        )}
      </div>

      <OperationProgress step={op.step} progress={op.progress} label={op.stepLabel} />

      <Button
        size="lg"
        disabled={!valid || op.isPending}
        onClick={() => op.mutate({ amount: value, recipient: recipient.trim() })}
      >
        {op.isPending ? "Sending…" : "Send privately"}
      </Button>
    </Card>
  );
}
