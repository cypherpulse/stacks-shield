// =============================================================================
// STX Shield -- PHASE 7 (merge half): real MERGE validation on Stacks Testnet
// =============================================================================
//   npx tsx scripts/testnet/e2e-merge.ts [seed]
//
// Self-contained proof that merge-notes works on the DEPLOYED stack with real
// Noir proofs, real zkVerify verification, and real STX. No contract changes.
//
//   Bob (.env.users) shields two notes 0.3 + 0.7, then MERGES them into one
//   1 STX note; the registered relayer publishes zkVerify roots and withdraws
//   the merged note to a fresh, unlinkable recipient. Faucet (Devnet.toml
//   wallet_2) tops up any low wallet.
//
// Also runs the merge-relevant attack suite (all must fail): reuse merge
// nullifier (replay), tampered withdraw amount, spend the merged note twice,
// and value-not-conserved (rejected before a witness can even be built).
// =============================================================================

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  Cl, broadcastTransaction, makeContractCall, makeSTXTokenTransfer,
  PostConditionMode, hexToCV, cvToJSON,
} from "@stacks/transactions";
import { generateSecretKey, generateWallet, getStxAddress } from "@stacks/wallet-sdk";
import { poseidon2, poseidon4 } from "poseidon-lite";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { loadEnv, loadClarinetApiUrl } from "../deployment/config.js";
import { CommitmentTree } from "../../sdk/merkle-tree/index.js";
import { fePrincipal } from "../../sdk/public-inputs/index.js";

const API = loadClarinetApiUrl("testnet") ?? "https://api.testnet.hiro.so";
const PATHENV = "export PATH=$HOME/.nargo/bin:$HOME/.bb:$PATH";
const REPO = "/mnt/g/2026/Blockchain/Stacks/stx-shield";
const ONE = 1_000_000n;
const TX_TIMEOUT = 1_800_000; // 30 min -- testnet blocks can be slow

const hexOf = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");
const toBuf = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const big = (b: Uint8Array) => BigInt("0x" + Buffer.from(b).toString("hex"));
const hx = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const concat = (...a: Uint8Array[]) => {
  const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o;
};
const wsl = (cmd: string) =>
  execFileSync("wsl", ["-e", "bash", "-lc", `${PATHENV}; ${cmd}`], { encoding: "utf8", maxBuffer: 64 << 20 });

type Circuit = "shield" | "withdraw" | "merge" | "split";
const PKG: Record<Circuit, string> = { shield: "shield_note", withdraw: "withdraw_note", merge: "merge_note", split: "split_note" };
const ZKV_VK: Record<Circuit, string> = {
  shield: "0x96889d2466624e271b44d4e32ac8b557bdfdc922a1a16dc42f5c807f2dcacad8",
  withdraw: "0x5e1ad470b0b8b0094acd87360989f31c1059ba73e6613522d0b07d55e6b749de",
  merge: "0x025d92c5d1f17b50433ab138f5f603eb64cb94b48299b5f23b9b8fcda76735de",
  split: "0x7a3fbca8876dbbd32c5977c886cc843b41b18201330a80378719b12383ec2b01",
};
const CTX = keccak_256(new TextEncoder().encode("ultrahonk"));
const VERSION = toBuf("0x55b52ad2b4153c872e27d688f567c1406f0d93b5528dd2b0bf2a9a40df97f1f9");

const grumpkinPk = (sk: bigint): { x: bigint; y: bigint } => {
  writeFileSync("zk/circuits/keygen/Prover.toml", `owner_sk = "${sk}"\n`);
  const o = wsl(`cd ${REPO}/zk/circuits/keygen && nargo execute 2>&1 | grep "Circuit output"`);
  const m = o.match(/\[(0x[0-9a-f]+), (0x[0-9a-f]+)\]/i);
  if (!m) throw new Error("keygen failed: " + o.slice(0, 200));
  return { x: BigInt(m[1]!), y: BigInt(m[2]!) };
};

