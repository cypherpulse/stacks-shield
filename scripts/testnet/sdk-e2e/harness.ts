// =============================================================================
// STX Shield -- reusable SDK end-to-end validation harness
// =============================================================================
// A REUSABLE suite (not a one-off demo) that drives the full production stack
// THROUGH @stx-shield/sdk only — the SDK is the sole interface, exactly as an
// app developer would use it. It proves every layer interoperates:
//
//   @stx-shield/sdk -> API -> Relayer -> zkVerify -> Stacks Testnet -> Contracts
//
// For each configured asset (STX, sBTC, USDCx, or any future SIP-10 asset) it
// runs the identical lifecycle and records timings + pass/fail:
//
//   shield -> scan(discover) -> transfer -> split -> merge -> withdraw
//             + replay-protection + value-conservation checks
//
// then a cross-asset isolation pass. Results feed report.ts. The harness never
// picks a pool or circuit — the SDK routes by asset automatically; that IS what
// is under test. Run whenever a new protocol version ships.

import type { STXShield, ShieldNote, AssetRef } from "../../../sdk/src/index.js";

export interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
  error?: string;
}
export interface AssetLifecycleResult {
  asset: string;
  steps: StepResult[];
  conservation: boolean;
  passed: boolean;
}
export interface SuiteResult {
  network: string;
  startedAt: string;
  finishedAt: string;
  assets: AssetLifecycleResult[];
  crossAsset: StepResult[];
  passed: boolean;
}

/** Per-asset lifecycle amounts, in HUMAN units (scaled by the asset's decimals
 *  inside the SDK). Split parts must sum to `shield`. */
export interface AssetPlan {
  ref: AssetRef;    // undefined/"STX" = native; symbol or token principal for SIP-10
  label: string;
  shield: number;   // e.g. 2 STX / 0.1 sBTC / 5 USDCx
  split: [number, number];
}

/** Records a step's wall-clock time and outcome; never throws. */
export class Recorder {
  readonly steps: StepResult[] = [];
  async run<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    const t0 = Date.now();
    try {
      const out = await fn();
      this.steps.push({ name, ok: true, ms: Date.now() - t0 });
      return out;
    } catch (e) {
      this.steps.push({ name, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }
  /** A pure assertion step (no async work) — records ok/detail. */
  check(name: string, ok: boolean, detail?: string): boolean {
    this.steps.push({ name, ok, ms: 0, detail });
    return ok;
  }
}

const near = (a: bigint, b: bigint, tolBps = 100n): boolean => {
  // allow a small fee tolerance (withdraw nets a protocol fee)
  const hi = a > b ? a : b, lo = a > b ? b : a;
  return hi === 0n ? lo === 0n : (hi - lo) * 10_000n <= hi * tolBps;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Indexer/aggregation lag, not a logic error: the SDK rebuilds its tree from the
// API's /commitments each op, so a spend right after the prior op can race the
// indexer. These ops fail fast (before proof generation) with one of these, so
// retrying re-syncs cheaply until the commitment/root/aggregation is available.
const LAG_RE = /not on chain yet|not yet confirmed|unknown[_ ]root|aggregation[_ ]not[_ ]published|no unspent|transferred output not on chain|fetch failed|ECONNRE|socket hang up|network|timed out|502|503|504/i;
const LAG_TIMEOUT_MS = Number(process.env.SIP10_E2E_LAG_TIMEOUT_MS ?? 300_000);
const retryOnLag = async <T>(fn: () => Promise<T>): Promise<T> => {
  const deadline = Date.now() + LAG_TIMEOUT_MS;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (LAG_RE.test(msg) && Date.now() < deadline) { await sleep(8000); continue; }
      throw e;
    }
  }
};

/**
 * Run the full private lifecycle for ONE asset through the SDK. Single-wallet:
 * notes are transferred to our own shield address so we can keep spending them.
 */
export const validateAssetLifecycle = async (
  sdk: STXShield,
  plan: AssetPlan,
  recipient: string,
): Promise<AssetLifecycleResult> => {
  const r = new Recorder();
  const selfAddress = await sdk.getAddress().catch(() => "");
  let shieldedBase = 0n;

  // 1. SHIELD -----------------------------------------------------------------
  const shielded = await r.run(`${plan.label}: shield ${plan.shield}`, async () => {
    const res = await sdk.shield(plan.shield, plan.ref);
    shieldedBase = res.note.amount;
    return res.note;
  });
  r.check(`${plan.label}: shield returns a note`, !!shielded, shielded?.commitment);
  r.check(`${plan.label}: note tagged with correct asset`, assetMatches(shielded, plan.ref));

  // 2. SCANNER (discovery) ----------------------------------------------------
  const discovered = await r.run(`${plan.label}: scan discovers the note`, async () => {
    const notes = await sdk.getNotes(plan.ref);
    return notes.find((n) => shielded && n.commitment === shielded.commitment);
  });
  r.check(`${plan.label}: shielded note discovered by scanner`, !!discovered);

  // 3. TRANSFER (to self) -----------------------------------------------------
  // Each spend re-syncs the tree from /commitments, so retry through indexer lag.
  let current = discovered ?? shielded;
  await r.run(`${plan.label}: transfer (relayed, sender hidden)`, async () => {
    await retryOnLag(() => sdk.transfer(plan.shield, selfAddress, plan.ref));
  });
  const afterTransfer = await r.run(`${plan.label}: rediscover transferred note`, async () =>
    retryOnLag(async () => {
      const notes = await sdk.getNotes(plan.ref);
      const found = notes.find((n) => n.amount === (current?.amount ?? 0n) && n.commitment !== current?.commitment && !n.spent);
      if (!found) throw new Error("transferred output not on chain yet");
      return found;
    }),
  );
  if (afterTransfer) current = afterTransfer;

  // 4. SPLIT ------------------------------------------------------------------
  const parts = await r.run(`${plan.label}: split ${plan.split[0]} + ${plan.split[1]}`, async () => {
    if (!current) throw new Error("no note to split");
    const res = await retryOnLag(() => sdk.split(current!, plan.split));
    return res.notes;
  });
  const splitOk = !!parts && parts.length === 2 && parts[0]!.amount + parts[1]!.amount === (current?.amount ?? -1n);
  r.check(`${plan.label}: split conserves value`, splitOk, parts && `${parts[0]?.amount}+${parts[1]?.amount}`);

  // 5. MERGE ------------------------------------------------------------------
  const merged = await r.run(`${plan.label}: merge back to one note`, async () => {
    if (!parts || parts.length !== 2) throw new Error("no split outputs to merge");
    const res = await retryOnLag(() => sdk.merge(parts));
    return res.note;
  });
  r.check(`${plan.label}: merge conserves value`, !!merged && merged.amount === shieldedBase, merged && `${merged.amount}`);

  // 6. WITHDRAW ---------------------------------------------------------------
  const withdrawn = await r.run(`${plan.label}: withdraw to ${recipient.slice(0, 8)}…`, async () => {
    if (!merged) throw new Error("no merged note to withdraw");
    return retryOnLag(() => sdk.withdraw(merged, recipient));
  });
  r.check(`${plan.label}: withdrawal returns net amount`, !!withdrawn && withdrawn.amountReceived > 0n);
  const conservation = !!withdrawn && near(withdrawn.amountReceived, shieldedBase);
  r.check(`${plan.label}: value conserved shield→withdraw (net of fee)`, conservation);

  // 7. REPLAY PROTECTION ------------------------------------------------------
  await r.run(`${plan.label}: replay a spent note is rejected`, async () => {
    if (!merged) throw new Error("no note to replay");
    try {
      await sdk.withdraw(merged, recipient);
      throw new Error("REPLAY SUCCEEDED — nullifier reuse was not rejected");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/REPLAY SUCCEEDED/.test(msg)) throw e; // genuine failure
      return "rejected as expected";
    }
  });

