import { Shield } from "lucide-react";

import { cn } from "@/lib/cn";

export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span className="gradient-brand flex size-8 items-center justify-center rounded-lg shadow-glow">
        <Shield className="size-4 text-primary-foreground" strokeWidth={2.4} />
      </span>
      {!compact && (
        <span className="font-display text-[15px] font-semibold tracking-tight">Stacks Shield</span>
      )}
    </span>
  );
}
