import { Activity, Coins, Layers, Shield, Users } from "lucide-react";

import { StatCard } from "@/shared/components/StatCard";
import { ErrorState, PageHeader } from "@/shared/components/States";
import { useStats } from "@/features/dashboard/useStats";
import { errorMessage, formatNumber } from "@/shared/utils/format";

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
        </>
      )}
    </div>
  );
}
