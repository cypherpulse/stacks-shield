import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { Progress } from "@/shared/components/ui/progress";
import type { OperationStep } from "@/shared/hooks/useOperation";
import { cn } from "@/lib/cn";

export function OperationProgress({
  step,
  progress,
  label,
  className,
}: {
  step: OperationStep;
  progress: number;
  label: string;
  className?: string;
}) {
  if (step === "idle") return null;

  const Icon = step === "done" ? CheckCircle2 : step === "error" ? XCircle : Loader2;

  return (
    <div className={cn("rounded-xl border border-border bg-muted/30 p-4", className)}>
      <div className="flex items-center gap-2.5 text-sm">
        <Icon
          className={cn(
            "size-4",
            step === "done" && "text-success",
            step === "error" && "text-destructive",
            step !== "done" && step !== "error" && "animate-spin text-primary",
          )}
        />
        <span className="font-medium">{label}</span>
      </div>
      <Progress value={progress} className="mt-3 h-1.5" />
      {step !== "done" && step !== "error" && (
        <p className="mt-2 text-xs text-muted-foreground">
          This can take up to a minute. Keep this tab open.
        </p>
      )}
    </div>
  );
}
