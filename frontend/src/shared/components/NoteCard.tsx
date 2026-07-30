import { Coins } from "lucide-react";

import { Badge } from "@/shared/components/ui/badge";
import { Card } from "@/shared/components/ui/card";
import { cn } from "@/lib/cn";
import type { ShieldNote } from "@/shared/types/shield";
import { formatDate, formatStx, noteKey, truncate } from "@/shared/utils/format";

export function NoteCard({
  note,
  index = 0,
  selected,
  onSelect,
  actions,
  className,
}: {
  note: ShieldNote;
  index?: number;
  selected?: boolean;
  onSelect?: () => void;
  actions?: React.ReactNode;
  className?: string;
}) {
  const id = noteKey(note, index);
  const status = note.spent ? "spent" : (note.status ?? "unspent");
  const statusClass =
    {
      confirmed: "border-success/40 text-success",
      unspent: "border-success/40 text-success",
      pending: "border-warning/40 text-warning",
      failed: "border-destructive/40 text-destructive",
      spent: "text-muted-foreground",
    }[status] ?? "text-muted-foreground";
  const interactive = Boolean(onSelect);

  return (
    <Card
      onClick={onSelect}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={(e) => {
        if (interactive && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect?.();
        }
      }}
      className={cn(
        "glass flex-row items-center justify-between gap-4 p-4 transition-all",
        interactive && "cursor-pointer hover:border-primary/40 hover:shadow-glow",
        selected && "border-primary ring-1 ring-primary/40",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <Coins className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="font-display text-base font-semibold">{formatStx(note.amount)}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{truncate(id, 10, 6)}</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="hidden text-right sm:block">
          <Badge variant="outline" className={cn("capitalize", statusClass)}>
            {status}
          </Badge>
          <p className="mt-1 text-[11px] text-muted-foreground">{formatDate(note.createdAt)}</p>
        </div>
        {actions}
      </div>
    </Card>
  );
}
