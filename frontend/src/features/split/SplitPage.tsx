import { useState } from "react";

import { ConnectGate } from "@/shared/components/ConnectGate";
import { NotePicker } from "@/shared/components/NotePicker";
import { OperationProgress } from "@/shared/components/OperationProgress";
import { PageHeader } from "@/shared/components/States";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { useSplit } from "@/features/split/useSplit";
import type { ShieldNote } from "@/shared/types/shield";
import { toStx } from "@/shared/utils/format";

export function SplitPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Split" description="Turn one note into two notes you own." />
      <ConnectGate>
        <SplitForm />
      </ConnectGate>
    </div>
  );
}

function SplitForm() {
  const [selected, setSelected] = useState<{ id: string; note: ShieldNote } | null>(null);
  const [a, setA] = useState("");
  const op = useSplit();

  const total = selected ? toStx(selected.note.amount) : 0;
  const amountA = Number(a);
  const amountB = Number((total - amountA).toFixed(6));
  const valid = Boolean(selected) && amountA > 0 && amountB > 0;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="glass gap-4 p-5">
        <p className="text-sm font-medium">Select a note</p>
        <NotePicker
          selected={selected ? [selected.id] : []}
          onToggle={(id, note) => {
            setSelected((prev) => (prev?.id === id ? null : { id, note }));
            setA("");
          }}
        />
      </Card>

      <Card className="glass gap-5 p-6">
        <div className="space-y-2">
          <Label htmlFor="a">Amount A</Label>
          <Input
            id="a"
            inputMode="decimal"
            placeholder="0.00"
            value={a}
            disabled={!selected}
            onChange={(e) => setA(e.target.value)}
            className="font-mono text-lg"
          />
        </div>
        <div className="space-y-2">
          <Label>Amount B</Label>
          <Input
            readOnly
            value={selected && amountA > 0 ? String(amountB) : ""}
            placeholder="0.00"
            className="font-mono text-lg"
          />
          <p className="text-xs text-muted-foreground">
            A + B must equal the original note ({total} STX).
          </p>
        </div>

        <OperationProgress step={op.step} progress={op.progress} label={op.stepLabel} />

        <Button
          size="lg"
          disabled={!valid || op.isPending}
          onClick={() =>
            selected && op.mutate({ note: selected.note, amounts: [amountA, amountB] })
          }
        >
          {op.isPending ? "Splitting…" : "Split note"}
        </Button>
      </Card>
    </div>
  );
}
