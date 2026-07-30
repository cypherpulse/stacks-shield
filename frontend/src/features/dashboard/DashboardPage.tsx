import { Link } from "@tanstack/react-router";
import { Activity, Coins, Layers, Shield, Wallet } from "lucide-react";
import {
  Area,
  AreaChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";

import { ConnectGate } from "@/shared/components/ConnectGate";
import { StatCard } from "@/shared/components/StatCard";
import { EmptyState, ListSkeleton, PageHeader } from "@/shared/components/States";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { useActivity } from "@/features/activity/useActivity";
import { useNotes } from "@/features/notes/useNotes";
import { useStats } from "@/features/dashboard/useStats";
import { formatNumber, formatStx, relativeTime, toStx } from "@/shared/utils/format";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

export function Dashboard() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Your private balance at a glance."
        actions={
          <Button asChild>
            <Link to="/shield">Shield STX</Link>
          </Button>
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
  const balance = unspent.reduce((sum, n) => sum + toStx(n.amount), 0);
  const entries = history ?? [];
  const pending = entries.filter((e) => (e.status ?? "").toLowerCase() === "pending").length;

  const byDay = Object.entries(
    entries.reduce<Record<string, number>>((acc, e) => {
      const d = new Date(e.timestamp ?? e.createdAt ?? Date.now());
      const key = Number.isNaN(d.getTime())
        ? "—"
        : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  ).map(([day, count]) => ({ day, count }));

  const distribution = unspent.slice(0, 6).map((n, i) => ({
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
          label="Total notes"
          value={formatNumber(unspent.length)}
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
          label="Pending"
          value={formatNumber(pending)}
          icon={Layers}
          accent="muted"
          loading={historyLoading}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="glass p-5 lg:col-span-2">
          <p className="text-sm font-medium">Operations over time</p>
          {byDay.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">No operations yet.</p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={byDay}>
                  <defs>
                    <linearGradient id="ops" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.7} />
                      <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={11} />
                  <Tooltip
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 12,
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="var(--chart-1)"
                    fill="url(#ops)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card className="glass p-5">
          <p className="text-sm font-medium">Note distribution</p>
          {distribution.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">No notes yet.</p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={distribution} dataKey="value" innerRadius={45} outerRadius={75}>
                    {distribution.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
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
          )}
        </Card>
      </div>

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
                <p className="font-mono text-sm">{e.amount ? formatStx(e.amount) : "—"}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