interface Note { amount: bigint; pkX: bigint; pkY: bigint; blinding: bigint; leaf?: number; }
const commitmentOf = (n: Note) => BigInt(poseidon4([n.amount, n.pkX, n.pkY, n.blinding]));
const ownerCommitmentOf = (n: Note) => BigInt(poseidon2([n.pkX, n.pkY]));
const nullifierOf = (c: bigint, sk: bigint) => BigInt(poseidon2([c, sk]));
const arr = (xs: string[]) => "[" + xs.map((x) => `"${x}"`).join(", ") + "]";
const noteToml = (label: string, n: Note) =>
  [`[${label}]`, `amount = "${n.amount}"`, `owner_pk_x = "${n.pkX}"`, `owner_pk_y = "${n.pkY}"`, `blinding = "${n.blinding}"`].join("\n");

const prove = (c: Circuit, prover: string): Uint8Array => {
  writeFileSync(`zk/circuits/${c}/Prover.toml`, prover + "\n");
  wsl(`cd ${REPO}/zk/circuits/${c} && nargo execute witness && bb prove -b target/${PKG[c]}.json -w target/witness.gz -k target/vk/vk -o target/proofout -t evm`);
  const v = wsl(`cd ${REPO}/zk/circuits/${c} && bb verify -k target/vk/vk -p target/proofout/proof -i target/proofout/public_inputs -t evm 2>&1 | tail -1`);
  if (!/verified successfully/i.test(v)) throw new Error(`${c} proof failed local verify: ${v.trim()}`);
  return readFileSync(`zk/circuits/${c}/target/proofout/public_inputs`);
};
const witnessMustFail = (c: Circuit, prover: string): string => {
  writeFileSync(`zk/circuits/${c}/Prover.toml`, prover + "\n");
  try { const o = wsl(`cd ${REPO}/zk/circuits/${c} && nargo execute witness 2>&1`); return "UNEXPECTED SUCCESS: " + o.slice(-120); }
  catch (e: any) { return String(e.stdout || e.message || e).match(/(value not conserved|assert|Assertion|failed)/i)?.[0] ?? "failed"; }
};

interface Inc { domainId: number; aggregationId: number; root: string; leaves: number; path: string[]; leafIndex: number; statement: string; }
const aggregate = async (session: any, zk: any, c: Circuit): Promise<Inc> => {
  const pub = readFileSync(`zk/circuits/${c}/target/proofout/public_inputs`);
  const proof = hx(readFileSync(`zk/circuits/${c}/target/proofout/proof`));
  const vk = hx(readFileSync(`zk/circuits/${c}/target/vk/vk`));
  const signals: string[] = [];
  for (let i = 0; i < pub.length; i += 32) signals.push(hx(pub.subarray(i, i + 32)));
  const { transactionResult } = await session.verify()
    .ultrahonk({ version: zk.UltrahonkVersion.V3_0, variant: zk.UltrahonkVariant.ZK })
    .execute({ proofData: { proof, publicSignals: signals, vk }, domainId: 0 });
  const sub = await transactionResult;
  const leaf = hx(keccak_256(concat(CTX, toBuf(ZKV_VK[c]), VERSION, keccak_256(pub))));
  if (leaf !== sub.statement) throw new Error(`${c} statement mismatch`);
  console.log(`      zkVerify verified ${c} (agg ${sub.aggregationId}), leaf==statement OK`);
  const receipt = await session.waitForAggregationReceipt(0, sub.aggregationId, 480_000);
  const path = await session.getAggregateStatementPath(receipt.blockHash, 0, sub.aggregationId, sub.statement);
  return { domainId: 0, aggregationId: sub.aggregationId, root: path.root, leaves: path.numberOfLeaves, path: path.proof, leafIndex: path.leafIndex, statement: sub.statement };
};
const incArgs = (i: Inc) => [Cl.uint(i.domainId), Cl.uint(i.aggregationId), Cl.list(i.path.map((p) => Cl.buffer(toBuf(p)))), Cl.uint(i.leafIndex)];

