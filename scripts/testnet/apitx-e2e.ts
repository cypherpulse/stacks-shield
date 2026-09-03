// =============================================================================
// STX Shield -- REAL RELAYED operations e2e via the relayer HTTP API (testnet)
// =============================================================================
//   npx tsx scripts/testnet/apitx-e2e.ts [seed]
//
// Routes transfer/split/merge/withdraw through the relayer's HTTP endpoints so
// the operation lands on chain from the RELAYER's address -- the user never
// appears. Shields are user-signed (never relayable). Aggregation roots are
// published by the registered relayer (the deployer); the operation itself is
// submitted by the relayer service (a separate funded account).
//
//   Test 1: Alice shields 100 -> transfers to Bob -> Bob splits 100 -> 40/35/25
//           -> withdraws each to 3 fresh addresses.
//   Test 2: Alice shields 100 -> transfers to Bob -> Bob splits 50/50
//           -> sends 50 to Carol -> Carol splits + withdraws to 2 fresh addrs
//           -> a spent note CANNOT be reused (double-spend rejected)
//           -> Bob splits the other 50, merges, withdraws to a fresh addr.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  Cl, broadcastTransaction, makeContractCall, PostConditionMode, hexToCV, cvToJSON,
} from "@stacks/transactions";
import { generateSecretKey, generateWallet, getStxAddress } from "@stacks/wallet-sdk";
import { poseidon2, poseidon4 } from "poseidon-lite";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { CommitmentTree } from "../../sdk/merkle-tree/index.js";
import { fePrincipal } from "../../sdk/public-inputs/index.js";

const API = "https://api.testnet.hiro.so";
const RELAYER = process.env["RELAYER_URL"] ?? "http://127.0.0.1:8787";
const PATHENV = "export PATH=$HOME/.nargo/bin:$HOME/.bb:$PATH";
const REPO = "/mnt/g/2026/Blockchain/Stacks/stx-shield";
const ONE = 1_000_000n;
const DEPLOYER = "ST18XMPE0PS5VNEEKB82BPW7NRZRHXEPH16JK8NN6";

const hexOf = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");
const toBuf = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const big = (b: Uint8Array) => BigInt("0x" + Buffer.from(b).toString("hex"));
const hx = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const norm = (h: string) => (h.startsWith("0x") ? h : "0x" + h);
const concat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const wsl = (cmd: string) => execFileSync("wsl", ["-e", "bash", "-lc", `${PATHENV}; ${cmd}`], { encoding: "utf8", maxBuffer: 64 << 20 });
const arr = (xs: string[]) => "[" + xs.map((x) => `"${x}"`).join(", ") + "]";

// Survive transient network/TLS blips on background sockets during a long run.
process.on("unhandledRejection", (r) => console.error("[warn] unhandledRejection (continuing):", r instanceof Error ? r.message : r));
process.on("uncaughtException", (e) => console.error("[warn] uncaughtException (continuing):", e instanceof Error ? e.message : e));

/** fetch with retry/backoff on network errors (not HTTP status). */
const fetchR = async (url: string, init?: RequestInit, tries = 6): Promise<Response> => {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
};

type Circuit = "shield" | "transfer" | "withdraw" | "split" | "merge";
const PKG: Record<Circuit, string> = { shield: "shield_note", transfer: "transfer_note", withdraw: "withdraw_note", split: "split_note", merge: "merge_note" };
const ZKV_VK: Record<Circuit, string> = {
  shield: "0x96889d2466624e271b44d4e32ac8b557bdfdc922a1a16dc42f5c807f2dcacad8",
  transfer: "0x3668b8b291ddf8cb0bc60bf9f3f33ce9e5af9d2de631ebd3bfb10a4455e91595",
  withdraw: "0x5e1ad470b0b8b0094acd87360989f31c1059ba73e6613522d0b07d55e6b749de",
  split: "0x7a3fbca8876dbbd32c5977c886cc843b41b18201330a80378719b12383ec2b01",
  merge: "0x025d92c5d1f17b50433ab138f5f603eb64cb94b48299b5f23b9b8fcda76735de",
};
const CTX = keccak_256(new TextEncoder().encode("ultrahonk"));
const VERSION = toBuf("0x55b52ad2b4153c872e27d688f567c1406f0d93b5528dd2b0bf2a9a40df97f1f9");

