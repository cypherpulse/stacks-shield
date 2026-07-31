import { Activity as ActivityIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { ConnectGate } from "@/shared/components/ConnectGate";
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from "@/shared/components/States";
import { Badge } from "@/shared/components/ui/badge";
import { Card } from "@/shared/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { useActivity } from "@/features/activity/useActivity";
import { useNotes } from "@/features/notes/useNotes";
import { errorMessage, formatDate, stxLabel, toStx, truncate } from "@/shared/utils/format";

const bare = (c: string) => c.toLowerCase().replace(/^0x/, "");

export function ActivityPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Activity" description="Every operation this wallet has performed." />
      <ConnectGate>
        <Timeline />
      </ConnectGate>
    </div>
  );
}

function Timeline() {
  const { data, isLoading, error, refetch } = useActivity();
  const { data: notes } = useNotes();
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");

  // The API never sees plaintext amounts (they are encrypted in the note), so
  // fill them in locally by matching each entry's commitment to a known note.
  const amountByCommitment = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes ?? []) if (n.commitment) m.set(bare(n.commitment), toStx(n.amount));
    return m;
  }, [notes]);

  const entries = useMemo(
    () =>
      (data ?? []).filter((e) => {
        if (type !== "all" && e.type !== type) return false;
        if (status !== "all" && (e.status ?? "").toLowerCase() !== status) return false;
        return true;
      }),
    [data, type, status],
  );

  if (isLoading) return <ListSkeleton />;
  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["all", "shield", "transfer", "split", "merge", "withdraw"].map((t) => (
              <SelectItem key={t} value={t} className="capitalize">
                {t === "all" ? "All operations" : t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["all", "pending", "confirmed", "failed"].map((s) => (
              <SelectItem key={s} value={s} className="capitalize">
                {s === "all" ? "All statuses" : s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon={ActivityIcon}
          title="No activity yet"
          description="Your operations will appear here once you shield STX."
        />
      ) : (
        <Card className="glass divide-y divide-border p-0">
          {entries.map((e, i) => (
            <div key={e.id ?? i} className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium capitalize">{e.type}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {e.txid ? truncate(e.txid, 10, 6) : formatDate(e.timestamp ?? e.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {(() => {
                  const amt = e.commitment ? amountByCommitment.get(bare(e.commitment)) : undefined;
                  return amt != null ? (
                    <span className="font-mono text-sm">{stxLabel(amt)}</span>
                  ) : null;
                })()}
                <Badge variant="outline" className="capitalize">
                  {e.status ?? "submitted"}
                </Badge>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
