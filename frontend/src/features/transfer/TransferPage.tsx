import { Info } from "lucide-react";
import { useState } from "react";

import { ConnectGate } from "@/shared/components/ConnectGate";
import { NotePicker } from "@/shared/components/NotePicker";
import { OperationProgress } from "@/shared/components/OperationProgress";
import { PageHeader } from "@/shared/components/States";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { useTransfer } from "@/features/transfer/useTransfer";
import type { ShieldNote } from "@/shared/types/shield";
import { noteAsset, noteDisplay, noteLabel } from "@/shared/utils/format";

export function TransferPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Transfer"
        description="Send a whole note privately to a shield address."
      />
      <ConnectGate>
        <TransferForm />
      </ConnectGate>
    </div>
  );
}

function TransferForm() {
  const [selected, setSelected] = useState<{ id: string; note: ShieldNote } | null>(null);
  const [recipient, setRecipient] = useState("");
  const op = useTransfer();

  const amount = selected ? noteDisplay(selected.note) : 0;
  const sendLabel = selected ? noteLabel(selected.note) : "—";
  const valid = Boolean(selected) && recipient.trim().length > 10;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="glass gap-4 p-5">
        <p className="text-sm font-medium">Select a note to send</p>
        <p className="text-xs text-muted-foreground">
          The whole note is sent. Need a different amount? Split a note first.
        </p>
        <NotePicker
          selected={selected ? [selected.id] : []}
          onToggle={(id, note) => setSelected((prev) => (prev?.id === id ? null : { id, note }))}
        />
      </Card>

      <Card className="glass gap-5 p-6 lg:sticky lg:top-6 lg:self-start">
        <div className="flex gap-3 rounded-xl border border-primary/25 bg-primary/5 p-4">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="space-y-1 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">You need the recipient's shield address.</p>
            <p>
              To receive, they must open Stacks Shield once, connect their wallet, and sign, which
              derives their shield address (Settings → <span className="text-foreground">Show my
              shield address</span>). A brand-new wallet that has never used the protocol{" "}
              <span className="text-foreground">cannot</span> receive yet.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="recipient">Recipient shield address</Label>
          <Input
            id="recipient"
            placeholder="Recipient's Stacks Shield address (not their ST… wallet address)"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            This is <span className="text-foreground">not</span> a wallet (<code>ST…</code>) address.
            The recipient shares it from <span className="text-foreground">Settings → your Stacks Shield address</span>.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-xl border border-border bg-muted/30 p-4 text-sm">
          <span className="text-muted-foreground">You send</span>
          <span className="font-mono text-lg">{sendLabel}</span>
        </div>

        <OperationProgress
          step={op.step}
          progress={op.progress}
          label={op.stepLabel}
          txid={op.data?.txid}
          successTitle="Transfer sent"
          successDetail={selected ? `${sendLabel} sent privately.` : undefined}
          onDone={() => {
            op.reset();
            setSelected(null);
            setRecipient("");
          }}
        />

        {op.step !== "done" && (
          <Button
            size="lg"
            disabled={!valid || op.isPending}
            onClick={() =>
              selected &&
              op.mutate({
                amount,
                recipient: recipient.trim(),
                asset: selected.note.asset?.native ? undefined : (selected.note.asset?.token ?? undefined),
              })
            }
          >
            {op.isPending ? "Sending…" : "Send privately"}
          </Button>
        )}
      </Card>
    </div>
  );
}