const grumpkinPk = (sk: bigint): { x: bigint; y: bigint } => {
  writeFileSync("zk/circuits/keygen/Prover.toml", `owner_sk = "${sk}"\n`);
  const o = wsl(`cd ${REPO}/zk/circuits/keygen && nargo execute 2>&1 | grep "Circuit output"`);
  const m = o.match(/\[(0x[0-9a-f]+), (0x[0-9a-f]+)\]/i)!;
  return { x: BigInt(m[1]!), y: BigInt(m[2]!) };
};

interface N { amount: bigint; sk: bigint; pkX: bigint; pkY: bigint; blinding: bigint; leaf?: number; }
const commitmentOf = (n: N) => BigInt(poseidon4([n.amount, n.pkX, n.pkY, n.blinding]));
const ownerCommitmentOf = (n: N) => BigInt(poseidon2([n.pkX, n.pkY]));
const nullifierOf = (n: N) => BigInt(poseidon2([commitmentOf(n), n.sk]));
const noteToml = (label: string, n: N) => [`[${label}]`, `amount = "${n.amount}"`, `owner_pk_x = "${n.pkX}"`, `owner_pk_y = "${n.pkY}"`, `blinding = "${n.blinding}"`].join("\n");

const prove = (c: Circuit, prover: string): void => {
  writeFileSync(`zk/circuits/${c}/Prover.toml`, prover + "\n");
  wsl(`cd ${REPO}/zk/circuits/${c} && nargo execute witness && bb prove -b target/${PKG[c]}.json -w target/witness.gz -k target/vk/vk -o target/proofout -t evm`);
  const v = wsl(`cd ${REPO}/zk/circuits/${c} && bb verify -k target/vk/vk -p target/proofout/proof -i target/proofout/public_inputs -t evm 2>&1 | tail -1`);
  if (!/verified successfully/i.test(v)) throw new Error(`${c} proof failed local verify: ${v.trim()}`);
};

interface Inc { domainId: number; aggregationId: number; root: string; leaves: number; path: string[]; leafIndex: number; }
const aggregate = async (session: any, zk: any, c: Circuit): Promise<Inc> => {
  const pub = readFileSync(`zk/circuits/${c}/target/proofout/public_inputs`);
  const proof = hx(readFileSync(`zk/circuits/${c}/target/proofout/proof`));
  const vk = hx(readFileSync(`zk/circuits/${c}/target/vk/vk`));
  const signals: string[] = [];
  for (let i = 0; i < pub.length; i += 32) signals.push(hx(pub.subarray(i, i + 32)));
  const { transactionResult } = await session.verify().ultrahonk({ version: zk.UltrahonkVersion.V3_0, variant: zk.UltrahonkVariant.ZK }).execute({ proofData: { proof, publicSignals: signals, vk }, domainId: 0 });
  const sub = await transactionResult;
  const leaf = hx(keccak_256(concat(CTX, toBuf(ZKV_VK[c]), VERSION, keccak_256(pub))));
  if (leaf !== sub.statement) throw new Error(`${c} statement mismatch`);
  console.log(`      zkVerify verified ${c} (agg ${sub.aggregationId})`);
  const receipt = await session.waitForAggregationReceipt(0, sub.aggregationId, 480_000);
  const path = await session.getAggregateStatementPath(receipt.blockHash, 0, sub.aggregationId, sub.statement);
  return { domainId: 0, aggregationId: sub.aggregationId, root: path.root, leaves: path.numberOfLeaves, path: path.proof, leafIndex: path.leafIndex };
};
const incBody = (i: Inc) => ({ domainId: i.domainId, aggregationId: i.aggregationId, merklePath: i.path.map(norm), leafIndex: i.leafIndex });
const incArgs = (i: Inc) => [Cl.uint(i.domainId), Cl.uint(i.aggregationId), Cl.list(i.path.map((p) => Cl.buffer(toBuf(p)))), Cl.uint(i.leafIndex)];

