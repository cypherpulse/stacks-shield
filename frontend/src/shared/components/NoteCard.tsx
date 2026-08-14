import { Check, Coins } from "lucide-react";

import { Badge } from "@/shared/components/ui/badge";
import { Card } from "@/shared/components/ui/card";
import { cn } from "@/lib/cn";
import type { ShieldNote } from "@/shared/types/shield";
import { noteKey, noteLabel, relativeTime, truncate } from "@/shared/utils/format";

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
        selected && "border-primary bg-primary/5 ring-1 ring-primary",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3.5">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors",
            selected ? "bg-primary text-primary-foreground" : "bg-primary/12 text-primary",
          )}
        >
          {selected ? <Check className="size-5" strokeWidth={2.75} /> : <Coins className="size-5" />}
        </span>
        <div className="min-w-0">
          <p className="font-display text-lg leading-tight font-semibold">{noteLabel(note)}</p>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{truncate(id, 8, 6)}</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="flex flex-col items-end gap-1">
          <Badge variant="outline" className={cn("capitalize", statusClass)}>
            {status}
          </Badge>
          {note.createdAt ? (
            <p className="text-[11px] text-muted-foreground max-sm:hidden">
              {relativeTime(note.createdAt)}
            </p>
          ) : null}
        </div>
        {actions && <div className="flex items-center gap-1.5">{actions}</div>}
      </div>
    </Card>
  );
}
