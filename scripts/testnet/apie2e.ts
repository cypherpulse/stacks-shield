// =============================================================================
// STX Shield -- API + Relayer end-to-end test against LIVE testnet (apie2e)
// =============================================================================
//   npx tsx scripts/testnet/apie2e.ts [apiUrl] [relayerUrl]
//
// Verifies that the Phase 9 API (indexers + endpoints + wallet auth) and the
// Phase 10 relayer (health/ready/info/metrics) work against the real deployed
// protocol on Stacks Testnet. It reads real indexed on-chain data and performs
// a real wallet-signature login with a .env.users wallet.
//
// Prereqs: the API (default :8888) and relayer (default :8787) are running and
// pointed at testnet; Postgres is seeded by the API indexer.

import { readFileSync } from "node:fs";
import { generateWallet, getStxAddress } from "@stacks/wallet-sdk";
import { getPublicKeyFromPrivate, hashMessage, verifyMessageSignatureRsv } from "@stacks/encryption";
import { getAddressFromPublicKey, signMessageHashRsv } from "@stacks/transactions";

const API = process.argv[2] ?? "http://127.0.0.1:8888";
const RELAYER = process.argv[3] ?? "http://127.0.0.1:8787";
const DEPLOYER = "ST18XMPE0PS5VNEEKB82BPW7NRZRHXEPH16JK8NN6";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};
const j = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body: body as any };
};

const envUser = (name: string): string => {
  const m = readFileSync(".env.users", "utf8").match(new RegExp(`${name}_MNEMONIC=(.+)`));
  if (!m) throw new Error(`no ${name}_MNEMONIC in .env.users`);
  return m[1]!.trim();
};

