import { Link } from "@tanstack/react-router";
import { Inbox, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { ConnectGate } from "@/shared/components/ConnectGate";
import { NoteCard } from "@/shared/components/NoteCard";
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from "@/shared/components/States";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { useNotes } from "@/features/notes/useNotes";
import { errorMessage, noteKey } from "@/shared/utils/format";

const PAGE_SIZE = 8;

export function NotesPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Notes" description="Every private note this wallet can spend." />
      <ConnectGate>
        <NotesList />
      </ConnectGate>
    </div>
  );
}

function NotesList() {
  const { data, isLoading, error, refetch } = useNotes();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    return (data ?? []).filter((note, i) => {
      const id = noteKey(note, i);
      const spent = Boolean(note.spent);
      if (status === "unspent" && spent) return false;
      if (status === "spent" && !spent) return false;
      if (!query) return true;
      return id.toLowerCase().includes(query.toLowerCase());
    });
  }, [data, query, status]);

  if (isLoading) return <ListSkeleton />;
  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search notes"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            className="pl-9"
          />
        </div>
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All notes</SelectItem>
            <SelectItem value="unspent">Unspent</SelectItem>
            <SelectItem value="spent">Spent</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No notes found"
          description="Shield some STX to create your first private note."
          action={
            <Button asChild size="sm">
              <Link to="/shield">Shield STX</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {visible.map((note, i) => (
            <NoteCard
              key={noteKey(note, i)}
              note={note}
              index={i}
              actions={
                <div className="flex gap-1.5">
                  <Button asChild size="sm" variant="outline">
                    <Link to="/split">Split</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline" className="max-sm:hidden">
                    <Link to="/merge">Merge</Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link to="/withdraw">Withdraw</Link>
                  </Button>
                </div>
              }
            />
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Page {current + 1} of {pages}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