// ---- signers / chain ----
const signer = async (m: string) => { const w = await generateWallet({ secretKey: m, password: "" }); const a = w.accounts[0]!; return { key: a.stxPrivateKey, address: getStxAddress({ account: a, network: "testnet" }) }; };
const envUser = (name: string) => readFileSync(".env.users", "utf8").match(new RegExp(`${name}_MNEMONIC=(.+)`))![1]!.trim();
const nextNonce = async (a: string) => BigInt(((await (await fetchR(`${API}/extended/v1/address/${a}/nonces`)).json()) as any).possible_next_nonce);
const stacks = async (from: any, contract: string, fn: string, args: any[]): Promise<string> => {
  const tx = await makeContractCall({ contractAddress: DEPLOYER, contractName: contract, functionName: fn, functionArgs: args, senderKey: from.key, network: "testnet", postConditionMode: PostConditionMode.Allow, fee: 30_000, nonce: await nextNonce(from.address) });
  const r = await broadcastTransaction({ transaction: tx, network: "testnet" });
  const txid = (r as any).txid;
  if (!txid) throw new Error(`${fn} broadcast failed: ${JSON.stringify(r)}`);
  const dl = Date.now() + 1_200_000;
  while (Date.now() < dl) {
    const res = await fetchR(`${API}/extended/v1/tx/${txid}`);
    if (res.ok) { const b = (await res.json()) as any; if (b.tx_status === "success") return txid; if (b.tx_status.startsWith("abort")) throw new Error(`${fn} aborted: ${b.tx_result?.repr} (${txid})`); }
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error(`${fn} not confirmed (${txid})`);
};
const currentRoot = async (): Promise<string> => {
  const res = await fetchR(`${API}/v2/contracts/call-read/${DEPLOYER}/privacy-registry/get-current-root`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: DEPLOYER, arguments: [] }) });
  return (cvToJSON(hexToCV(((await res.json()) as any).result)) as any).value.root.value as string;
};
const readUint = async (contract: string, fn: string): Promise<bigint> => {
  const res = await fetchR(`${API}/v2/contracts/call-read/${DEPLOYER}/${contract}/${fn}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: DEPLOYER, arguments: [] }) });
  return BigInt((cvToJSON(hexToCV(((await res.json()) as any).result)) as any).value);
};
const stxBalance = async (a: string): Promise<bigint> => { const r = await fetchR(`${API}/extended/v1/address/${a}/balances`); return r.ok ? BigInt(((await r.json()) as any).stx.balance) : 0n; };

// ---- relayer HTTP ----
const relayPost = async (op: string, body: any): Promise<string> => {
  const res = await fetchR(`${RELAYER}/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const acc = (await res.json()) as any;
  if (res.status !== 202) throw new Error(`relayer rejected ${op}: ${res.status} ${acc.error ?? ""} ${acc.message ?? ""}`);
  const dl = Date.now() + 1_500_000;
  while (Date.now() < dl) {
    const s = (await (await fetchR(`${RELAYER}/status/${acc.jobId}`)).json()) as any;
    if (s.state === "confirmed") return s.txid;
    if (s.state === "failed") throw new Error(`relayed ${op} failed: ${s.error} (tx ${s.txid ?? "-"})`);
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error(`relayed ${op} timed out`);
};
const relayReject = async (op: string, body: any): Promise<{ status: number; code: string }> => {
  const res = await fetchR(`${RELAYER}/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const b = (await res.json()) as any;
  return { status: res.status, code: b.error ?? "" };
};

const main = async (): Promise<number> => {
  const seed = BigInt(process.argv[2] ?? Date.now().toString());
  const deployer = await signer(readFileSync(".env.deploy", "utf8").match(/NEW_DEPLOYER_MNEMONIC=(.+)/)![1]!.trim());
  const alice = await signer(envUser("ALICE"));
  const bob = await signer(envUser("BOB"));
  const carol = await signer(envUser("CAROL"));
  console.log(`relayer ${RELAYER} | roots published by deployer ${deployer.address}`);

  console.log("[keys] deriving Grumpkin keys for Alice/Bob/Carol...");
  const aSk = (seed % 2n ** 240n) + 1n, bSk = ((seed * 3n + 7n) % 2n ** 240n) + 1n, cSk = ((seed * 5n + 11n) % 2n ** 240n) + 1n;
  const aPk = grumpkinPk(aSk), bPk = grumpkinPk(bSk), cPk = grumpkinPk(cSk);
  let blc = 0;
  const bl = () => (seed * 1000003n + BigInt(++blc) * 7919n + 101n) % 2n ** 240n;
  const note = (amount: bigint, who: { sk: bigint; pk: { x: bigint; y: bigint } }): N => ({ amount, sk: who.sk, pkX: who.pk.x, pkY: who.pk.y, blinding: bl() });
  const A = { sk: aSk, pk: aPk }, B = { sk: bSk, pk: bPk }, C = { sk: cSk, pk: cPk };
  let mtag = 0;
  const meta = () => hexOf(BigInt(3000 + ++mtag));

  const tree = new CommitmentTree();
  let onChainRoot = await currentRoot();
  const insert = (c: bigint) => tree.insert(toBuf(hexOf(c)));
  const rootHex = () => hx(tree.root);
  const R: any = { seed: seed.toString(), test1: {}, test2: {}, relayer: {} };

  const zk = await import("zkverifyjs");
  const session = await zk.zkVerifySession.start().Volta().withAccount(readFileSync(".env.testnet", "utf8").match(/ZKVERIFY_SEED_PHRASE=(.+)/)![1]!.trim());
  const publishRoot = async (inc: Inc) => stacks(deployer, "zk-verifier", "submit-aggregation", [Cl.uint(inc.domainId), Cl.uint(inc.aggregationId), Cl.buffer(toBuf(inc.root)), Cl.uint(inc.leaves)]);

  // ---- operation primitives ----
  const shieldDirect = async (user: any, n: N, label: string): Promise<string> => {
    const c = commitmentOf(n), oc = ownerCommitmentOf(n);
    n.leaf = insert(c);
    console.log(`[shield] ${Number(n.amount) / 1e6} STX (${label}, user-signed)...`);
    prove("shield", [`op = "1"`, `commitment = "${hexOf(c)}"`, `owner_commitment = "${hexOf(oc)}"`, `amount = "${n.amount}"`, `circuit_version = "1"`, ``, noteToml("note", n)].join("\n"));
    const inc = await aggregate(session, zk, "shield");
    await publishRoot(inc);
    const nr = rootHex();
    const tx = await stacks(user, "privacy-pool", "shield", [Cl.uint(n.amount), Cl.buffer(toBuf(hexOf(c))), Cl.buffer(toBuf(hexOf(oc))), Cl.buffer(toBuf(meta())), Cl.buffer(toBuf(onChainRoot)), Cl.buffer(toBuf(nr)), ...incArgs(inc)]);
    onChainRoot = nr;
    console.log(`     shield tx ${tx}`);
    return tx;
  };
  const relayTransfer = async (input: N, out: N, label: string): Promise<string> => {
    const nf = nullifierOf(input), c = commitmentOf(out), oc = ownerCommitmentOf(out);
    const p = tree.proof(input.leaf!);
    console.log(`[transfer] ${Number(input.amount) / 1e6} STX (${label}) via relayer...`);
    prove("transfer", [`op = "2"`, `nullifier = "${hexOf(nf)}"`, `new_commitment = "${hexOf(c)}"`, `new_owner_commitment = "${hexOf(oc)}"`, `merkle_root = "${hexOf(big(tree.root))}"`, `circuit_version = "1"`, `owner_sk = "${input.sk}"`, `merkle_index = ${arr(p.indexBits.map((b) => (b ? "1" : "0")))}`, `merkle_siblings = ${arr(p.siblings.map((s) => hexOf(big(s))))}`, ``, noteToml("input", input), ``, noteToml("output", out)].join("\n"));
    const inc = await aggregate(session, zk, "transfer");
    await publishRoot(inc);
    out.leaf = insert(c); const nr = rootHex();
    const tx = await relayPost("transfer", { nullifier: hexOf(nf), newCommitment: hexOf(c), newOwnerCommitment: hexOf(oc), newMetadata: meta(), currentRoot: onChainRoot, newRoot: nr, inclusion: incBody(inc) });
    onChainRoot = nr;
    console.log(`     relayed transfer tx ${tx}`);
    return tx;
  };
  const relaySplit = async (input: N, o1: N, o2: N, label: string): Promise<string> => {
    const nf = nullifierOf(input), c1 = commitmentOf(o1), oc1 = ownerCommitmentOf(o1), c2 = commitmentOf(o2), oc2 = ownerCommitmentOf(o2);
    const p = tree.proof(input.leaf!);
    console.log(`[split] ${Number(input.amount) / 1e6} -> ${Number(o1.amount) / 1e6} + ${Number(o2.amount) / 1e6} (${label}) via relayer...`);
    prove("split", [`op = "4"`, `nullifier = "${hexOf(nf)}"`, `commitment_1 = "${hexOf(c1)}"`, `owner_commitment_1 = "${hexOf(oc1)}"`, `commitment_2 = "${hexOf(c2)}"`, `owner_commitment_2 = "${hexOf(oc2)}"`, `merkle_root = "${hexOf(big(tree.root))}"`, `circuit_version = "1"`, `owner_sk = "${input.sk}"`, `merkle_index = ${arr(p.indexBits.map((b) => (b ? "1" : "0")))}`, `merkle_siblings = ${arr(p.siblings.map((s) => hexOf(big(s))))}`, ``, noteToml("input", input), ``, noteToml("out_1", o1), ``, noteToml("out_2", o2)].join("\n"));
    const inc = await aggregate(session, zk, "split");
    await publishRoot(inc);
    o1.leaf = insert(c1); o2.leaf = insert(c2); const nr = rootHex();
    const tx = await relayPost("split", { nullifier: hexOf(nf), commitment1: hexOf(c1), ownerCommitment1: hexOf(oc1), metadata1: meta(), commitment2: hexOf(c2), ownerCommitment2: hexOf(oc2), metadata2: meta(), currentRoot: onChainRoot, newRoot: nr, inclusion: incBody(inc) });
    onChainRoot = nr;
    console.log(`     relayed split tx ${tx}`);
    return tx;
  };
  const relayMerge = async (i1: N, i2: N, out: N, label: string): Promise<string> => {
    const nf1 = nullifierOf(i1), nf2 = nullifierOf(i2), c = commitmentOf(out), oc = ownerCommitmentOf(out);
    const p1 = tree.proof(i1.leaf!), p2 = tree.proof(i2.leaf!);
    console.log(`[merge] ${Number(i1.amount) / 1e6} + ${Number(i2.amount) / 1e6} -> ${Number(out.amount) / 1e6} (${label}) via relayer...`);
    prove("merge", [`op = "5"`, `nullifier_1 = "${hexOf(nf1)}"`, `nullifier_2 = "${hexOf(nf2)}"`, `commitment = "${hexOf(c)}"`, `owner_commitment = "${hexOf(oc)}"`, `merkle_root = "${hexOf(big(tree.root))}"`, `circuit_version = "1"`, `owner_sk_1 = "${i1.sk}"`, `merkle_index_1 = ${arr(p1.indexBits.map((b) => (b ? "1" : "0")))}`, `merkle_siblings_1 = ${arr(p1.siblings.map((s) => hexOf(big(s))))}`, `owner_sk_2 = "${i2.sk}"`, `merkle_index_2 = ${arr(p2.indexBits.map((b) => (b ? "1" : "0")))}`, `merkle_siblings_2 = ${arr(p2.siblings.map((s) => hexOf(big(s))))}`, ``, noteToml("input_1", i1), ``, noteToml("input_2", i2), ``, noteToml("output", out)].join("\n"));
    const inc = await aggregate(session, zk, "merge");
    await publishRoot(inc);
    out.leaf = insert(c); const nr = rootHex();
    const tx = await relayPost("merge", { nullifier1: hexOf(nf1), nullifier2: hexOf(nf2), commitment: hexOf(c), ownerCommitment: hexOf(oc), metadata: meta(), currentRoot: onChainRoot, newRoot: nr, inclusion: incBody(inc) });
    onChainRoot = nr;
    console.log(`     relayed merge tx ${tx}`);
    return tx;
  };
  const freshAddr = async () => { const w = await generateWallet({ secretKey: generateSecretKey(256), password: "" }); return getStxAddress({ account: w.accounts[0]!, network: "testnet" }); };
  const relayWithdraw = async (n: N, label: string): Promise<{ recipient: string; received: bigint; tx: string; nf: bigint; inc: Inc; root: string }> => {
    const recipient = await freshAddr();
    const nf = nullifierOf(n);
    const p = tree.proof(n.leaf!);
    const root = onChainRoot;
    console.log(`[withdraw] ${Number(n.amount) / 1e6} STX (${label}) -> ${recipient} via relayer...`);
    prove("withdraw", [`op = "3"`, `nullifier = "${hexOf(nf)}"`, `amount = "${n.amount}"`, `recipient_hash = "${hexOf(big(fePrincipal(recipient)))}"`, `merkle_root = "${hexOf(big(toBuf(root)))}"`, `circuit_version = "1"`, `owner_sk = "${n.sk}"`, `merkle_index = ${arr(p.indexBits.map((b) => (b ? "1" : "0")))}`, `merkle_siblings = ${arr(p.siblings.map((s) => hexOf(big(s))))}`, ``, noteToml("input", n)].join("\n"));
    const inc = await aggregate(session, zk, "withdraw");
    await publishRoot(inc);
    const tx = await relayPost("withdraw", { nullifier: hexOf(nf), amount: n.amount.toString(), recipient, root, inclusion: incBody(inc) });
    const received = await stxBalance(recipient);
    console.log(`     relayed withdraw tx ${tx} | received ${Number(received) / 1e6} STX`);
    return { recipient, received, tx, nf, inc, root };
  };

  try {
    const poolStart = await readUint("privacy-pool", "get-pool-balance");

    // =================================================================
    // TEST 1
    // =================================================================
    console.log("\n================= TEST 1 =================");
    const n0 = note(100n * ONE, A);
    R.test1.shield = await shieldDirect(alice, n0, "Alice 100");
    const n1 = note(100n * ONE, B);
    R.test1.transfer = await relayTransfer(n0, n1, "Alice->Bob");
    const t1a = note(40n * ONE, B), t1b = note(60n * ONE, B);
    R.test1.split1 = await relaySplit(n1, t1a, t1b, "100->40+60");
    const t1c = note(35n * ONE, B), t1d = note(25n * ONE, B);
    R.test1.split2 = await relaySplit(t1b, t1c, t1d, "60->35+25");
    const w1 = await relayWithdraw(t1a, "40 STX -> addr1");
    const w2 = await relayWithdraw(t1c, "35 STX -> addr2");
    const w3 = await relayWithdraw(t1d, "25 STX -> addr3");
    R.test1.withdrawals = [w1, w2, w3].map((w) => ({ recipient: w.recipient, received: Number(w.received) / 1e6, tx: w.tx }));
    R.test1.conservation = t1a.amount + t1c.amount + t1d.amount === n1.amount;
    console.log(`TEST 1 conservation 100 == 40+35+25: ${R.test1.conservation}`);

    // =================================================================
    // TEST 2
    // =================================================================
    console.log("\n================= TEST 2 =================");
    const m0 = note(100n * ONE, A);
    R.test2.shield = await shieldDirect(alice, m0, "Alice 100");
    const m1 = note(100n * ONE, B);
    R.test2.transfer = await relayTransfer(m0, m1, "Alice->Bob");
    const e = note(50n * ONE, B), f = note(50n * ONE, B);
    R.test2.split1 = await relaySplit(m1, e, f, "100->50+50");
    const g = note(50n * ONE, C);
    R.test2.toCarol = await relayTransfer(f, g, "Bob->Carol 50");
    const h = note(25n * ONE, C), i = note(25n * ONE, C);
    R.test2.carolSplit = await relaySplit(g, h, i, "Carol 50->25+25");
    const w4 = await relayWithdraw(h, "Carol 25 -> addr4");
    const w5 = await relayWithdraw(i, "Carol 25 -> addr5");
    R.test2.carolWithdrawals = [w4, w5].map((w) => ({ recipient: w.recipient, received: Number(w.received) / 1e6, tx: w.tx }));

    // DOUBLE SPEND: re-withdraw h (nullifier already spent) -> relayer rejects
    console.log("[double-spend] re-withdraw an already-spent note (must be rejected)...");
    const dsRecipient = await freshAddr();
    const ds = await relayReject("withdraw", { nullifier: hexOf(w4.nf), amount: h.amount.toString(), recipient: dsRecipient, root: w4.root, inclusion: incBody(w4.inc) });
    R.test2.doubleSpendRejected = ds.status === 409 && ds.code === "nullifier_spent";
    console.log(`     double-spend rejected: ${R.test2.doubleSpendRejected} (status ${ds.status} ${ds.code})`);

    // Bob splits the other 50, merges, withdraws
    const j = note(25n * ONE, B), k = note(25n * ONE, B);
    R.test2.bobSplit = await relaySplit(e, j, k, "Bob 50->25+25");
    const l = note(50n * ONE, B);
    R.test2.bobMerge = await relayMerge(j, k, l, "Bob 25+25->50");
    const w6 = await relayWithdraw(l, "Bob 50 -> addr6");
    R.test2.bobWithdraw = { recipient: w6.recipient, received: Number(w6.received) / 1e6, tx: w6.tx };

    await session.close();

    // =================================================================
    R.poolStart = Number(poolStart) / 1e6;
    R.poolEnd = Number(await readUint("privacy-pool", "get-pool-balance")) / 1e6;
    R.finishedAt = new Date().toISOString();
    writeFileSync("deployments/testnet/apitx-results.json", JSON.stringify(R, null, 2) + "\n");

    const allWd = [...R.test1.withdrawals, ...R.test2.carolWithdrawals, R.test2.bobWithdraw];
    const wdOk = allWd.every((w: any) => w.received > 0);
    console.log("\n=========================================================");
    console.log("RELAYED E2E COMPLETE (all ops submitted by the relayer, users hidden)");
    console.log(`  pool balance: ${R.poolStart} -> ${R.poolEnd} STX`);
    console.log(`  test1 conservation 100==40+35+25: ${R.test1.conservation}`);
    console.log(`  all ${allWd.length} withdrawals funded fresh addresses: ${wdOk}`);
    console.log(`  double-spend rejected: ${R.test2.doubleSpendRejected}`);
    const pass = R.test1.conservation && wdOk && R.test2.doubleSpendRejected;
    console.log(pass ? "\n*** ALL RELAYED TESTS PASSED ***" : "\n*** SOME CHECKS FAILED ***");
    return pass ? 0 : 1;
  } catch (e) {
    await session.close().catch(() => {});
    R.error = e instanceof Error ? e.message : String(e);
    writeFileSync("deployments/testnet/apitx-results.json", JSON.stringify(R, null, 2) + "\n");
    throw e;
  }
};

main().then((c) => process.exit(c)).catch((e) => { console.error("\napitx-e2e failed:", e instanceof Error ? e.message : e); process.exit(1); });
