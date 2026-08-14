// =============================================================================
// STX Shield API -- unified asset registry (read model)
// =============================================================================
// The single source of truth for "what assets does this protocol support" is
// the on-chain asset-registry contract. This reads it live (briefly cached) and
// presents it alongside native STX as one uniform list, tagged with the pool +
// verifier each asset routes to. The SDK and clients consume this so an app
// never hardcodes a pool or picks a contract by hand.

import { cvToJSON, hexToCV, Cl, cvToHex } from "@stacks/transactions";
import { config } from "../config.js";
import { callReadOnly } from "../utils/hiro.js";

export interface AssetInfo {
  /** Asset uid. 0 is reserved for native STX; SIP-10 assets are 1.. */
  id: number;
  symbol: string;
  /** Token contract principal, or null for native STX. */
  token: string | null;
  decimals: number;
  /** true once the asset is ACTIVE and shieldable (native STX is always active). */
  active: boolean;
  native: boolean;
  /** Backend routing for this asset. */
  pool: string;
  verifier: string;
  splitMerge: string;
  protocolFees: string;
}

const NATIVE: AssetInfo = {
  id: 0,
  symbol: "STX",
  token: null,
  decimals: 6,
  active: true,
  native: true,
  pool: config.contracts.privacyPool,
  verifier: config.contracts.zkVerifier,
  splitMerge: config.contracts.splitMerge,
  protocolFees: config.contracts.protocolFees,
};

const CACHE_MS = 60_000;
let cache: { at: number; assets: AssetInfo[] } | null = null;

const num = (n: unknown): number => (typeof n === "object" && n && "value" in n ? Number((n as { value: string }).value) : Number(n));
const str = (n: unknown): string => (typeof n === "object" && n && "value" in n ? String((n as { value: string }).value) : String(n));

/** Read one SIP-10 asset from the on-chain registry, or null if absent. */
const readAsset = async (uid: number): Promise<AssetInfo | null> => {
  const hex = await callReadOnly(config.contracts.assetRegistry, "get-asset", [cvToHex(Cl.uint(uid))]);
  if (!hex) return null;
  const j = cvToJSON(hexToCV(hex)) as { value?: { value?: Record<string, { value?: unknown }> } };
  const a = j.value?.value; // (some { ... }) -> .value.value is the tuple
  if (!a) return null;
  return {
    id: uid,
    symbol: str(a["name"]?.value),
    token: str(a["token"]?.value),
    decimals: num(a["decimals"]?.value),
    active: num(a["status"]?.value) === 1, // 1 = ACTIVE
    native: false,
    pool: config.contracts.sip10Pool,
    verifier: config.contracts.sip10ZkVerifier,
    splitMerge: config.contracts.sip10Pool, // sip10-pool hosts split/merge itself
    protocolFees: config.contracts.sip10ProtocolFees,
  };
};

/** Unified asset list: native STX + every registered SIP-10 asset. Cached. */
export const getAssets = async (): Promise<AssetInfo[]> => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.assets;

  const assets: AssetInfo[] = [NATIVE];
  try {
    const countHex = await callReadOnly(config.contracts.assetRegistry, "get-asset-count");
    const count = countHex ? num((cvToJSON(hexToCV(countHex)) as { value?: unknown }).value) : 0;
    for (let uid = 1; uid <= count; uid++) {
      const asset = await readAsset(uid);
      if (asset) assets.push(asset);
    }
  } catch {
    // Registry unreachable (e.g. not deployed on this network): return native only.
  }

  cache = { at: Date.now(), assets };
  return assets;
};

/** Look up an asset by token principal (or "STX"/null for native). */
export const assetByToken = async (token: string | null | undefined): Promise<AssetInfo | undefined> => {
  const assets = await getAssets();
  if (!token || token.toUpperCase() === "STX") return assets.find((a) => a.native);
  return assets.find((a) => a.token === token);
};