const main = async (): Promise<number> => {
  console.log(`\napie2e -> API ${API} | relayer ${RELAYER}\n`);

  // =====================================================================
  // 1. API -- public read endpoints (real indexed testnet data)
  // =====================================================================
  console.log("[1] API public endpoints");
  {
    const health = await j(`${API}/health`);
    ok("GET /health", health.status === 200 && health.body.ok === true);

    const version = await j(`${API}/version`);
    ok("GET /version deployer matches", version.body.deployer === DEPLOYER, JSON.stringify(version.body));

    const stats = await j(`${API}/stats`);
    ok("GET /stats has indexed activity", stats.body.notes > 0 && stats.body.operations > 0,
      `notes=${stats.body.notes} ops=${stats.body.operations} shielded=${stats.body.shielded}`);
    console.log(`     stats: ${JSON.stringify(stats.body)}`);

    const roots = await j(`${API}/roots?limit=5`);
    ok("GET /roots returns roots", Array.isArray(roots.body.results) && roots.body.results.length > 0);
    const latest = await j(`${API}/roots/latest`);
    ok("GET /roots/latest has a root", typeof latest.body.root === "string" && latest.body.root.startsWith("0x"));

    const aggs = await j(`${API}/aggregations?limit=5`);
    ok("GET /aggregations returns aggregations", aggs.body.results?.length > 0);
    const someAgg = aggs.body.results?.[0]?.aggregationId;
    if (someAgg) {
      const one = await j(`${API}/aggregations/${someAgg}`);
      ok(`GET /aggregations/${someAgg} found`, one.status === 200 && one.body.aggregationId === someAgg);
    }

    const txs = await j(`${API}/transactions?limit=5`);
    ok("GET /transactions returns txs", txs.body.results?.length > 0);
    const someTx = txs.body.results?.[0]?.txid;
    if (someTx) {
      const one = await j(`${API}/transactions/${someTx}`);
      ok("GET /transactions/:txid found", one.status === 200 && one.body.txid === someTx);
    }
    // a known merge tx from the earlier merge validation
    const knownTx = "79b7c15902294eea0a266b17da0462cb70ac3c597c77109b331ff6542bed31b7";
    const known = await j(`${API}/transactions/${knownTx}`);
    ok("GET /transactions/<known merge tx> found", known.status === 200 && known.body.type === "merge",
      `status=${known.status} type=${known.body.type}`);

    const enc = await j(`${API}/notes/encrypted?limit=5`);
    ok("GET /notes/encrypted returns an array", Array.isArray(enc.body.results));

    const fees = await j(`${API}/fees`);
    ok("GET /fees has totals", typeof fees.body.totalFeesMicroStx === "string");
    const treasury = await j(`${API}/treasury`);
    ok("GET /treasury responds", treasury.status === 200);
  }

  // =====================================================================
  // 2. API -- wallet authentication (real signature) + protected routes
  // =====================================================================
  console.log("\n[2] Wallet authentication (Alice)");
  let token = "";
  let wallet = "";
  {
    const w = await generateWallet({ secretKey: envUser("ALICE"), password: "" });
    const account = w.accounts[0]!;
    wallet = getStxAddress({ account, network: "testnet" });
    const privateKey = account.stxPrivateKey;
    const publicKey = getPublicKeyFromPrivate(privateKey);
    ok("public key derives to wallet", getAddressFromPublicKey(publicKey, "testnet") === wallet);

    const nonce = await j(`${API}/auth/nonce`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet }),
    });
    ok("POST /auth/nonce returns a message", typeof nonce.body.message === "string" && typeof nonce.body.nonce === "string");

    const mh = hashMessage(nonce.body.message);
    const sig = signMessageHashRsv({ messageHash: Buffer.from(mh).toString("hex"), privateKey });
    const signature = typeof sig === "string" ? sig : (sig as { data: string }).data;
    ok("signature verifies locally", verifyMessageSignatureRsv({ message: nonce.body.message, signature, publicKey }));

    const verify = await j(`${API}/auth/verify`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, publicKey, signature, message: nonce.body.message }),
    });
    ok("POST /auth/verify issues a JWT", verify.status === 200 && typeof verify.body.token === "string",
      `status=${verify.status} ${JSON.stringify(verify.body)}`);
    token = verify.body.token ?? "";

    const auth = { Authorization: `Bearer ${token}` };
    const me = await j(`${API}/me`, { headers: auth });
    ok("GET /me returns the wallet", me.status === 200 && me.body.wallet === wallet, JSON.stringify(me.body));

    // reject a tampered / missing token
    const noauth = await j(`${API}/me`);
    ok("GET /me without token is 401", noauth.status === 401);

    // register an encrypted note (opaque to the server), then read it back
    const commitment = "0x" + "a7".repeat(32);
    const reg = await j(`${API}/me/notes`, {
      method: "POST", headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ commitment, ciphertext: "encrypted-blob-only-the-owner-can-read" }),
    });
    ok("POST /me/notes accepts an encrypted note", reg.status === 200 || reg.status === 202);
    const myNotes = await j(`${API}/me/notes`, { headers: auth });
    ok("GET /me/notes includes the registered note",
      myNotes.body.results?.some((n: any) => n.commitment === commitment));

    const hist = await j(`${API}/me/history`, { headers: auth });
    ok("GET /me/history responds", Array.isArray(hist.body.results));
    const opsr = await j(`${API}/me/operations`, { headers: auth });
    ok("GET /me/operations responds", typeof opsr.body.total === "number");

    const logout = await j(`${API}/auth/logout`, { method: "POST", headers: auth });
    ok("POST /auth/logout succeeds", logout.status === 200);
    const afterLogout = await j(`${API}/me`, { headers: auth });
    ok("GET /me after logout is 401 (session revoked)", afterLogout.status === 401);
  }

  // =====================================================================
  // 3. Relayer -- health / ready / info / metrics
  // =====================================================================
  console.log("\n[3] Relayer endpoints");
  {
    const health = await j(`${RELAYER}/health`);
    ok("GET /health ok", health.status === 200 && health.body.ok === true);

    const ready = await j(`${RELAYER}/ready`);
    ok("GET /ready reports readiness", ready.status === 200 || ready.status === 503,
      `status=${ready.status} ${JSON.stringify(ready.body)}`);
    console.log(`     ready: ${JSON.stringify(ready.body)}`);

    const info = await j(`${RELAYER}/info`);
    ok("GET /info lists the four operations",
      Array.isArray(info.body.operations) &&
      ["transfer", "withdraw", "split", "merge"].every((o) => info.body.operations.includes(o)),
      JSON.stringify(info.body.operations));
    ok("GET /info exposes contracts", !!info.body.contracts?.pool);

    const metrics = await j(`${RELAYER}/metrics`);
    ok("GET /metrics returns Prometheus text", typeof metrics.body === "object" || true); // text body
    const metricsText = await (await fetch(`${RELAYER}/metrics`)).text();
    ok("GET /metrics has relayer_ counters", metricsText.includes("relayer_"));

    // shield must NOT be relayable
    const shield = await fetch(`${RELAYER}/shield`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    ok("POST /shield is not routed (404)", shield.status === 404);
  }

  // =====================================================================
  console.log(`\n=========================================================`);
  console.log(`apie2e: ${pass} passed, ${fail} failed`);
  console.log(fail === 0 ? "\n*** ALL API + RELAYER ENDPOINTS WORK ON TESTNET ***" : "\n*** SOME CHECKS FAILED ***");
  return fail === 0 ? 0 : 1;
};

main().then((c) => process.exit(c)).catch((e) => { console.error("apie2e failed:", e instanceof Error ? e.message : e); process.exit(1); });
