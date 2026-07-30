import { useQuery } from "@tanstack/react-query";

import { getShield } from "@/services/sdk/shield.service";
import type { Stats } from "@/shared/types/shield";

export function useStats() {
  return useQuery<Stats>({
    queryKey: ["stats"],
    queryFn: async () => {
      const client = await getShield();
      return client.getStats();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 2,
  });
}
