import { useState } from "react";

import { ConnectGate } from "@/shared/components/ConnectGate";
import { NotePicker } from "@/shared/components/NotePicker";
import { OperationProgress } from "@/shared/components/OperationProgress";
import { PageHeader } from "@/shared/components/States";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/shared/components/ui/alert-dialog";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { WITHDRAW_FEE_RATE } from "@/shared/constants/protocol";
import { useWallet } from "@/features/wallet/useWallet";
import { useWithdraw } from "@/features/withdraw/useWithdraw";
import type { ShieldNote } from "@/shared/types/shield";
import { formatStx, toStx } from "@/shared/utils/format";

export function WithdrawPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Withdraw" description="Redeem a note back to transparent STX." />
      <ConnectGate>
        <WithdrawForm />
      </ConnectGate>
    </div>
  );
}

function WithdrawForm() {
  const { address } = useWallet();
  const [selected, setSelected] = useState<{ id: string; note: ShieldNote } | null>(null);
  const [recipient, setRecipient] = useState("");
  const op = useWithdraw();

  const gross = selected ? toStx(selected.note.amount) : 0;
  const fee = gross * WITHDRAW_FEE_RATE;
  const net = gross - fee;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="glass gap-4 p-5">
        <p className="text-sm font-medium">Select a note</p>
        <NotePicker
          selected={selected ? [selected.id] : []}
          onToggle={(id, note) => setSelected((prev) => (prev?.id === id ? null : { id, note }))}
        />
      </Card>

      <Card className="glass gap-5 p-6 lg:sticky lg:top-6 lg:self-start">
        <div className="space-y-2">
          <Label htmlFor="recipient">Recipient address</Label>
          <Input
            id="recipient"
            placeholder={address ?? "ST…"}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Leave blank to withdraw to your connected wallet.
          </p>
        </div>

        <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-4 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Gross amount</span>
            <span className="font-mono">{formatStx(gross)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Protocol fee (~0.3%)</span>
            <span className="font-mono">{formatStx(fee)}</span>
          </div>
          <div className="flex justify-between border-t border-border pt-2 font-medium">
            <span>You receive</span>
            <span className="font-mono">{formatStx(net)}</span>
          </div>
        </div>

        <OperationProgress
          step={op.step}
          progress={op.progress}
          label={op.stepLabel}
          txid={op.data?.txid}
          successTitle="Withdrawal complete"
          successDetail={`${formatStx(net)} sent to ${recipient.trim() || address || "your wallet"}.`}
          onDone={() => {
            op.reset();
            setSelected(null);
            setRecipient("");
          }}
        />

        {op.step === "done" ? null : (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="lg" disabled={!selected || op.isPending}>
              {op.isPending ? "Withdrawing…" : "Withdraw"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm withdrawal</AlertDialogTitle>
              <AlertDialogDescription>
                {formatStx(net)} will be sent to {recipient.trim() || address}. This spends the
                selected note permanently.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  selected &&
                  op.mutate({ note: selected.note, recipient: recipient.trim() || undefined })
                }
              >
                Confirm
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        )}
      </Card>
    </div>
  );
}
