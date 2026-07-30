import { Activity, Coins, Layers, Shield, Users } from "lucide-react";

import { StatCard } from "@/shared/components/StatCard";
import { ErrorState, PageHeader } from "@/shared/components/States";
import { Card } from "@/shared/components/ui/card";
import { API_URL, RELAYER_URL } from "@/shared/constants/protocol";
import { useStats } from "@/features/dashboard/useStats";
import { errorMessage, formatDate, formatNumber } from "@/shared/utils/format";

export function Explorer() {
  const { data, isLoading, error, refetch } = useStats();

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
              value={`${formatNumber(data?.shielded)} STX`}
              icon={Shield}
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
              value={`${formatNumber(data?.fees)} STX`}
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

          <Card className="glass gap-2 p-5 text-sm">
            <Row label="Last updated" value={formatDate(data?.updatedAt)} />
            <Row label="API endpoint" value={API_URL} />
            <Row label="Relayer endpoint" value={RELAYER_URL} />
          </Card>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-xs break-all">{value}</span>
    </div>
  );
}
