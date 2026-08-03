import { Link } from "@tanstack/react-router";
import { Activity, Coins, Layers, Shield, Wallet } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { ConnectGate } from "@/shared/components/ConnectGate";
import { StatCard } from "@/shared/components/StatCard";
import { EmptyState, ListSkeleton, PageHeader } from "@/shared/components/States";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { useActivity } from "@/features/activity/useActivity";
import { useNotes } from "@/features/notes/useNotes";
import { useStats } from "@/features/dashboard/useStats";
import { formatNumber, relativeTime, stxLabel, toStx } from "@/shared/utils/format";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

export function Dashboard() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Your private balance at a glance."
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/faucet">Get testnet STX</Link>
            </Button>
            <Button asChild>
              <Link to="/shield">Shield STX</Link>
            </Button>
          </>
        }
      />
      <ConnectGate>
        <DashboardContent />
      </ConnectGate>
    </div>
  );
}

function DashboardContent() {
  const { data: notes, isLoading: notesLoading } = useNotes();
  const { data: history, isLoading: historyLoading } = useActivity();
  const { data: stats } = useStats();

  const unspent = (notes ?? []).filter((n) => !n.spent);
  // Balance counts ONLY notes confirmed on chain — a shield/transfer that was
  // submitted but not yet (or never) confirmed must not inflate the balance.
  const confirmed = unspent.filter((n) => n.status === "confirmed");
  const pendingNotes = unspent.filter((n) => n.status === "pending");
  const balance = confirmed.reduce((sum, n) => sum + toStx(n.amount), 0);
  const entries = history ?? [];
  const pending = pendingNotes.length;

  // Amounts are private to the API, so resolve them locally from known notes.
  const amountByCommitment = new Map<string, number>();
  for (const n of notes ?? []) {
    if (n.commitment) amountByCommitment.set(n.commitment.toLowerCase().replace(/^0x/, ""), toStx(n.amount));
  }

  const distribution = confirmed.slice(0, 6).map((n, i) => ({
    name: `Note ${i + 1}`,
    value: toStx(n.amount),
  }));

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Shielded balance"
          value={`${balance.toLocaleString(undefined, { maximumFractionDigits: 6 })} STX`}
          icon={Shield}
          loading={notesLoading}
        />
        <StatCard
          label="Confirmed notes"
          value={formatNumber(confirmed.length)}
          icon={Coins}
          accent="teal"
          loading={notesLoading}
        />
        <StatCard
          label="Total operations"
          value={formatNumber(entries.length)}
          icon={Activity}
          accent="success"
          loading={historyLoading}
        />
        <StatCard
          label="Pending notes"
          value={formatNumber(pending)}
          icon={Layers}
          accent={pending > 0 ? "primary" : "muted"}
          hint={pending > 0 ? "awaiting on-chain confirmation" : undefined}
          loading={notesLoading}
        />
      </div>

      <Card className="glass p-5">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm font-medium">Balance breakdown</p>
          <span className="text-xs text-muted-foreground">
            {formatNumber(confirmed.length)} confirmed {confirmed.length === 1 ? "note" : "notes"}
          </span>
        </div>
        {distribution.length === 0 ? (
          <EmptyState
            icon={Coins}
            title="No notes yet"
            description="Shield some STX to see how your private balance is split across notes."
          />
        ) : (
          <div className="grid items-center gap-6 sm:grid-cols-[190px_1fr]">
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={distribution}
                    dataKey="value"
                    innerRadius={50}
                    outerRadius={74}
                    paddingAngle={distribution.length > 1 ? 2 : 0}
                  >
                    {distribution.map((_, i) => (
                      <Cell
                        key={i}
                        fill={COLORS[i % COLORS.length]}
                        stroke="var(--card)"
                        strokeWidth={2}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: number) => [`${v.toLocaleString()} STX`, "Amount"]}
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 12,
                      fontSize: 12,
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-2.5">
              {distribution.map((d, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2.5">
                    <span
                      className="size-2.5 rounded-full"
                      style={{ background: COLORS[i % COLORS.length] }}
                    />
                    {d.name}
                  </span>
                  <span className="font-mono">{stxLabel(d.value)}</span>
                </div>
              ))}
              {confirmed.length > distribution.length && (
                <p className="pt-1 text-xs text-muted-foreground">
                  +{confirmed.length - distribution.length} more
                </p>
              )}
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total shielded (protocol)"
          value={`${formatNumber(stats?.shielded)} STX`}
        />
        <StatCard label="Protocol operations" value={formatNumber(stats?.operations)} />
        <StatCard label="Protocol fees" value={`${formatNumber(stats?.fees)} STX`} />
        <StatCard label="Network" value="Stacks Testnet" />
      </div>

      <Card className="glass p-5">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm font-medium">Recent activity</p>
          <Button asChild variant="ghost" size="sm">
            <Link to="/activity">View all</Link>
          </Button>
        </div>
        {historyLoading ? (
          <ListSkeleton rows={3} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="No activity yet"
            description="Shield your first STX to get started."
          />
        ) : (
          <div className="divide-y divide-border">
            {entries.slice(0, 6).map((e, i) => (
              <div key={e.id ?? i} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-medium capitalize">{e.type}</p>
                  <p className="text-xs text-muted-foreground">
                    {relativeTime(e.timestamp ?? e.createdAt)}
                  </p>
                </div>
                {(() => {
                  const amt = e.commitment
                    ? amountByCommitment.get(e.commitment.toLowerCase().replace(/^0x/, ""))
                    : undefined;
                  return amt != null ? (
                    <p className="font-mono text-sm">{stxLabel(amt)}</p>
                  ) : null;
                })()}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
