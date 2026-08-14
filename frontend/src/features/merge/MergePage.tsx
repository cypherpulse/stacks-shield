import { ArrowRight, Coins, Plus } from "lucide-react";
import { useState } from "react";

import { ConnectGate } from "@/shared/components/ConnectGate";
import { NotePicker } from "@/shared/components/NotePicker";
import { OperationProgress } from "@/shared/components/OperationProgress";
import { PageHeader } from "@/shared/components/States";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { useMerge } from "@/features/merge/useMerge";
import type { ShieldNote } from "@/shared/types/shield";
import { amountLabel, noteAsset, noteDisplay, noteLabel, sameAsset } from "@/shared/utils/format";
import { cn } from "@/lib/cn";

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

  // Merge combines two notes of the SAME asset — the pool and circuit are
  // asset-bound, so STX + sBTC (etc.) can never merge into one note.
  const assetsMatch = picked.length < 2 || sameAsset(picked[0].note, picked[1].note);
  const symbol = picked[0] ? noteAsset(picked[0].note).symbol : "STX";
  const total = picked.reduce((sum, p) => sum + noteDisplay(p.note), 0);
  const valid = picked.length === 2 && assetsMatch;

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

      <Card className="glass gap-5 p-6 lg:sticky lg:top-6 lg:self-start">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Selected</span>
          <span className="font-mono">{picked.length} / 2</span>
        </div>

        {!assetsMatch && (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            Both notes must be the same asset to merge.
          </p>
        )}

        {/* Merge visual: note 1 + note 2 -> one merged note */}
        <div className="rounded-xl border border-border bg-muted/20 p-4">
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            <MergeSlot note={picked[0]?.note} index={1} />
            <span className="flex items-center justify-center text-muted-foreground">
              <Plus className="size-4" />
            </span>
            <MergeSlot note={picked[1]?.note} index={2} />
            <span className="flex items-center justify-center text-primary">
              <ArrowRight className="size-5 max-sm:rotate-90" />
            </span>
            <div
              className={cn(
                "flex-1 rounded-lg border p-3 text-center transition-colors",
                valid
                  ? "border-primary/50 bg-primary/10 shadow-glow"
                  : "border-dashed border-border bg-muted/30",
              )}
            >
              <p className="text-[11px] tracking-wide text-muted-foreground uppercase">Merged note</p>
              <p
                className={cn(
                  "font-display text-base font-semibold",
                  valid ? "text-primary" : "text-muted-foreground",
                )}
              >
                {valid ? amountLabel(total, symbol) : "—"}
              </p>
            </div>
          </div>
        </div>

        <OperationProgress
          step={op.step}
          progress={op.progress}
          label={op.stepLabel}
          txid={op.data?.txid}
          successTitle="Merge complete"
          successDetail={`Combined into a single ${amountLabel(total, symbol)} note.`}
          onDone={() => {
            op.reset();
            setPicked([]);
          }}
        />

        {op.step !== "done" && (
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
        )}
      </Card>
    </div>
  );
}

function MergeSlot({ note, index }: { note?: ShieldNote; index: number }) {
  return (
    <div
      className={cn(
        "flex-1 rounded-lg border p-3 text-center transition-colors",
        note ? "border-teal/40 bg-teal/10" : "border-dashed border-border bg-muted/30",
      )}
    >
      <p className="flex items-center justify-center gap-1 text-[11px] tracking-wide text-muted-foreground uppercase">
        <Coins className="size-3" /> Note {index}
      </p>
      <p
        className={cn(
          "font-display text-base font-semibold",
          note ? "text-teal" : "text-muted-foreground",
        )}
      >
        {note ? noteLabel(note) : "Select"}
      </p>
    </div>
  );
}
