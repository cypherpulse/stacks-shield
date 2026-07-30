/**
 * Typed access to the app's build-time environment. All values are optional and
 * fall back to the live testnet deployment so the app runs with zero config.
 */
const str = (v: string | undefined, fallback: string) => (v && v.trim() ? v.trim() : fallback);

export const env = {
  apiUrl: str(import.meta.env.VITE_API_URL, "https://stx-shield-api.onrender.com"),
  relayerUrl: str(import.meta.env.VITE_RELAYER_URL, "https://stx-shield-relayer.onrender.com"),
  zkVerifyUrl: str(import.meta.env.VITE_ZKVERIFY_URL, ""),
  network: str(import.meta.env.VITE_NETWORK, "testnet") as "testnet" | "mainnet",
  isDev: import.meta.env.DEV,
} as const;
