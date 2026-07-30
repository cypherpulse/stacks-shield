import { Inbox } from "lucide-react";

import { NoteCard } from "@/shared/components/NoteCard";
import { EmptyState, ErrorState, ListSkeleton } from "@/shared/components/States";
import { ScrollArea } from "@/shared/components/ui/scroll-area";
import { useNotes } from "@/features/notes/useNotes";
import type { ShieldNote } from "@/shared/types/shield";
import { errorMessage, noteKey } from "@/shared/utils/format";

export function NotePicker({
  selected,
  onToggle,
  multi,
  max,
}: {
  selected: string[];
  onToggle: (id: string, note: ShieldNote) => void;
  multi?: boolean;
  max?: number;
}) {
  const { data, isLoading, error, refetch } = useNotes();

  if (isLoading) return <ListSkeleton rows={3} />;
  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;

  const notes = (data ?? []).filter((n) => !n.spent);

  if (notes.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No spendable notes"
        description="Shield some STX first to create your first private note."
      />
    );
  }

  return (
    <ScrollArea className="max-h-[420px] pr-2">
      <div className="space-y-2.5">
        {notes.map((note, i) => {
          const id = noteKey(note, i);
          const isSelected = selected.includes(id);
          const blocked = multi && !isSelected && typeof max === "number" && selected.length >= max;
          return (
            <NoteCard
              key={id}
              note={note}
              index={i}
              selected={isSelected}
              onSelect={blocked ? undefined : () => onToggle(id, note)}
              className={blocked ? "opacity-50" : undefined}
            />
          );
        })}
      </div>
    </ScrollArea>
  );
}
