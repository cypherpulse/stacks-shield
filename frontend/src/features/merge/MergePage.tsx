import { useState } from "react";

import { ConnectGate } from "@/shared/components/ConnectGate";
import { NotePicker } from "@/shared/components/NotePicker";
import { OperationProgress } from "@/shared/components/OperationProgress";
import { PageHeader } from "@/shared/components/States";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { useMerge } from "@/features/merge/useMerge";
import type { ShieldNote } from "@/shared/types/shield";
import { formatStx, toStx } from "@/shared/utils/format";

export function MergePage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Merge" description="Select exactly two notes to combine into one." />
      <ConnectGate>
        <MergeForm />
      </ConnectGate>
    </div>
  );
}

function MergeForm() {
  const [picked, setPicked] = useState<{ id: string; note: ShieldNote }[]>([]);
  const op = useMerge();

  const total = picked.reduce((sum, p) => sum + toStx(p.note.amount), 0);
  const valid = picked.length === 2;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="glass gap-4 p-5">
        <p className="text-sm font-medium">Select two notes</p>
        <NotePicker
          multi
          max={2}
          selected={picked.map((p) => p.id)}
          onToggle={(id, note) =>
            setPicked((prev) =>
              prev.some((p) => p.id === id)
                ? prev.filter((p) => p.id !== id)
                : [...prev, { id, note }].slice(0, 2),
            )
          }
        />
      </Card>

      <Card className="glass gap-5 p-6">
        <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-4 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Selected</span>
            <span className="font-mono">{picked.length} / 2</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Merged amount</span>
            <span className="font-mono">{formatStx(total)}</span>
          </div>
        </div>

        <OperationProgress step={op.step} progress={op.progress} label={op.stepLabel} />

        <Button
          size="lg"
          disabled={!valid || op.isPending}
          onClick={() =>
            valid &&
            op.mutate({ notes: [picked[0].note, picked[1].note] as [ShieldNote, ShieldNote] })
          }
        >
          {op.isPending ? "Merging…" : "Merge notes"}
        </Button>
      </Card>
    </div>
  );
}
