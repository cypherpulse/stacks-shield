// =============================================================================
// STX Shield -- SDK e2e harness self-test (pure; no live services)
// =============================================================================
// Verifies the reusable suite's own logic — the Recorder, performance rollup,
// Definition-of-Done mapping, and report rendering — so the harness itself is
// trustworthy before it is pointed at live testnet.

import { describe, it, expect } from "vitest";
import { Recorder, summarize, type SuiteResult, type AssetLifecycleResult } from "./harness.js";
import { performance, issues, definitionOfDone, renderMarkdown, renderJson } from "./report.js";

const lifecycle = (asset: string, passed: boolean): AssetLifecycleResult => ({
  asset,
  conservation: passed,
  passed,
  steps: [
    { name: `${asset}: shield 2`, ok: true, ms: 12000 },
    { name: `${asset}: note tagged with correct asset`, ok: true, ms: 0 },
    { name: `${asset}: scan discovers the note`, ok: true, ms: 300 },
    { name: `${asset}: shielded note discovered`, ok: true, ms: 0 },
    { name: `${asset}: transfer (relayed)`, ok: true, ms: 9000 },
    { name: `${asset}: split 1 + 1`, ok: passed, ms: 11000, error: passed ? undefined : "boom" },
    { name: `${asset}: merge back to one note`, ok: true, ms: 10000 },
    { name: `${asset}: withdraw`, ok: true, ms: 8000 },
    { name: `${asset}: replay a spent note is rejected`, ok: true, ms: 500 },
  ],
});

const suite = (allPass: boolean): SuiteResult => ({
  network: "testnet",
  startedAt: "2026-08-06T00:00:00Z",
  finishedAt: "2026-08-06T00:30:00Z",
  assets: [lifecycle("STX", true), lifecycle("sBTC", allPass), lifecycle("USDCx", true)],
  crossAsset: [{ name: "cross-asset: merge across assets is rejected", ok: true, ms: 5 }],
  passed: allPass,
});

describe("Recorder", () => {
  it("records timing + outcome and never throws", async () => {
    const r = new Recorder();
    const ok = await r.run("step-a", async () => 42);
    expect(ok).toBe(42);
    const bad = await r.run("step-b", async () => { throw new Error("nope"); });
    expect(bad).toBeUndefined();
    r.check("a-check", true, "detail");
    expect(r.steps.map((s) => s.ok)).toEqual([true, false, true]);
    expect(r.steps[1]!.error).toBe("nope");
  });
});

describe("report", () => {
  it("summarize passes only when every asset + cross-asset check passes", () => {
    expect(summarize(suite(true).assets, suite(true).crossAsset)).toBe(true);
    expect(summarize(suite(false).assets, suite(false).crossAsset)).toBe(false);
  });

  it("rolls up performance by stage", () => {
    const perf = performance(suite(true));
    const shield = perf.find((p) => p.stage === "shield")!;
    expect(shield.count).toBe(3);
    expect(shield.avgMs).toBe(12000);
    expect(perf.map((p) => p.stage)).toEqual(["shield", "scan", "transfer", "split", "merge", "withdraw", "replay"]);
  });

  it("lists issues only for failed steps", () => {
    expect(issues(suite(true))).toHaveLength(0);
    const iss = issues(suite(false));
    expect(iss.some((i) => i.includes("sBTC") && i.includes("split"))).toBe(true);
  });

  it("maps the Definition of Done from results", () => {
    const dodPass = definitionOfDone(suite(true));
    expect(dodPass.every((d) => d.ok)).toBe(true);
    const dodFail = definitionOfDone(suite(false));
    expect(dodFail.find((d) => d.label.includes("sBTC"))!.ok).toBe(false);
  });

  it("renders markdown + valid JSON", () => {
    const md = renderMarkdown(suite(true));
    expect(md).toContain("SDK End-to-End Validation Report");
    expect(md).toContain("✅ PASS");
    expect(md).toContain("USDCx");
    const parsed = JSON.parse(renderJson(suite(true)));
    expect(parsed.passed).toBe(true);
    expect(parsed.performance.length).toBeGreaterThan(0);
    expect(parsed.definitionOfDone.length).toBe(10);
  });
});
