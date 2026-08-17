// =============================================================================
// STX Shield -- SDK e2e validation report renderer (pure)
// =============================================================================
// Turns a SuiteResult into a machine-readable JSON + a human validation report
// with a performance summary and a Definition-of-Done checklist.

import type { SuiteResult, StepResult, AssetLifecycleResult } from "./harness.js";

const yn = (b: boolean) => (b ? "PASS" : "FAIL");
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);

/** Latency summary per lifecycle stage, across all asset runs. */
export interface PerfStat { stage: string; count: number; minMs: number; maxMs: number; avgMs: number }

const stageOf = (stepName: string): string => {
  const m = stepName.match(/:\s*(shield|scan|transfer|split|merge|withdraw|replay)/i);
  return m ? m[1]!.toLowerCase() : "other";
};

export const performance = (result: SuiteResult): PerfStat[] => {
  const byStage = new Map<string, number[]>();
  for (const a of result.assets)
    for (const s of a.steps)
      if (s.ok && s.ms > 0) {
        const st = stageOf(s.name);
        (byStage.get(st) ?? byStage.set(st, []).get(st)!).push(s.ms);
      }
  const order = ["shield", "scan", "transfer", "split", "merge", "withdraw", "replay", "other"];
  return [...byStage.entries()]
    .map(([stage, xs]) => ({ stage, count: xs.length, minMs: Math.min(...xs), maxMs: Math.max(...xs), avgMs: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) }))
    .sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
};

/** Every failed step, as human "issues". */
export const issues = (result: SuiteResult): string[] => {
  const out: string[] = [];
  for (const a of result.assets) for (const s of a.steps) if (!s.ok) out.push(`[${a.asset}] ${s.name}: ${s.error ?? s.detail ?? "failed"}`);
  for (const s of result.crossAsset) if (!s.ok) out.push(`[cross-asset] ${s.name}: ${s.error ?? s.detail ?? "failed"}`);
  return out;
};

const assetBlock = (a: AssetLifecycleResult): string => {
  const rows = a.steps.map((s: StepResult) => `| ${s.ok ? "✓" : "✗"} | ${s.name} | ${ms(s.ms)} | ${(s.error ?? s.detail ?? "").toString().slice(0, 60)} |`).join("\n");
  return `### ${a.asset} — ${yn(a.passed)}\n\n| | Step | Time | Notes |\n|---|---|---|---|\n${rows}\n`;
};

/** Full markdown validation report. */
export const renderMarkdown = (result: SuiteResult): string => {
  const perf = performance(result);
  const iss = issues(result);
  const dod = definitionOfDone(result);
  return `# STX Shield v1 — SDK End-to-End Validation Report

**Network:** ${result.network}  ·  **Started:** ${result.startedAt}  ·  **Finished:** ${result.finishedAt}
**Overall:** ${result.passed ? "✅ PASS" : "❌ FAIL"}

Every operation below ran through \`@stx-shield/sdk\` only — the SDK selected the
pool, circuit, and relayer automatically. Stack exercised end to end:
SDK → API → Relayer → zkVerify → Stacks Testnet → Smart Contracts.

## Per-asset lifecycles

${result.assets.map(assetBlock).join("\n")}

## Cross-asset isolation

| | Check | Notes |
|---|---|---|
${result.crossAsset.map((s) => `| ${s.ok ? "✓" : "✗"} | ${s.name} | ${(s.error ?? s.detail ?? "").toString().slice(0, 60)} |`).join("\n")}

## Performance summary

| Stage | Runs | Min | Avg | Max |
|---|---|---|---|---|
${perf.map((p) => `| ${p.stage} | ${p.count} | ${ms(p.minMs)} | ${ms(p.avgMs)} | ${ms(p.maxMs)} |`).join("\n")}

> Timings are per full SDK operation (proof generation + zkVerify aggregation
> dominate shield/spend; API/relayer calls are sub-second). zkVerify aggregation
> latency is variable and typically the long pole.

## Discovered issues

${iss.length ? iss.map((i) => `- ${i}`).join("\n") : "None — all steps passed."}

## Definition of Done

${dod.map((d) => `- ${d.ok ? "✓" : "✗"} ${d.label}`).join("\n")}

## Recommendations

${recommendations(result).map((r) => `- ${r}`).join("\n")}
`;
};

export interface DodItem { label: string; ok: boolean }
export const definitionOfDone = (result: SuiteResult): DodItem[] => {
  const asset = (label: string) => result.assets.find((a) => a.asset.toLowerCase().includes(label));
  const stepOk = (a: AssetLifecycleResult | undefined, kw: string) => !!a && a.steps.some((s) => s.name.toLowerCase().includes(kw) && s.ok);
  const stx = asset("stx"), sbtc = asset("sbtc"), usdcx = asset("usdcx");
  return [
    { label: "Native STX passes end-to-end", ok: !!stx?.passed },
    { label: "sBTC passes end-to-end", ok: !!sbtc?.passed },
    { label: "USDCx passes end-to-end", ok: !!usdcx?.passed },
    { label: "Asset routing verified (correct asset tag on notes)", ok: result.assets.every((a) => stepOk(a, "correct asset")) },
    { label: "Proof generation verified (shield/spend produced valid proofs)", ok: result.assets.every((a) => stepOk(a, "shield")) },
    { label: "Scanner verified (notes discovered)", ok: result.assets.every((a) => stepOk(a, "discover")) },
    { label: "Replay protection verified", ok: result.assets.every((a) => stepOk(a, "replay")) },
    { label: "Value conservation verified", ok: result.assets.every((a) => a.conservation) },
    { label: "Cross-asset isolation verified", ok: result.crossAsset.every((s) => s.ok) },
    { label: "Withdrawal verified", ok: result.assets.every((a) => stepOk(a, "withdraw")) },
  ];
};

export const recommendations = (result: SuiteResult): string[] => {
  const recs: string[] = [];
  const perf = performance(result);
  const shield = perf.find((p) => p.stage === "shield");
  if (shield && shield.maxMs > 300_000) recs.push("zkVerify aggregation latency is high (>5 min on some runs); consider a dedicated aggregation domain with a small aggregation size for faster publication.");
  if (issues(result).length === 0) recs.push("All checks passed — Stacks Shield v1 is validated end-to-end on testnet; proceed to release tagging.");
  else recs.push("Resolve the discovered issues above (validation-blocking only) and re-run the suite.");
  return recs;
};

/** Machine-readable payload for CI / dashboards. */
export const renderJson = (result: SuiteResult): string =>
  JSON.stringify({ ...result, performance: performance(result), definitionOfDone: definitionOfDone(result), issues: issues(result) }, null, 2);
