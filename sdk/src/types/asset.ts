// =============================================================================
// @stacks-shield/sdk -- asset model
// =============================================================================
// The unified view of a supported asset. Sourced from the API's GET /assets
// (which reads the on-chain asset-registry), so adding a new SIP-10 asset needs
// only on-chain registration — no SDK code change. Native STX is always present.

/** A protocol asset: native STX or a registered SIP-10 token. */
export interface AssetInfo {
  /** Asset uid. 0 is native STX; SIP-10 assets are 1.. (asset-registry order). */
  id: number;
  /** Short symbol, e.g. "STX", "sBTC", "USDCx". */
  symbol: string;
  /** SIP-10 token contract principal ("ADDR.name"), or null for native STX. */
  token: string | null;
  /** Base-unit decimals (STX = 6, sBTC = 8, USDCx = 6). */
  decimals: number;
  /** Shieldable right now (native STX is always active). */
  active: boolean;
  /** True for native STX. */
  native: boolean;
  /** Backend routing (contract principals) for this asset. */
  pool: string;
  verifier: string;
  splitMerge: string;
  protocolFees: string;
}

/** How a caller names an asset: a symbol ("STX"/"sBTC"), a token principal, an
 *  AssetInfo, or undefined/null (⇒ native STX, the default). */
export type AssetRef = string | AssetInfo | null | undefined;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Validate + normalize one asset record from the API. Throws on a malformed
 *  entry so a bad registry read never silently routes to the wrong pool. */
export const validateAsset = (raw: unknown): AssetInfo => {
  if (!isObj(raw)) throw new Error("asset: not an object");
  const s = (k: string): string => {
    const v = raw[k];
    if (typeof v !== "string" || v.length === 0) throw new Error(`asset: "${k}" must be a non-empty string`);
    return v;
  };
  const n = (k: string): number => {
    const v = raw[k];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`asset: "${k}" must be a number`);
    return v;
  };
  const native = raw["native"] === true;
  const token = raw["token"];
  if (!native && (typeof token !== "string" || !/^S[0-9A-Z]{38,40}\.[a-zA-Z][a-zA-Z0-9-]*$/.test(token))) {
    throw new Error("asset: SIP-10 asset requires a token contract principal");
  }
  return {
    id: n("id"),
    symbol: s("symbol"),
    token: native ? null : (token as string),
    decimals: n("decimals"),
    active: raw["active"] === true,
    native,
    pool: s("pool"),
    verifier: s("verifier"),
    splitMerge: s("splitMerge"),
    protocolFees: s("protocolFees"),
  };
};

/** Does this ref denote native STX? (undefined/null/"STX"/native AssetInfo) */
export const isNativeRef = (ref: AssetRef): boolean => {
  if (ref == null) return true;
  if (typeof ref === "string") return ref.toUpperCase() === "STX";
  return ref.native;
};

/** Resolve a caller's AssetRef against a discovered asset list. Throws a clear
 *  error naming the unknown asset rather than silently defaulting. */
export const resolveAsset = (ref: AssetRef, assets: AssetInfo[]): AssetInfo => {
  if (isNativeRef(ref)) {
    const native = assets.find((a) => a.native);
    if (!native) throw new Error("asset: native STX not present in the asset list");
    return native;
  }
  if (typeof ref !== "string") return ref as AssetInfo; // non-native AssetInfo (null/undefined handled above)
  const match = assets.find((a) => a.token === ref || a.symbol.toLowerCase() === ref.toLowerCase());
  if (!match) throw new Error(`asset: unknown asset "${ref}" (not STX and not a registered token/symbol)`);
  return match;
};
