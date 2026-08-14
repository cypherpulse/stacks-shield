import { Activity, Coins, Layers, Shield, Users } from "lucide-react";

import { StatCard } from "@/shared/components/StatCard";
import { Card } from "@/shared/components/ui/card";
import { ErrorState, PageHeader } from "@/shared/components/States";
import { useStats } from "@/features/dashboard/useStats";
import { priceFor, usePrices } from "@/features/assets/usePrices";
import { amountLabel, errorMessage, formatNumber, formatUsd } from "@/shared/utils/format";

export function Explorer() {
  const { data, isLoading, error, refetch } = useStats();
  const { data: prices } = usePrices();

  // Per-asset protocol totals (STX / sBTC / USDCx …), each bridged to USD so the
  // headline figures are one comparable number rather than STX alone.
  const proto = (data?.byAsset ?? [])
    .map((a) => ({
      ...a,
      shieldedUsd: a.shielded * priceFor(prices, a.symbol),
      feesUsd: a.fees * priceFor(prices, a.symbol),
    }))
    .sort((a, b) => b.shieldedUsd - a.shieldedUsd);
  const shieldedUsd = proto.reduce((s, a) => s + a.shieldedUsd, 0);
  const feesUsd = proto.reduce((s, a) => s + a.feesUsd, 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Explorer" description="Public protocol statistics — no wallet required." />

      {error ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              label="Total shielded"
              value={shieldedUsd > 0 ? formatUsd(shieldedUsd) : `${formatNumber(data?.shielded)} STX`}
              icon={Shield}
              hint={proto.length > 0 ? `${proto.length} assets` : undefined}
              loading={isLoading}
            />
            <StatCard
              label="Total operations"
              value={formatNumber(data?.operations)}
              icon={Activity}
              accent="success"
              loading={isLoading}
            />
            <StatCard
              label="Total notes"
              value={formatNumber(data?.notes)}
              icon={Coins}
              accent="teal"
              loading={isLoading}
            />
            <StatCard
              label="Total fees"
              value={feesUsd > 0 ? formatUsd(feesUsd) : `${formatNumber(data?.fees)} STX`}
              icon={Layers}
              loading={isLoading}
            />
            <StatCard
              label="Users"
              value={formatNumber(data?.users)}
              icon={Users}
              accent="muted"
              loading={isLoading}
            />
            <StatCard label="Network" value="Stacks Testnet" accent="muted" />
          </div>

          {proto.length > 0 && (
            <Card className="glass p-5">
              <p className="mb-4 text-sm font-medium">Protocol totals by asset</p>
              <div className="space-y-3">
                {proto.map((a) => (
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
        </>
      )}
    </div>
  );
}
