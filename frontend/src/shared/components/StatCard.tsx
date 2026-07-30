import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Card } from "@/shared/components/ui/card";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { cn } from "@/lib/cn";

export function StatCard({
  label,
  value,
  icon: Icon,
  hint,
  loading,
  accent = "primary",
  className,
}: {
  label: string;
  value: ReactNode;
  icon?: LucideIcon;
  hint?: string;
  loading?: boolean;
  accent?: "primary" | "success" | "teal" | "muted";
  className?: string;
}) {
  const accentClass = {
    primary: "bg-primary/12 text-primary",
    success: "bg-success/12 text-success",
    teal: "bg-teal/12 text-teal",
    muted: "bg-muted text-muted-foreground",
  }[accent];

  return (
    <Card className={cn("glass gap-0 p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
        {Icon && (
          <span className={cn("flex size-8 items-center justify-center rounded-lg", accentClass)}>
            <Icon className="size-4" />
          </span>
        )}
      </div>
      <div className="mt-3 font-display text-2xl font-semibold tracking-tight">
        {loading ? <Skeleton className="h-7 w-28" /> : value}
      </div>
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}