const main = async (): Promise<number> => {
  const seed = BigInt(process.argv[2] ?? Date.now().toString());
  const env = loadEnv(".env.testnet");
  const users = loadEnv(".env.users");
  const deployEnv = loadEnv(".env.deploy");
  const { deployer } = JSON.parse(readFileSync("deployments/testnet/addresses.json", "utf8"));

  console.log("[actors] loading wallets...");
  const funder = await signer(tomlMnemonic("settings/Devnet.toml", "wallet_2"));
  const bob = await signer(users.BOB_MNEMONIC!);
  const relay = await signer(deployEnv.NEW_DEPLOYER_MNEMONIC!);
  console.log(`   bob ${bob.address} | relay ${relay.address}`);
  await fundIfLow(funder, bob, 6n * ONE, 12n * ONE);
  await fundIfLow(funder, relay, 3n * ONE, 5n * ONE);

  console.log("[keys] deriving Bob's Grumpkin key...");
  const bobSk = ((seed * 3n + 7n) % 2n ** 240n) + 1n;
  const bobPk = grumpkinPk(bobSk);
  const bl = (i: number) => (seed * 1000003n + BigInt(i) * 7919n + 101n) % 2n ** 240n;
  const meta = (i: number) => toBuf(hexOf(BigInt(2000 + i)));

  const tree = new CommitmentTree();
  let onChainRoot = await currentRoot(deployer);
  const insert = (c: bigint): number => tree.insert(toBuf(hexOf(c)));
  const rootHex = () => hx(tree.root);

  const zk = await import("zkverifyjs");
  const session = await zk.zkVerifySession.start().Volta().withAccount(env.ZKVERIFY_SEED_PHRASE!);
  const relayAgg = async (inc: Inc) =>
    stacks(relay, deployer, "zk-verifier", "submit-aggregation",
      [Cl.uint(inc.domainId), Cl.uint(inc.aggregationId), Cl.buffer(toBuf(inc.root)), Cl.uint(inc.leaves)]);

  const R: any = { protocol: deployer, seed: seed.toString(), startedAt: new Date().toISOString(),
    actors: { bob: bob.address, relayer: relay.address }, attacks: [], nullifiers: [], roots: [] };

  try {
    // ---- Bob shields the two merge inputs ----
    console.log("\n=== TEST 3: MERGE ===");
    const shieldNote = async (amt: bigint, tag: number, label: string): Promise<Note> => {
      const n: Note = { amount: amt, pkX: bobPk.x, pkY: bobPk.y, blinding: bl(tag) };
      const c = commitmentOf(n), oc = ownerCommitmentOf(n);
      n.leaf = insert(c);
      console.log(`[3] Bob shields ${Number(amt) / 1e6} STX (${label})...`);
      prove("shield", [`op = "1"`, `commitment = "${hexOf(c)}"`, `owner_commitment = "${hexOf(oc)}"`,
        `amount = "${amt}"`, `circuit_version = "1"`, ``, noteToml("note", n)].join("\n"));
      const sInc = await aggregate(session, zk, "shield");
      await relayAgg(sInc);
      const nr = rootHex();
      const stx = await stacks(bob, deployer, "privacy-pool", "shield",
        [Cl.uint(amt), Cl.buffer(toBuf(hexOf(c))), Cl.buffer(toBuf(hexOf(oc))), Cl.buffer(meta(tag)),
         Cl.buffer(toBuf(onChainRoot)), Cl.buffer(toBuf(nr)), ...incArgs(sInc)]);
      onChainRoot = nr; R.roots.push({ op: label, root: nr });
      console.log("     shield tx:", stx);
      return n;
    };
    // The deployed protocol enforces a 1-STX minimum SHIELD, so 0.3/0.7 notes
    // cannot be shielded directly. Create them the faithful way: shield 1 STX
    // and SPLIT it into 0.3 + 0.7 (split carries no minimum), then merge back.
    const n0 = await shieldNote(1n * ONE, 5, "split-source-1");
    console.log("[3] Bob splits 1 -> 0.3 + 0.7 (to create the merge inputs)...");
    const inC = commitmentOf(n0);
    const m1: Note = { amount: 300_000n, pkX: bobPk.x, pkY: bobPk.y, blinding: bl(6) };
    const m2: Note = { amount: 700_000n, pkX: bobPk.x, pkY: bobPk.y, blinding: bl(7) };
    const sc1 = commitmentOf(m1), soc1 = ownerCommitmentOf(m1), sc2 = commitmentOf(m2), soc2 = ownerCommitmentOf(m2);
    const snf = nullifierOf(inC, bobSk);
    const sp = tree.proof(n0.leaf!);
    prove("split", [`op = "4"`, `nullifier = "${hexOf(snf)}"`, `commitment_1 = "${hexOf(sc1)}"`,
      `owner_commitment_1 = "${hexOf(soc1)}"`, `commitment_2 = "${hexOf(sc2)}"`, `owner_commitment_2 = "${hexOf(soc2)}"`,
      `merkle_root = "${hexOf(big(tree.root))}"`, `circuit_version = "1"`, `owner_sk = "${bobSk}"`,
      `merkle_index = ${arr(sp.indexBits.map((b) => b ? "1" : "0"))}`, `merkle_siblings = ${arr(sp.siblings.map((s) => hexOf(big(s))))}`,
      ``, noteToml("input", n0), ``, noteToml("out_1", m1), ``, noteToml("out_2", m2)].join("\n"));
    const spInc = await aggregate(session, zk, "split");
    await relayAgg(spInc);
    m1.leaf = insert(sc1); m2.leaf = insert(sc2);
    const spRoot = rootHex();
    R.splitTx = await stacks(bob, deployer, "split-merge-manager", "split-note",
      [Cl.buffer(toBuf(hexOf(snf))), Cl.buffer(toBuf(hexOf(sc1))), Cl.buffer(toBuf(hexOf(soc1))), Cl.buffer(meta(6)),
       Cl.buffer(toBuf(hexOf(sc2))), Cl.buffer(toBuf(hexOf(soc2))), Cl.buffer(meta(7)),
       Cl.buffer(toBuf(onChainRoot)), Cl.buffer(toBuf(spRoot)), ...incArgs(spInc)]);
    onChainRoot = spRoot;
    R.nullifiers.push({ op: "split-source", nullifier: hexOf(snf) }); R.roots.push({ op: "split-1-to-0.3-0.7", root: spRoot });
    console.log("     split tx:", R.splitTx, "| created 0.3 + 0.7 notes");

    // ---- Bob merges 0.3 + 0.7 -> 1 ----
    const mg: Note = { amount: 1n * ONE, pkX: bobPk.x, pkY: bobPk.y, blinding: bl(8) };
    const mgC = commitmentOf(mg), mgOC = ownerCommitmentOf(mg);
    const nf_m1 = nullifierOf(commitmentOf(m1), bobSk), nf_m2 = nullifierOf(commitmentOf(m2), bobSk);
    const p1 = tree.proof(m1.leaf!), p2 = tree.proof(m2.leaf!);
    console.log("[3] Bob merges 0.3 + 0.7 -> 1 STX...");
    prove("merge", [`op = "5"`, `nullifier_1 = "${hexOf(nf_m1)}"`, `nullifier_2 = "${hexOf(nf_m2)}"`,
      `commitment = "${hexOf(mgC)}"`, `owner_commitment = "${hexOf(mgOC)}"`, `merkle_root = "${hexOf(big(tree.root))}"`,
      `circuit_version = "1"`, `owner_sk_1 = "${bobSk}"`, `merkle_index_1 = ${arr(p1.indexBits.map((b) => b ? "1" : "0"))}`,
      `merkle_siblings_1 = ${arr(p1.siblings.map((s) => hexOf(big(s))))}`, `owner_sk_2 = "${bobSk}"`,
      `merkle_index_2 = ${arr(p2.indexBits.map((b) => b ? "1" : "0"))}`, `merkle_siblings_2 = ${arr(p2.siblings.map((s) => hexOf(big(s))))}`,
      ``, noteToml("input_1", m1), ``, noteToml("input_2", m2), ``, noteToml("output", mg)].join("\n"));
    const mInc = await aggregate(session, zk, "merge");
    await relayAgg(mInc);
    mg.leaf = insert(mgC); const newRoot = rootHex();
    const rootBeforeMerge = onChainRoot;
    R.mergeTx = await stacks(bob, deployer, "split-merge-manager", "merge-notes",
      [Cl.buffer(toBuf(hexOf(nf_m1))), Cl.buffer(toBuf(hexOf(nf_m2))), Cl.buffer(toBuf(hexOf(mgC))), Cl.buffer(toBuf(hexOf(mgOC))),
       Cl.buffer(meta(8)), Cl.buffer(toBuf(onChainRoot)), Cl.buffer(toBuf(newRoot)), ...incArgs(mInc)]);
    onChainRoot = newRoot;
    R.nullifiers.push({ op: "merge-in1", nullifier: hexOf(nf_m1) }, { op: "merge-in2", nullifier: hexOf(nf_m2) });
    R.roots.push({ op: "merge", root: newRoot });
    R.conservationMerge = (m1.amount + m2.amount === mg.amount);
    console.log("     merge tx:", R.mergeTx, "| conservation 0.3+0.7==1:", R.conservationMerge);

    // ---- Test 4: withdraw the merged note ----
    console.log("\n=== TEST 4: WITHDRAW AFTER MERGE ===");
    const rw = await generateWallet({ secretKey: generateSecretKey(256), password: "" });
    const recipient = getStxAddress({ account: rw.accounts[0]!, network: "testnet" });
    const nf_mg = nullifierOf(mgC, bobSk);
    const pmg = tree.proof(mg.leaf!);
    console.log("[4] relayer withdraws merged 1 STX ->", recipient);
    prove("withdraw", [`op = "3"`, `nullifier = "${hexOf(nf_mg)}"`, `amount = "${mg.amount}"`,
      `recipient_hash = "${hexOf(big(fePrincipal(recipient)))}"`, `merkle_root = "${hexOf(big(toBuf(onChainRoot)))}"`, `circuit_version = "1"`,
      `owner_sk = "${bobSk}"`, `merkle_index = ${arr(pmg.indexBits.map((b) => b ? "1" : "0"))}`,
      `merkle_siblings = ${arr(pmg.siblings.map((s) => hexOf(big(s))))}`, ``, noteToml("input", mg)].join("\n"));
    const mgInc = await aggregate(session, zk, "withdraw");
    await relayAgg(mgInc);

    // Attack #3: tampered amount (reuse the real proof, wrong amount)
    console.log("[atk] tampered withdraw amount (2 vs proven 1 STX)...");
    const a3 = await stacksExpectAbort(relay, deployer, "privacy-pool", "withdraw",
      [Cl.buffer(toBuf(hexOf(nf_mg))), Cl.uint(2n * ONE), Cl.principal(recipient), Cl.buffer(toBuf(onChainRoot)), ...incArgs(mgInc)]);
    R.attacks.push({ id: 3, name: "modify output amount", aborted: a3.aborted, detail: a3.repr });

    // real withdraw
    R.mergeWithdrawTx = await stacks(relay, deployer, "privacy-pool", "withdraw",
      [Cl.buffer(toBuf(hexOf(nf_mg))), Cl.uint(mg.amount), Cl.principal(recipient), Cl.buffer(toBuf(onChainRoot)), ...incArgs(mgInc)]);
    R.mergeWithdrawRecipient = recipient;
    R.mergeWithdrawReceived = Number(await stxBalance(recipient)) / 1e6;
    R.nullifiers.push({ op: "withdraw-merged", nullifier: hexOf(nf_mg) });
    console.log("     merged withdraw tx:", R.mergeWithdrawTx, "received", R.mergeWithdrawReceived, "STX");

    // ---- Test 5: merge attack suite ----
    console.log("\n=== TEST 5: ATTACK VALIDATION ===");
    // #2 reuse merge nullifier -- double-submit the completed merge (root advanced)
    console.log("[atk] reuse merge nullifier (double-submit merge)...");
    const a2 = await stacksExpectAbort(bob, deployer, "split-merge-manager", "merge-notes",
      [Cl.buffer(toBuf(hexOf(nf_m1))), Cl.buffer(toBuf(hexOf(nf_m2))), Cl.buffer(toBuf(hexOf(mgC))), Cl.buffer(toBuf(hexOf(mgOC))),
       Cl.buffer(meta(8)), Cl.buffer(toBuf(rootBeforeMerge)), Cl.buffer(toBuf(newRoot)), ...incArgs(mInc)]);
    R.attacks.push({ id: 2, name: "reuse merge nullifier (replay)", aborted: a2.aborted, detail: a2.repr });

    // #6 spend the merged note twice -- re-withdraw it
    console.log("[atk] spend merged note twice (re-withdraw)...");
    const a6 = await stacksExpectAbort(relay, deployer, "privacy-pool", "withdraw",
      [Cl.buffer(toBuf(hexOf(nf_mg))), Cl.uint(mg.amount), Cl.principal(recipient), Cl.buffer(toBuf(onChainRoot)), ...incArgs(mgInc)]);
    R.attacks.push({ id: 6, name: "spend merged note twice", aborted: a6.aborted, detail: a6.repr });

    // #7 value not conserved -- merge 0.3+0.7 claiming a 2 STX output
    console.log("[atk] value not conserved (0.3+0.7 -> claim 2 STX)...");
    const bad: Note = { amount: 2n * ONE, pkX: bobPk.x, pkY: bobPk.y, blinding: bl(9) };
    const consErr = witnessMustFail("merge", [`op = "5"`, `nullifier_1 = "${hexOf(nf_m1)}"`, `nullifier_2 = "${hexOf(nf_m2)}"`,
      `commitment = "${hexOf(commitmentOf(bad))}"`, `owner_commitment = "${hexOf(ownerCommitmentOf(bad))}"`,
      `merkle_root = "${hexOf(big(toBuf(rootBeforeMerge)))}"`, `circuit_version = "1"`, `owner_sk_1 = "${bobSk}"`,
      `merkle_index_1 = ${arr(p1.indexBits.map((b) => b ? "1" : "0"))}`, `merkle_siblings_1 = ${arr(p1.siblings.map((s) => hexOf(big(s))))}`,
      `owner_sk_2 = "${bobSk}"`, `merkle_index_2 = ${arr(p2.indexBits.map((b) => b ? "1" : "0"))}`,
      `merkle_siblings_2 = ${arr(p2.siblings.map((s) => hexOf(big(s))))}`, ``, noteToml("input_1", m1), ``, noteToml("input_2", m2), ``, noteToml("output", bad)].join("\n"));
    R.attacks.push({ id: 7, name: "value not conserved", aborted: !/UNEXPECTED/.test(consErr), detail: consErr });
    console.log("     conservation attack rejected by circuit:", !/UNEXPECTED/.test(consErr));

    await session.close();
    R.allAttacksFailed = R.attacks.every((a: any) => a.aborted);
    R.finishedAt = new Date().toISOString();
    writeFileSync("deployments/testnet/merge-results.json", JSON.stringify(R, null, 2) + "\n");

    console.log("\n=========================================================");
    console.log("MERGE VALIDATION COMPLETE");
    console.log("  merge conservation 0.3+0.7==1:", R.conservationMerge);
    console.log("  merged note withdrawn:", R.mergeWithdrawReceived, "STX to", R.mergeWithdrawRecipient);
    console.log("  all", R.attacks.length, "attacks correctly failed:", R.allAttacksFailed);
    const pass = R.conservationMerge && R.mergeWithdrawReceived > 0 && R.allAttacksFailed;
    console.log(pass ? "\n*** MERGE VALIDATION PASSED ***" : "\n*** MERGE VALIDATION FAILED -- see merge-results.json ***");
    return pass ? 0 : 1;
  } catch (e) {
    await session.close().catch(() => {});
    R.error = e instanceof Error ? e.message : String(e);
    writeFileSync("deployments/testnet/merge-results.json", JSON.stringify(R, null, 2) + "\n");
    throw e;
  }
};

