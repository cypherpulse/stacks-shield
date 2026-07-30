import { Info } from "lucide-react";
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
      <div className="flex gap-3 rounded-xl border border-primary/25 bg-primary/5 p-4">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="space-y-1 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">You need the recipient's shield address.</p>
          <p>
            To receive, they must open STX Shield once, connect their wallet, and sign — that
            derives their shield address (Settings → <span className="text-foreground">Show my
            shield address</span>). A brand-new wallet that has never used the protocol{" "}
            <span className="text-foreground">cannot</span> receive — there's no key to send to yet.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="recipient">Recipient shield address</Label>
        <Input
          id="recipient"
          placeholder="Recipient's STX Shield address (not their ST… wallet address)"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          This is <span className="text-foreground">not</span> a wallet (<code>ST…</code>) address.
          The recipient shares their shield address from <span className="text-foreground">Settings → your STX Shield address</span>.
        </p>
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

      <OperationProgress
        step={op.step}
        progress={op.progress}
        label={op.stepLabel}
        txid={op.data?.txid}
        successTitle="Transfer sent"
        successDetail={`${value} STX sent privately.`}
        onDone={() => {
          op.reset();
          setRecipient("");
          setAmount("");
        }}
      />

      {op.step !== "done" && (
        <Button
          size="lg"
          disabled={!valid || op.isPending}
          onClick={() => op.mutate({ amount: value, recipient: recipient.trim() })}
        >
          {op.isPending ? "Sending…" : "Send privately"}
        </Button>
      )}
    </Card>
  );
}
