import { useQuery } from "@tanstack/react-query";

import { getShield } from "@/services/sdk/shield.service";
import { useWalletStore } from "@/store/wallet";
import type { ShieldNote } from "@/shared/types/shield";

export function useNotes() {
  const address = useWalletStore((s) => s.address);

  return useQuery<ShieldNote[]>({
    queryKey: ["notes", address],
    enabled: Boolean(address),
    queryFn: async () => {
      const client = await getShield();
      await client.connect();
      const notes = await client.getNotes();
      return notes ?? [];
    },
    staleTime: 15_000,
    retry: 1,
  });
}