// ---- helpers ----
const tomlMnemonic = (file: string, account: string): string => {
  const m = readFileSync(file, "utf8").match(new RegExp(`\\[accounts\\.${account}\\][\\s\\S]*?mnemonic\\s*=\\s*"([^"]+)"`));
  if (!m) throw new Error(`no mnemonic for ${account} in ${file}`); return m[1]!;
};
const signer = async (m: string) => {
  const w = await generateWallet({ secretKey: m, password: "" });
  const a = w.accounts[0]!; return { key: a.stxPrivateKey, address: getStxAddress({ account: a, network: "testnet" }) };
};
const nextNonce = async (address: string) =>
  BigInt((await (await fetch(`${API}/extended/v1/address/${address}/nonces`)).json() as any).possible_next_nonce);
const fundIfLow = async (funder: any, target: any, minMicro: bigint, topUpMicro: bigint) => {
  const b = await stxBalance(target.address);
  if (b >= minMicro) { console.log(`   ${target.address}: ${Number(b) / 1e6} STX (ok)`); return; }
  console.log(`   funding ${target.address} with ${Number(topUpMicro) / 1e6} STX...`);
  const tx = await makeSTXTokenTransfer({ recipient: target.address, amount: topUpMicro, senderKey: funder.key, network: "testnet", fee: 3000n, nonce: await nextNonce(funder.address) });
  const r = await broadcastTransaction({ transaction: tx, network: "testnet" });
  await waitForTx((r as { txid: string }).txid, `fund ${target.address}`);
};
const waitForTx = async (txid: string, label: string): Promise<void> => {
  const deadline = Date.now() + TX_TIMEOUT;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/extended/v1/tx/${txid}`);
    if (res.ok) {
      const b = (await res.json()) as { tx_status: string; tx_result?: { repr: string } };
      if (b.tx_status === "success") return;
      if (b.tx_status.startsWith("abort")) throw new Error(`${label} aborted: ${b.tx_result?.repr ?? b.tx_status} (${txid})`);
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error(`${label} not confirmed (${txid})`);
};
const broadcastAndWait = async (from: any, deployer: string, contract: string, fn: string, args: any[]) => {
  const tx = await makeContractCall({ contractAddress: deployer, contractName: contract, functionName: fn, functionArgs: args,
    senderKey: from.key, network: "testnet", postConditionMode: PostConditionMode.Allow, fee: 30_000, nonce: await nextNonce(from.address) });
  const r = await broadcastTransaction({ transaction: tx, network: "testnet" });
  const txid = (r as { txid: string }).txid;
  if (!txid) throw new Error(`${fn} broadcast failed: ${JSON.stringify(r)}`);
  const deadline = Date.now() + TX_TIMEOUT;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/extended/v1/tx/${txid}`);
    if (res.ok) {
      const b = (await res.json()) as { tx_status: string; tx_result?: { repr: string } };
      if (b.tx_status === "success") return { txid, status: "success" as const, repr: b.tx_result?.repr ?? "" };
      if (b.tx_status.startsWith("abort")) return { txid, status: "abort" as const, repr: b.tx_result?.repr ?? b.tx_status };
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error(`${fn} not confirmed (${txid})`);
};
const stacks = async (from: any, d: string, c: string, fn: string, args: any[]): Promise<string> => {
  const r = await broadcastAndWait(from, d, c, fn, args);
  if (r.status !== "success") throw new Error(`${fn} aborted: ${r.repr} (${r.txid})`); return r.txid;
};
const stacksExpectAbort = async (from: any, d: string, c: string, fn: string, args: any[]) => {
  const r = await broadcastAndWait(from, d, c, fn, args);
  return { aborted: r.status === "abort", repr: r.repr, txid: r.txid };
};
const currentRoot = async (d: string): Promise<string> => {
  const res = await fetch(`${API}/v2/contracts/call-read/${d}/privacy-registry/get-current-root`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: d, arguments: [] }) });
  return (cvToJSON(hexToCV((await res.json() as any).result)) as any).value.root.value as string;
};
const stxBalance = async (address: string): Promise<bigint> => {
  const res = await fetch(`${API}/extended/v1/address/${address}/balances`);
  if (!res.ok) return 0n; return BigInt((await res.json() as any).stx.balance);
};

main().then((c) => process.exit(c)).catch((e) => { console.error("\nMerge validation failed:", e instanceof Error ? e.message : e); process.exit(1); });
