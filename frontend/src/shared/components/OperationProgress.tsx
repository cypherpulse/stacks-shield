import { ArrowUpRight, CheckCircle2, Copy, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/shared/components/ui/button";
import { Progress } from "@/shared/components/ui/progress";
import type { OperationStep } from "@/shared/hooks/useOperation";
import { EXPLORER_TX } from "@/shared/constants/protocol";
import { truncate } from "@/shared/utils/format";
import { cn } from "@/lib/cn";

export function OperationProgress({
  step,
  progress,
  label,
  txid,
  successTitle = "Success",
  successDetail,
  onDone,
  className,
}: {
  step: OperationStep;
  progress: number;
  label: string;
  /** Set once the operation lands on chain — enables the success card. */
  txid?: string;
  successTitle?: string;
  successDetail?: string;
  onDone?: () => void;
  className?: string;
}) {
  if (step === "idle") return null;

  // ---- success -------------------------------------------------------------
  if (step === "done") {
    return (
      <div
        className={cn(
          "rounded-xl border border-success/40 bg-success/10 p-4",
          className,
        )}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-success/15 text-success">
            <CheckCircle2 className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-display text-sm font-semibold text-success">{successTitle}</p>
            {successDetail && <p className="mt-0.5 text-sm text-foreground">{successDetail}</p>}
            {txid && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{truncate(txid, 8, 6)}</span>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(txid);
                    toast.success("Transaction id copied");
                  }}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="Copy transaction id"
                >
                  <Copy className="size-3.5" />
                </button>
                <a
                  href={EXPLORER_TX(txid)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  View on explorer <ArrowUpRight className="size-3" />
                </a>
              </div>
            )}
          </div>
          {onDone && (
            <Button variant="ghost" size="sm" onClick={onDone} className="shrink-0">
              Done
            </Button>
          )}
        </div>
      </div>
    );
  }

  // ---- error ---------------------------------------------------------------
  if (step === "error") {
    return (
      <div className={cn("rounded-xl border border-destructive/40 bg-destructive/10 p-4", className)}>
        <div className="flex items-center gap-2.5 text-sm">
          <XCircle className="size-4 text-destructive" />
          <span className="font-medium text-destructive">{label}</span>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          The operation didn't complete. Check the details and try again.
        </p>
      </div>
    );
  }

  // ---- in progress ---------------------------------------------------------
  return (
    <div className={cn("rounded-xl border border-border bg-muted/30 p-4", className)}>
      <div className="flex items-center gap-2.5 text-sm">
        <Loader2 className="size-4 animate-spin text-primary" />
        <span className="font-medium">{label}</span>
      </div>
      <Progress value={progress} className="mt-3 h-1.5" />
      <p className="mt-2 text-xs text-muted-foreground">
        This can take a minute or two — proving, aggregating on zkVerify, then confirming on Stacks.
        Keep this tab open.
      </p>
    </div>
  );
}
