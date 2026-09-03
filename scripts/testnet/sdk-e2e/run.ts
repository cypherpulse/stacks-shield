// =============================================================================
// STX Shield -- SDK end-to-end validation runner
// =============================================================================
//   npx tsx scripts/testnet/sdk-e2e/run.ts
//
// Drives the REAL stack through @stx-shield/sdk for STX + sBTC + USDCx, plus
// cross-asset isolation, and writes a JSON + markdown validation report. This is
// the reusable suite entrypoint — run it whenever a new protocol version ships.
//
// Config (env, or a .env file the harness reads):
//   E2E_NETWORK            testnet (default) | mainnet
//   E2E_API_URL            public API base    (default: network default)
//   E2E_RELAYER_URL        relayer base URL
//   E2E_ZKVERIFY_ENDPOINT  hosted submitter (usually the relayer) — recommended
//   ZKVERIFY_SEED_PHRASE   OR direct zkVerify submission (dev/server)
//   E2E_MNEMONIC           test wallet (default: ALICE_MNEMONIC from .env.users)
//   E2E_RECIPIENT          withdraw recipient (default: the wallet address)
//   E2E_ASSETS             comma list: stx,sbtc,usdcx (default: all three)
//   E2E_CIRCUITS_DIR       compiled circuits root (default: zk/circuits)
//
// Prereqs (see README.md): the updated API + relayer deployed with SIP-10
// support; the wallet funded with STX + sBTC + USDCx; the STX and SIP-10 circuits
// compiled under E2E_CIRCUITS_DIR.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { STXShield, type AssetRef } from "../../../sdk/src/index.js";
import { createNodeEngine } from "../../../sdk/src/node.js";
import { MnemonicSigner } from "./signer.js";
import { validateAssetLifecycle, validateCrossAsset, summarize, type AssetPlan, type SuiteResult } from "./harness.js";
import { renderMarkdown, renderJson } from "./report.js";

// ---- tiny .env reader (merges a few known files + process.env) --------------
const readEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const file of [".env.testnet", ".env.deploy", ".env.users", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/i);
      if (m && !(m[1]! in env)) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  }
  return { ...env, ...process.env as Record<string, string> };
};

const PLANS: Record<string, AssetPlan> = {
  stx: { ref: "STX", label: "STX", shield: 300, split: [150, 150] },
  // sBTC is 8-decimal with a 1000-sBTC max shield; keep amounts realistic (human sBTC).
  sbtc: { ref: "sBTC", label: "sBTC", shield: 100, split: [40, 60] },
  usdcx: { ref: "USDCx", label: "USDCx", shield: 250_000, split: [100_000, 150_000] },
};

const main = async (): Promise<number> => {
  const env = readEnv();
  const network = (env.E2E_NETWORK ?? "testnet") as "testnet" | "mainnet";
  const mnemonic = env.E2E_MNEMONIC ?? env.ALICE_MNEMONIC;
  if (!mnemonic) throw new Error("set E2E_MNEMONIC (or ALICE_MNEMONIC in .env.users)");
  const relayerUrl = env.E2E_RELAYER_URL;
  const apiUrl = env.E2E_API_URL;
  const circuitsDir = resolve(env.E2E_CIRCUITS_DIR ?? "zk/circuits");
  const hiro = env.E2E_HIRO_URL ?? (network === "testnet" ? "https://api.testnet.hiro.so" : "https://api.hiro.so");

  const zkVerify = env.E2E_ZKVERIFY_ENDPOINT
    ? { endpointUrl: env.E2E_ZKVERIFY_ENDPOINT }
    : env.ZKVERIFY_SEED_PHRASE
      ? { seed: env.ZKVERIFY_SEED_PHRASE }
      : (() => { throw new Error("set E2E_ZKVERIFY_ENDPOINT (hosted submitter) or ZKVERIFY_SEED_PHRASE (direct)"); })();

  const signer = await MnemonicSigner.fromMnemonic(mnemonic, network, hiro);
  const sdk = new STXShield({
    network,
    ...(apiUrl ? { apiUrl } : {}),
    ...(relayerUrl ? { relayerUrls: [relayerUrl] } : {}),
    signer,
    proofEngine: createNodeEngine({ circuitsDir }),
    zkVerify,
  });

  const recipient = env.E2E_RECIPIENT ?? signer.getAddress();
  const selected = (env.E2E_ASSETS ?? "stx,sbtc,usdcx").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  console.log(`SDK e2e validation — ${network}`);
  console.log(`  wallet ${signer.getAddress()}`);
  console.log(`  assets ${selected.join(", ")}  ·  circuits ${circuitsDir}\n`);

  // Discovery sanity: the SDK must load assets from GET /assets before anything.
  const assets = await sdk.getAssets();
  console.log(`  discovered assets: ${assets.map((a) => a.symbol).join(", ")}\n`);

  const startedAt = new Date().toISOString();
  const lifecycles = [];
  for (const key of selected) {
    const plan = PLANS[key];
    if (!plan) { console.warn(`unknown asset "${key}", skipping`); continue; }
    console.log(`=== ${plan.label} lifecycle ===`);
    const res = await validateAssetLifecycle(sdk, plan, recipient);
    for (const s of res.steps) console.log(`   ${s.ok ? "✓" : "✗"} ${s.name}${s.error ? "  — " + s.error : ""}`);
    lifecycles.push(res);
  }

  // Cross-asset isolation (first two selected assets that produced notes).
  const refs = selected.map((k) => PLANS[k]?.ref).filter(Boolean) as AssetRef[];
  const crossAsset = refs.length >= 2 ? await validateCrossAsset(sdk, refs[0]!, refs[1]!) : [];

  const result: SuiteResult = {
    network, startedAt, finishedAt: new Date().toISOString(),
    assets: lifecycles, crossAsset, passed: summarize(lifecycles, crossAsset),
  };

  const outDir = "deployments/testnet";
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/sdk-e2e-report.json`, renderJson(result) + "\n");
  writeFileSync(`${outDir}/SDK-E2E-VALIDATION.md`, renderMarkdown(result));
  console.log(`\n${result.passed ? "*** SDK E2E VALIDATION PASSED ***" : "*** VALIDATION INCOMPLETE — see report ***"}`);
  console.log(`report: deployments/testnet/SDK-E2E-VALIDATION.md`);
  return result.passed ? 0 : 1;
};

main().then((c) => process.exit(c)).catch((e) => { console.error("\nSDK e2e failed:", e instanceof Error ? e.message : e); process.exit(1); });
