import { useQuery } from "@tanstack/react-query";

import { getShield } from "@/services/sdk/shield.service";
import type { AssetInfo } from "@/shared/types/shield";

/** Native STX is always present, even if the API's /assets is unreachable — the
 *  SDK synthesizes it, but we keep a local fallback so the picker never empties. */
const STX_FALLBACK: AssetInfo = {
  id: 0,
  symbol: "STX",
  token: null,
  decimals: 6,
  active: true,
  native: true,
};

/**
 * All protocol assets (native STX + registered SIP-10 tokens), sourced from the
 * SDK's on-chain-backed asset registry. Cached — the registry rarely changes.
 */
export function useAssets() {
  return useQuery<AssetInfo[]>({
    queryKey: ["assets"],
    queryFn: async () => {
      const client = await getShield();
      const assets = await client.getAssets();
      return assets.length > 0 ? assets : [STX_FALLBACK];
    },
    staleTime: 5 * 60_000,
    placeholderData: [STX_FALLBACK],
    retry: 1,
  });
}

/** Assets shieldable right now (for the shield/deposit picker). */
export function shieldableAssets(assets: AssetInfo[] | undefined): AssetInfo[] {
  return (assets ?? [STX_FALLBACK]).filter((a) => a.active);
}
