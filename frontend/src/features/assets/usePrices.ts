import { useQuery } from "@tanstack/react-query";

/**
 * Live USD prices for the protocol assets, from CoinGecko's public API.
 * sBTC tracks BTC and USDCx tracks USDC, so we price them by their underlying.
 * Unknown symbols return 0 (no USD shown) — the UI degrades gracefully.
 */
const COINGECKO_ID: Record<string, string> = {
  STX: "blockstack",
  sBTC: "bitcoin",
  USDCx: "usd-coin",
};

export type PriceMap = Record<string, number>;

export function usePrices() {
  return useQuery<PriceMap>({
    queryKey: ["prices"],
    queryFn: async () => {
      const ids = [...new Set(Object.values(COINGECKO_ID))].join(",");
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      );
      if (!res.ok) throw new Error(`price feed ${res.status}`);
      const data = (await res.json()) as Record<string, { usd?: number }>;
      const out: PriceMap = {};
      for (const [symbol, id] of Object.entries(COINGECKO_ID)) {
        out[symbol] = data[id]?.usd ?? 0;
      }
      return out;
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  });
}

/** USD price for a symbol (0 if unknown / feed unavailable). */
export function priceFor(prices: PriceMap | undefined, symbol: string): number {
  return prices?.[symbol] ?? 0;
}
