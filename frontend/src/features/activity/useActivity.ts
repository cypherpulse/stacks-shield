import { useQuery } from "@tanstack/react-query";

import { getShield } from "@/services/sdk/shield.service";
import { useWalletStore } from "@/store/wallet";
import type { HistoryEntry } from "@/shared/types/shield";

export function useActivity() {
  const address = useWalletStore((s) => s.address);

  return useQuery<HistoryEntry[]>({
    queryKey: ["history", address],
    enabled: Boolean(address),
    queryFn: async () => {
      const client = await getShield();
      await client.connect();
      const history = await client.getHistory();
      return history ?? [];
    },
    staleTime: 15_000,
    retry: 1,
  });
}
