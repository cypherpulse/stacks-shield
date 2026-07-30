// Drive the browser smoke test: start Vite, load the page in headless Edge,
// wait for the in-browser proof result.
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { resolve } from "node:path";

const run = async () => {
  const vite = await createServer({ configFile: resolve(import.meta.dirname, "vite.config.ts") });
  await vite.listen();
  const url = vite.resolvedUrls?.local?.[0];
  if (!url) throw new Error("vite did not report a local url");
  console.log("vite serving at", url);

  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--enable-features=SharedArrayBuffer"] });
  const page = await browser.newPage();
  page.on("console", (m) => console.log("  [browser]", m.text()));
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  page.on("requestfailed", (r) => console.log("  [reqfailed]", r.url(), r.failure()?.errorText ?? ""));
  page.on("response", (r) => { if (r.status() >= 400) console.log("  [http " + r.status() + "]", r.url()); });

  let result: unknown;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const handle = await page.waitForFunction(() => (window as unknown as { __result?: unknown }).__result, null, { timeout: 480_000 });
    result = await handle.jsonValue();
  } finally {
    await browser.close();
    await vite.close();
  }

  console.log("\n=== BROWSER RESULT ===");
  console.log(JSON.stringify(result, null, 2));
  const ok = (result as { ok?: boolean })?.ok === true;
  console.log(ok ? "\n*** bb.js PROVES IN THE BROWSER ***" : "\n*** browser proving FAILED ***");
  process.exit(ok ? 0 : 1);
};

run().catch((e) => { console.error("harness error:", e instanceof Error ? e.message : e); process.exit(1); });
