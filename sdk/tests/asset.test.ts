// =============================================================================
// @stx-shield/sdk -- Phase 1: asset discovery tests
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateAsset, resolveAsset, isNativeRef, type AssetInfo } from "../src/types/asset.js";
import { ApiProvider } from "../src/providers/api.js";
import { silentLogger } from "../src/utils/logger.js";

const STX: AssetInfo = {
  id: 0, symbol: "STX", token: null, decimals: 6, active: true, native: true,
  pool: "D.privacy-pool", verifier: "D.zk-verifier", splitMerge: "D.split-merge-manager", protocolFees: "D.protocol-fees",
};
const SBTC: AssetInfo = {
  id: 1, symbol: "sBTC", token: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.sbtc-token", decimals: 8, active: true, native: false,
  pool: "D.sip10-pool", verifier: "D.sip10-zk-verifier", splitMerge: "D.sip10-pool", protocolFees: "D.sip10-protocol-fees",
};

describe("asset validation", () => {
  it("accepts native STX and a SIP-10 asset", () => {
    expect(validateAsset(STX)).toEqual(STX);
    expect(validateAsset(SBTC)).toEqual(SBTC);
  });
  it("rejects a SIP-10 asset without a token principal", () => {
    expect(() => validateAsset({ ...SBTC, token: null })).toThrow(/token contract principal/);
    expect(() => validateAsset({ ...SBTC, token: "not-a-principal" })).toThrow();
  });
  it("rejects malformed records", () => {
    expect(() => validateAsset(null)).toThrow();
    expect(() => validateAsset({ ...STX, decimals: "6" })).toThrow(/decimals/);
    expect(() => validateAsset({ ...STX, symbol: "" })).toThrow(/symbol/);
  });
});

describe("asset resolution", () => {
  const assets = [STX, SBTC];
  it("treats STX / undefined / null as native", () => {
    expect(isNativeRef(undefined)).toBe(true);
    expect(isNativeRef("STX")).toBe(true);
    expect(resolveAsset(undefined, assets)).toBe(STX);
    expect(resolveAsset("stx", assets)).toBe(STX);
  });
  it("resolves by symbol and by token principal", () => {
    expect(resolveAsset("sBTC", assets)).toBe(SBTC);
    expect(resolveAsset(SBTC.token!, assets)).toBe(SBTC);
    expect(resolveAsset(SBTC, assets)).toBe(SBTC);
  });
  it("throws a clear error for an unknown asset", () => {
    expect(() => resolveAsset("DOGE", assets)).toThrow(/unknown asset "DOGE"/);
  });
});

describe("ApiProvider.getAssets", () => {
  const mkProvider = () => new ApiProvider({ baseUrl: "http://api.test", timeoutMs: 1000, logger: silentLogger });
  const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  beforeEach(() => vi.restoreAllMocks());

  it("loads + validates assets and caches them (one fetch within TTL)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ results: [STX, SBTC] }));
    vi.stubGlobal("fetch", fetchMock);
    const api = mkProvider();
    const first = await api.getAssets();
    expect(first).toHaveLength(2);
    expect(first.find((a) => a.native)?.symbol).toBe("STX");
    expect(first.find((a) => a.token === SBTC.token)?.symbol).toBe("sBTC");
    await api.getAssets(); // cached
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to empty (client synthesizes STX) when /assets is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    const api = mkProvider();
    expect(await api.getAssets()).toEqual([]);
  });
});
