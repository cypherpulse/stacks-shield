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
import { priceFor, usePrices } from "@/features/assets/usePrices";
import {
  amountLabel,
  formatNumber,
  formatUsd,
  noteAsset,
  noteDisplay,
  relativeTime,
} from "@/shared/utils/format";

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
  const { data: prices } = usePrices();

  const unspent = (notes ?? []).filter((n) => !n.spent);
  // Spendable balance = every unspent note that hasn't explicitly failed. A note
  // is only excluded while still "pending" on chain; notes with a confirmed or
  // unset status (locally-discovered / SIP-10) all count toward the balance.
  const pendingNotes = unspent.filter((n) => n.status === "pending");
  const confirmed = unspent.filter((n) => n.status !== "pending" && n.status !== "failed");
  const entries = history ?? [];
  const pending = pendingNotes.length;

  // Multi-asset: never sum across assets (sBTC + USDCx have no common unit).
  // Aggregate the balance PER asset symbol, then bridge to a common USD value.
  const byAssetMap = new Map<string, number>();
  for (const n of confirmed) {
    const sym = noteAsset(n).symbol;
    byAssetMap.set(sym, (byAssetMap.get(sym) ?? 0) + noteDisplay(n));
  }
  const byAsset = [...byAssetMap.entries()]
    .map(([symbol, value]) => ({ symbol, value, usd: value * priceFor(prices, symbol) }))
    .sort((a, b) => b.usd - a.usd);
  const totalUsd = byAsset.reduce((sum, a) => sum + a.usd, 0);

  // Amounts are private to the API, so resolve them locally from known notes
  // (as a label carrying each note's own asset symbol).
  const amountByCommitment = new Map<string, string>();
  for (const n of notes ?? []) {
    if (n.commitment)
      amountByCommitment.set(
        n.commitment.toLowerCase().replace(/^0x/, ""),
        amountLabel(noteDisplay(n), noteAsset(n).symbol),
      );
  }

  // Pie is sized by USD so slices are comparable across assets (falls back to
  // the raw amount when no price is available, e.g. the feed is unreachable).
  const distribution = byAsset
    .slice(0, 6)
    .map((a) => ({ symbol: a.symbol, value: a.usd > 0 ? a.usd : a.value, amount: a.value, usd: a.usd }));

  // Protocol-wide totals per asset (from the API's live pool/treasury reads),
  // each bridged to USD like the personal balance above.
  const protoAssets = (stats?.byAsset ?? [])
    .map((a) => ({
      ...a,
      shieldedUsd: a.shielded * priceFor(prices, a.symbol),
      feesUsd: a.fees * priceFor(prices, a.symbol),
    }))
    .sort((a, b) => b.shieldedUsd - a.shieldedUsd);
  const protoShieldedUsd = protoAssets.reduce((s, a) => s + a.shieldedUsd, 0);
  const protoFeesUsd = protoAssets.reduce((s, a) => s + a.feesUsd, 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Shielded value"
          value={formatUsd(totalUsd)}
          icon={Shield}
          hint={byAsset.length > 0 ? `${byAsset.length} asset${byAsset.length > 1 ? "s" : ""} shielded` : undefined}
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
            description="Shield STX, sBTC or USDCx to see how your private balance splits across assets."
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
                    formatter={(
                      _v: number,
                      _n,
                      item: { payload?: { symbol?: string; amount?: number; usd?: number } },
                    ) => {
                      const p = item?.payload;
                      const amt = amountLabel(p?.amount ?? 0, p?.symbol ?? "");
                      return [p?.usd ? `${amt} · ${formatUsd(p.usd)}` : amt, p?.symbol ?? "Amount"];
                    }}
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
                    {d.symbol}
                  </span>
                  <span className="flex flex-col items-end leading-tight">
                    <span className="font-mono">{amountLabel(d.amount, d.symbol)}</span>
                    {d.usd > 0 && (
                      <span className="font-mono text-xs text-muted-foreground">{formatUsd(d.usd)}</span>
                    )}
                  </span>
                </div>
              ))}
              {byAsset.length > distribution.length && (
                <p className="pt-1 text-xs text-muted-foreground">
                  +{byAsset.length - distribution.length} more
                </p>
              )}
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total shielded (protocol)"
          value={protoShieldedUsd > 0 ? formatUsd(protoShieldedUsd) : `${formatNumber(stats?.shielded)} STX`}
          hint={protoAssets.length > 0 ? `${protoAssets.length} assets` : undefined}
        />
        <StatCard label="Protocol operations" value={formatNumber(stats?.operations)} />
        <StatCard
          label="Protocol fees"
          value={protoFeesUsd > 0 ? formatUsd(protoFeesUsd) : `${formatNumber(stats?.fees)} STX`}
        />
        <StatCard label="Network" value="Stacks Testnet" />
      </div>

      {protoAssets.length > 0 && (
        <Card className="glass p-5">
          <p className="mb-4 text-sm font-medium">Protocol totals by asset</p>
          <div className="space-y-3">
            {protoAssets.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-4 border-b border-border/60 pb-3 text-sm last:border-0 last:pb-0"
              >
                <span className="font-medium">{a.symbol}</span>
                <div className="flex gap-8 text-right">
                  <div>
                    <p className="text-[11px] tracking-wide text-muted-foreground uppercase">Shielded</p>
                    <p className="font-mono">{amountLabel(a.shielded, a.symbol)}</p>
                    {a.shieldedUsd > 0 && (
                      <p className="font-mono text-xs text-muted-foreground">{formatUsd(a.shieldedUsd)}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-[11px] tracking-wide text-muted-foreground uppercase">Fees</p>
                    <p className="font-mono">{amountLabel(a.fees, a.symbol)}</p>
                    {a.feesUsd > 0 && (
                      <p className="font-mono text-xs text-muted-foreground">{formatUsd(a.feesUsd)}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

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
                    <p className="font-mono text-sm">{amt}</p>
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