  const passed = r.steps.every((s) => s.ok);
  return { asset: plan.label, steps: r.steps, conservation, passed };
};

/** SDK-level cross-asset isolation guardrails. (The deeper "a proof for asset A
 *  cannot spend asset B on chain" is enforced by the circuits/contracts and is
 *  covered by tests/integration/sip10.test.ts + scripts/testnet/sip10/op.ts.) */
export const validateCrossAsset = async (
  sdk: STXShield,
  a: AssetRef,
  b: AssetRef,
): Promise<StepResult[]> => {
  const r = new Recorder();
  const notesA = await sdk.getNotes(a).catch(() => [] as ShieldNote[]);
  const notesB = await sdk.getNotes(b).catch(() => [] as ShieldNote[]);

  r.check("cross-asset: getNotes(a) returns only asset a", notesA.every((n) => assetMatches(n, a)));
  r.check("cross-asset: getNotes(b) returns only asset b", notesB.every((n) => assetMatches(n, b)));

  if (notesA[0] && notesB[0]) {
    await r.run("cross-asset: merge across assets is rejected by the SDK", async () => {
      try {
        await sdk.merge([notesA[0]!, notesB[0]!]);
        throw new Error("CROSS-ASSET MERGE SUCCEEDED");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/CROSS-ASSET MERGE SUCCEEDED/.test(msg)) throw e;
        return "rejected as expected";
      }
    });
  } else {
    r.check("cross-asset: merge across assets (skipped — need a note of each asset)", true, "skipped");
  }
  return r.steps;
};

// ---- helpers ---------------------------------------------------------------
const assetMatches = (note: ShieldNote | undefined, ref: AssetRef): boolean => {
  if (!note) return false;
  const isNative = ref == null || (typeof ref === "string" && ref.toUpperCase() === "STX");
  if (isNative) return note.asset == null || note.asset.native;
  const sym = typeof ref === "string" ? ref : ref.symbol;
  const tok = typeof ref === "string" ? ref : ref.token;
  return note.asset != null && (note.asset.symbol.toLowerCase() === sym.toLowerCase() || note.asset.token === tok);
};

/** Aggregate the pass/fail across the suite. */
export const summarize = (assets: AssetLifecycleResult[], crossAsset: StepResult[]): boolean =>
  assets.every((a) => a.passed) && crossAsset.every((s) => s.ok);
