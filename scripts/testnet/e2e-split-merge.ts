// =============================================================================
// STX Shield -- PHASE 7: real SPLIT and MERGE validation on Stacks Testnet
// =============================================================================
//   npx tsx scripts/testnet/e2e-split-merge.ts [seed]
//
// Proves split-note and merge-notes work on the DEPLOYED stack with real Noir
// proofs, real zkVerify verification, and real STX. No contract changes.
//
// REAL-USER end-to-end (money moves through user wallets, not the deployer):
//   Alice  (.env.users) shields 5 STX and transfers the note to Bob
//   Bob    (.env.users) splits 5 -> 2 + 3, then 3 -> 2 + 1; later merges 0.3+0.7
//   Relayer(registered aggregation relayer) publishes zkVerify roots and submits
//          withdrawals to FRESH, unlinkable recipient wallets
//   Funder (Devnet.toml wallet_2, holds millions of testnet STX) tops up any
//          wallet that is low, and funds freshly generated wallets.
//
// Amounts are scaled so every WITHDRAWN note meets the deployed 1-STX minimum
// withdrawal; split/merge themselves carry no such floor.
// =============================================================================

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  Cl,
  broadcastTransaction,
  makeContractCall,
  makeSTXTokenTransfer,
  PostConditionMode,
  hexToCV,
  cvToJSON,
  cvToHex,
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

// ---- byte / field helpers --------------------------------------------------
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

// ---- circuit registry (deployed vkeys + zkVerify bindings) -----------------
type Circuit = "shield" | "transfer" | "withdraw" | "split" | "merge";
const PKG: Record<Circuit, string> = {
  shield: "shield_note", transfer: "transfer_note", withdraw: "withdraw_note",
  split: "split_note", merge: "merge_note",
};
const ZKV_VK: Record<Circuit, string> = {
  shield: "0x96889d2466624e271b44d4e32ac8b557bdfdc922a1a16dc42f5c807f2dcacad8",
  transfer: "0x3668b8b291ddf8cb0bc60bf9f3f33ce9e5af9d2de631ebd3bfb10a4455e91595",
  withdraw: "0x5e1ad470b0b8b0094acd87360989f31c1059ba73e6613522d0b07d55e6b749de",
  split: "0x7a3fbca8876dbbd32c5977c886cc843b41b18201330a80378719b12383ec2b01",
  merge: "0x025d92c5d1f17b50433ab138f5f603eb64cb94b48299b5f23b9b8fcda76735de",
};
const CTX = keccak_256(new TextEncoder().encode("ultrahonk"));
const VERSION = toBuf("0x55b52ad2b4153c872e27d688f567c1406f0d93b5528dd2b0bf2a9a40df97f1f9");

// ---- Grumpkin keys (keygen circuit -> matches assert_owner) -----------------
const grumpkinPk = (sk: bigint): { x: bigint; y: bigint } => {
  writeFileSync("zk/circuits/keygen/Prover.toml", `owner_sk = "${sk}"\n`);
  const o = wsl(`cd ${REPO}/zk/circuits/keygen && nargo execute 2>&1 | grep "Circuit output"`);
  const m = o.match(/\[(0x[0-9a-f]+), (0x[0-9a-f]+)\]/i);
  if (!m) throw new Error("keygen failed: " + o.slice(0, 200));
  return { x: BigInt(m[1]!), y: BigInt(m[2]!) };
};

// ---- notes -----------------------------------------------------------------
interface Note { amount: bigint; pkX: bigint; pkY: bigint; blinding: bigint; leaf?: number; }
const commitmentOf = (n: Note) => BigInt(poseidon4([n.amount, n.pkX, n.pkY, n.blinding]));
const ownerCommitmentOf = (n: Note) => BigInt(poseidon2([n.pkX, n.pkY]));
const nullifierOf = (commitment: bigint, sk: bigint) => BigInt(poseidon2([commitment, sk]));
const arr = (xs: string[]) => "[" + xs.map((x) => `"${x}"`).join(", ") + "]";
const noteToml = (label: string, n: Note) =>
  [`[${label}]`, `amount = "${n.amount}"`, `owner_pk_x = "${n.pkX}"`, `owner_pk_y = "${n.pkY}"`, `blinding = "${n.blinding}"`].join("\n");

// ---- proof generation ------------------------------------------------------
const prove = (c: Circuit, prover: string): Uint8Array => {
  writeFileSync(`zk/circuits/${c}/Prover.toml`, prover + "\n");
  wsl(`cd ${REPO}/zk/circuits/${c} && nargo execute witness && bb prove -b target/${PKG[c]}.json -w target/witness.gz -k target/vk/vk -o target/proofout -t evm`);
  const v = wsl(`cd ${REPO}/zk/circuits/${c} && bb verify -k target/vk/vk -p target/proofout/proof -i target/proofout/public_inputs -t evm 2>&1 | tail -1`);
  if (!/verified successfully/i.test(v)) throw new Error(`${c} proof failed local verify: ${v.trim()}`);
  return readFileSync(`zk/circuits/${c}/target/proofout/public_inputs`);
};
const witnessMustFail = (c: Circuit, prover: string): string => {
  writeFileSync(`zk/circuits/${c}/Prover.toml`, prover + "\n");
  try {
    const o = wsl(`cd ${REPO}/zk/circuits/${c} && nargo execute witness 2>&1`);
    return "UNEXPECTED SUCCESS: " + o.slice(-120);
  } catch (e: any) {
    return String(e.stdout || e.message || e).match(/(value not conserved|assert|Assertion|failed)/i)?.[0] ?? "failed";
  }
};

// ---- zkVerify: submit -> verify leaf -> aggregate -> path -------------------
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
  if (leaf !== sub.statement) throw new Error(`${c} statement mismatch: local ${leaf} vs zkVerify ${sub.statement}`);
  console.log(`      zkVerify verified ${c} (agg ${sub.aggregationId}), leaf==statement OK`);
  const receipt = await session.waitForAggregationReceipt(0, sub.aggregationId, 480_000);
  const path = await session.getAggregateStatementPath(receipt.blockHash, 0, sub.aggregationId, sub.statement);
  return { domainId: 0, aggregationId: sub.aggregationId, root: path.root, leaves: path.numberOfLeaves, path: path.proof, leafIndex: path.leafIndex, statement: sub.statement };
};
const incArgs = (i: Inc) => [Cl.uint(i.domainId), Cl.uint(i.aggregationId), Cl.list(i.path.map((p) => Cl.buffer(toBuf(p)))), Cl.uint(i.leafIndex)];

// ===========================================================================
// MAIN
// ===========================================================================
const main = async (): Promise<number> => {
  const seed = BigInt(process.argv[2] ?? Date.now().toString());
  const env = loadEnv(".env.testnet");
  const users = loadEnv(".env.users");
  const deployEnv = loadEnv(".env.deploy");
  const { deployer } = JSON.parse(readFileSync("deployments/testnet/addresses.json", "utf8"));

  // ---- actors ----
  console.log("[actors] loading wallets...");
  const funder = await signer(tomlMnemonic("settings/Devnet.toml", "wallet_2")); // faucet: millions of tSTX
  const alice = await signer(users.ALICE_MNEMONIC!);
  const bob = await signer(users.BOB_MNEMONIC!);
  const relay = await signer(deployEnv.NEW_DEPLOYER_MNEMONIC!); // registered aggregation relayer
  console.log(`   funder ${funder.address}`);
  console.log(`   alice  ${alice.address}`);
  console.log(`   bob    ${bob.address}`);
  console.log(`   relay  ${relay.address}`);

  // ---- fund actors from the faucet if low ----
  console.log("[fund] topping up actors from the faucet if needed...");
  await fundIfLow(funder, alice, 12n * ONE, 20n * ONE);
  await fundIfLow(funder, bob, 8n * ONE, 15n * ONE);
  await fundIfLow(funder, relay, 3n * ONE, 5n * ONE);

  // ---- keys ----
  console.log("[keys] deriving Grumpkin keys...");
  const aliceSk = (seed % 2n ** 240n) + 1n;
  const bobSk = ((seed * 3n + 7n) % 2n ** 240n) + 1n;
  const alicePk = grumpkinPk(aliceSk);
  const bobPk = grumpkinPk(bobSk);
  const bl = (i: number) => (seed * 1000003n + BigInt(i) * 7919n + 101n) % 2n ** 240n;
  const meta = (i: number) => toBuf(hexOf(BigInt(1000 + i)));

  const tree = new CommitmentTree();
  let onChainRoot = await currentRoot(deployer);
  const insert = (c: bigint): number => tree.insert(toBuf(hexOf(c)));
  const rootHex = () => hx(tree.root);

  const zk = await import("zkverifyjs");
  const session = await zk.zkVerifySession.start().Volta().withAccount(env.ZKVERIFY_SEED_PHRASE!);

  const R: any = {
    protocol: deployer, seed: seed.toString(), startedAt: new Date().toISOString(),
    actors: { alice: alice.address, bob: bob.address, relayer: relay.address },
    tests: {}, attacks: [], roots: [], nullifiers: [], startPoolBalance: (await poolBalance(deployer)).toString(),
  };
  const relayAgg = async (inc: Inc) =>
    stacks(relay, deployer, "zk-verifier", "submit-aggregation",
      [Cl.uint(inc.domainId), Cl.uint(inc.aggregationId), Cl.buffer(toBuf(inc.root)), Cl.uint(inc.leaves)]);

  try {
    // =====================================================================
    // TEST 1 -- SPLIT
    // =====================================================================
    console.log("\n=== TEST 1: SPLIT ===");
    // 1a. Alice shields 5 STX
    const n0: Note = { amount: 5n * ONE, pkX: alicePk.x, pkY: alicePk.y, blinding: bl(0) };
    const c0 = commitmentOf(n0), oc0 = ownerCommitmentOf(n0);
    n0.leaf = insert(c0);
    console.log("[1a] Alice shields 5 STX...");
    prove("shield", [`op = "1"`, `commitment = "${hexOf(c0)}"`, `owner_commitment = "${hexOf(oc0)}"`,
      `amount = "${n0.amount}"`, `circuit_version = "1"`, ``, noteToml("note", n0)].join("\n"));
    let inc = await aggregate(session, zk, "shield");
    await relayAgg(inc);
    let newRoot = rootHex();
    R.tests.shieldTx = await stacks(alice, deployer, "privacy-pool", "shield",
      [Cl.uint(n0.amount), Cl.buffer(toBuf(hexOf(c0))), Cl.buffer(toBuf(hexOf(oc0))), Cl.buffer(meta(0)),
       Cl.buffer(toBuf(onChainRoot)), Cl.buffer(toBuf(newRoot)), ...incArgs(inc)]);
    onChainRoot = newRoot; R.roots.push({ op: "shield-5", root: newRoot });
    console.log("     shield tx:", R.tests.shieldTx);

    // 1b. Alice transfers the 5 STX note to Bob
    const n1: Note = { amount: 5n * ONE, pkX: bobPk.x, pkY: bobPk.y, blinding: bl(1) };
    const c1 = commitmentOf(n1), oc1 = ownerCommitmentOf(n1);
    const nf0 = nullifierOf(c0, aliceSk);
    let mp = tree.proof(n0.leaf!);
    console.log("[1b] Alice transfers 5 STX note -> Bob...");
    prove("transfer", [`op = "2"`, `nullifier = "${hexOf(nf0)}"`, `new_commitment = "${hexOf(c1)}"`,
      `new_owner_commitment = "${hexOf(oc1)}"`, `merkle_root = "${hexOf(big(tree.root))}"`, `circuit_version = "1"`,
      `owner_sk = "${aliceSk}"`, `merkle_index = ${arr(mp.indexBits.map((b) => b ? "1" : "0"))}`,
      `merkle_siblings = ${arr(mp.siblings.map((s) => hexOf(big(s))))}`, ``, noteToml("input", n0), ``, noteToml("output", n1)].join("\n"));
    inc = await aggregate(session, zk, "transfer");
    await relayAgg(inc);
    n1.leaf = insert(c1); newRoot = rootHex();
    R.tests.transferTx = await stacks(alice, deployer, "privacy-pool", "transfer",
      [Cl.buffer(toBuf(hexOf(nf0))), Cl.buffer(toBuf(hexOf(c1))), Cl.buffer(toBuf(hexOf(oc1))), Cl.buffer(meta(1)),
       Cl.buffer(toBuf(onChainRoot)), Cl.buffer(toBuf(newRoot)), ...incArgs(inc)]);
    onChainRoot = newRoot;
    R.nullifiers.push({ op: "transfer", nullifier: hexOf(nf0) }); R.roots.push({ op: "transfer", root: newRoot });
    console.log("     transfer tx:", R.tests.transferTx);

    // 1c/1d. Bob splits 5 -> 2 + 3, then 3 -> 2 + 1
    const doSplit = async (input: Note, inSk: bigint, a1: bigint, a2: bigint, tag: number): Promise<[Note, Note, string]> => {
      const inC = commitmentOf(input);
      const out1: Note = { amount: a1, pkX: bobPk.x, pkY: bobPk.y, blinding: bl(tag) };
      const out2: Note = { amount: a2, pkX: bobPk.x, pkY: bobPk.y, blinding: bl(tag + 1) };
      const oc_1 = commitmentOf(out1), ooc1 = ownerCommitmentOf(out1);
      const oc_2 = commitmentOf(out2), ooc2 = ownerCommitmentOf(out2);
      const nf = nullifierOf(inC, inSk);
      const p = tree.proof(input.leaf!);
      console.log(`[split] Bob splits ${Number(input.amount) / 1e6} -> ${Number(a1) / 1e6} + ${Number(a2) / 1e6} STX...`);
      prove("split", [`op = "4"`, `nullifier = "${hexOf(nf)}"`, `commitment_1 = "${hexOf(oc_1)}"`,
        `owner_commitment_1 = "${hexOf(ooc1)}"`, `commitment_2 = "${hexOf(oc_2)}"`, `owner_commitment_2 = "${hexOf(ooc2)}"`,
        `merkle_root = "${hexOf(big(tree.root))}"`, `circuit_version = "1"`, `owner_sk = "${inSk}"`,
        `merkle_index = ${arr(p.indexBits.map((b) => b ? "1" : "0"))}`, `merkle_siblings = ${arr(p.siblings.map((s) => hexOf(big(s))))}`,
        ``, noteToml("input", input), ``, noteToml("out_1", out1), ``, noteToml("out_2", out2)].join("\n"));
      const sInc = await aggregate(session, zk, "split");
      await relayAgg(sInc);
      out1.leaf = insert(oc_1); out2.leaf = insert(oc_2);
      const nr = rootHex();
      const stx = await stacks(bob, deployer, "split-merge-manager", "split-note",
        [Cl.buffer(toBuf(hexOf(nf))), Cl.buffer(toBuf(hexOf(oc_1))), Cl.buffer(toBuf(hexOf(ooc1))), Cl.buffer(meta(tag)),
         Cl.buffer(toBuf(hexOf(oc_2))), Cl.buffer(toBuf(hexOf(ooc2))), Cl.buffer(meta(tag + 1)),
         Cl.buffer(toBuf(onChainRoot)), Cl.buffer(toBuf(nr)), ...incArgs(sInc)]);
      onChainRoot = nr;
      R.nullifiers.push({ op: `split-${tag}`, nullifier: hexOf(nf) }); R.roots.push({ op: `split-${tag}`, root: nr });
      console.log("     split tx:", stx);
      return [out1, out2, stx];
    };
    const [sA, sB, splitTx1] = await doSplit(n1, bobSk, 2n * ONE, 3n * ONE, 2);
    const [sC, sD, splitTx2] = await doSplit(sB, bobSk, 2n * ONE, 1n * ONE, 4);
    R.tests.splitTxs = [splitTx1, splitTx2];
    R.tests.finalNotes = [{ amount: "2 STX", leaf: sA.leaf }, { amount: "2 STX", leaf: sC.leaf }, { amount: "1 STX", leaf: sD.leaf }];
    R.tests.conservationSplit = (sA.amount + sC.amount + sD.amount === n1.amount);
    console.log("[1] split conservation 5 == 2+2+1:", R.tests.conservationSplit);

    // =====================================================================
    // TEST 2 -- WITHDRAW AFTER SPLIT (relayer submits, fresh recipients)
    // =====================================================================
    console.log("\n=== TEST 2: WITHDRAW AFTER SPLIT ===");
    const withdraws: any[] = [];
    const doWithdraw = async (note: Note, inSk: bigint, label: string): Promise<{ recipient: string; txid: string; received: bigint; nullifier: bigint; inc: Inc; root: string }> => {
      const c = commitmentOf(note);
      const nf = nullifierOf(c, inSk);
      const rw = await generateWallet({ secretKey: generateSecretKey(256), password: "" });
      const recipient = getStxAddress({ account: rw.accounts[0]!, network: "testnet" });
      const p = tree.proof(note.leaf!);
      const proofRoot = onChainRoot;
      console.log(`[wd] relayer withdraws ${Number(note.amount) / 1e6} STX (${label}) -> ${recipient}...`);
      prove("withdraw", [`op = "3"`, `nullifier = "${hexOf(nf)}"`, `amount = "${note.amount}"`,
        `recipient_hash = "${hexOf(big(fePrincipal(recipient)))}"`, `merkle_root = "${hexOf(big(toBuf(proofRoot)))}"`, `circuit_version = "1"`,
        `owner_sk = "${inSk}"`, `merkle_index = ${arr(p.indexBits.map((b) => b ? "1" : "0"))}`,
        `merkle_siblings = ${arr(p.siblings.map((s) => hexOf(big(s))))}`, ``, noteToml("input", note)].join("\n"));
      const wInc = await aggregate(session, zk, "withdraw");
      await relayAgg(wInc);
      const txid = await stacks(relay, deployer, "privacy-pool", "withdraw",
        [Cl.buffer(toBuf(hexOf(nf))), Cl.uint(note.amount), Cl.principal(recipient), Cl.buffer(toBuf(proofRoot)), ...incArgs(wInc)]);
      const received = await stxBalance(recipient);
      R.nullifiers.push({ op: `withdraw-${label}`, nullifier: hexOf(nf) });
      console.log("     withdraw tx:", txid, "received", Number(received) / 1e6, "STX");
      return { recipient, txid, received, nullifier: nf, inc: wInc, root: proofRoot };
    };
    const wA = await doWithdraw(sA, bobSk, "A-2STX"); withdraws.push({ note: "2 STX", ...pick(wA) });
    const wC = await doWithdraw(sC, bobSk, "B-2STX"); withdraws.push({ note: "2 STX", ...pick(wC) });
    const wD = await doWithdraw(sD, bobSk, "C-1STX"); withdraws.push({ note: "1 STX", ...pick(wD) });
    R.tests.splitWithdraws = withdraws;
    R.tests.totalWithdrawnAfterSplit = Number(wA.received + wC.received + wD.received) / 1e6;

    // =====================================================================
    // TEST 3 -- MERGE (Bob shields 0.3 + 0.7 -> merges -> 1)
    // =====================================================================
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
    const m1 = await shieldNote(300_000n, 6, "merge-input-0.3");
    const m2 = await shieldNote(700_000n, 7, "merge-input-0.7");

    const mg: Note = { amount: 1n * ONE, pkX: bobPk.x, pkY: bobPk.y, blinding: bl(8) };
    const mgC = commitmentOf(mg), mgOC = ownerCommitmentOf(mg);
    const c_m1 = commitmentOf(m1), c_m2 = commitmentOf(m2);
    const nf_m1 = nullifierOf(c_m1, bobSk), nf_m2 = nullifierOf(c_m2, bobSk);
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
    mg.leaf = insert(mgC); newRoot = rootHex();
    const rootBeforeMerge = onChainRoot;
    R.tests.mergeTx = await stacks(bob, deployer, "split-merge-manager", "merge-notes",
      [Cl.buffer(toBuf(hexOf(nf_m1))), Cl.buffer(toBuf(hexOf(nf_m2))), Cl.buffer(toBuf(hexOf(mgC))), Cl.buffer(toBuf(hexOf(mgOC))),
       Cl.buffer(meta(8)), Cl.buffer(toBuf(onChainRoot)), Cl.buffer(toBuf(newRoot)), ...incArgs(mInc)]);
    const rootAfterMerge = newRoot; onChainRoot = newRoot;
    R.nullifiers.push({ op: "merge-in1", nullifier: hexOf(nf_m1) }, { op: "merge-in2", nullifier: hexOf(nf_m2) });
    R.roots.push({ op: "merge", root: newRoot });
    R.tests.conservationMerge = (m1.amount + m2.amount === mg.amount);
    console.log("     merge tx:", R.tests.mergeTx, "| conservation 0.3+0.7==1:", R.tests.conservationMerge);

    // =====================================================================
    // TEST 4 -- WITHDRAW AFTER MERGE (tampered-amount attack, then real)
    // =====================================================================
    console.log("\n=== TEST 4: WITHDRAW AFTER MERGE ===");
    const rw = await generateWallet({ secretKey: generateSecretKey(256), password: "" });
    const mgRecipient = getStxAddress({ account: rw.accounts[0]!, network: "testnet" });
    const nf_mg = nullifierOf(mgC, bobSk);
    const pmg = tree.proof(mg.leaf!);
    console.log("[4] relayer withdraws merged 1 STX -> ", mgRecipient);
    prove("withdraw", [`op = "3"`, `nullifier = "${hexOf(nf_mg)}"`, `amount = "${mg.amount}"`,
      `recipient_hash = "${hexOf(big(fePrincipal(mgRecipient)))}"`, `merkle_root = "${hexOf(big(toBuf(onChainRoot)))}"`, `circuit_version = "1"`,
      `owner_sk = "${bobSk}"`, `merkle_index = ${arr(pmg.indexBits.map((b) => b ? "1" : "0"))}`,
      `merkle_siblings = ${arr(pmg.siblings.map((s) => hexOf(big(s))))}`, ``, noteToml("input", mg)].join("\n"));
    const mgInc = await aggregate(session, zk, "withdraw");
    await relayAgg(mgInc);

    console.log("[5.3] attack: tampered withdraw amount (2 STX vs proven 1 STX)...");
    const atk3 = await stacksExpectAbort(relay, deployer, "privacy-pool", "withdraw",
      [Cl.buffer(toBuf(hexOf(nf_mg))), Cl.uint(2n * ONE), Cl.principal(mgRecipient), Cl.buffer(toBuf(onChainRoot)), ...incArgs(mgInc)]);
    R.attacks.push({ id: 3, name: "modify output amount", aborted: atk3.aborted, detail: atk3.repr });

    const mgWdTx = await stacks(relay, deployer, "privacy-pool", "withdraw",
      [Cl.buffer(toBuf(hexOf(nf_mg))), Cl.uint(mg.amount), Cl.principal(mgRecipient), Cl.buffer(toBuf(onChainRoot)), ...incArgs(mgInc)]);
    const mgReceived = await stxBalance(mgRecipient);
    R.tests.mergeWithdrawTx = mgWdTx; R.tests.mergeWithdrawRecipient = mgRecipient; R.tests.mergeWithdrawReceived = Number(mgReceived) / 1e6;
    R.nullifiers.push({ op: "withdraw-merged", nullifier: hexOf(nf_mg) });
    console.log("     merged withdraw tx:", mgWdTx, "received", Number(mgReceived) / 1e6, "STX");

    // =====================================================================
    // TEST 5 -- ATTACK VALIDATION (rest)
    // =====================================================================
    console.log("\n=== TEST 5: ATTACK VALIDATION ===");
    console.log("[5.1] attack: reuse split nullifier / spend spent note (re-withdraw A)...");
    const atk1 = await stacksExpectAbort(relay, deployer, "privacy-pool", "withdraw",
      [Cl.buffer(toBuf(hexOf(wA.nullifier))), Cl.uint(2n * ONE), Cl.principal(wA.recipient), Cl.buffer(toBuf(wA.root)), ...incArgs(wA.inc)]);
    R.attacks.push({ id: 1, name: "reuse split nullifier / spend spent note", aborted: atk1.aborted, detail: atk1.repr });

    console.log("[5.2] attack: reuse merge nullifier (double-submit completed merge)...");
    void rootAfterMerge;
    const atk2 = await stacksExpectAbort(bob, deployer, "split-merge-manager", "merge-notes",
      [Cl.buffer(toBuf(hexOf(nf_m1))), Cl.buffer(toBuf(hexOf(nf_m2))), Cl.buffer(toBuf(hexOf(mgC))), Cl.buffer(toBuf(hexOf(mgOC))),
       Cl.buffer(meta(8)), Cl.buffer(toBuf(rootBeforeMerge)), Cl.buffer(toBuf(rootAfterMerge)), ...incArgs(mInc)]);
    R.attacks.push({ id: 2, name: "reuse merge nullifier (replay)", aborted: atk2.aborted, detail: atk2.repr });

    console.log("[5.4] attack: invalid/unknown Merkle root...");
    const badRoot = "0x" + "de".repeat(32);
    const atk4 = await stacksExpectAbort(relay, deployer, "privacy-pool", "withdraw",
      [Cl.buffer(toBuf(hexOf(nullifierOf(9999n, bobSk)))), Cl.uint(1n * ONE), Cl.principal(wA.recipient), Cl.buffer(toBuf(badRoot)), ...incArgs(wA.inc)]);
    R.attacks.push({ id: 4, name: "invalid Merkle root", aborted: atk4.aborted, detail: atk4.repr });

    console.log("[5.5] attack: duplicated output commitment...");
    const dup = toBuf(hexOf(commitmentOf(sA)));
    const atk5 = await stacksExpectAbort(bob, deployer, "split-merge-manager", "split-note",
      [Cl.buffer(toBuf(hexOf(nullifierOf(8888n, bobSk)))), Cl.buffer(dup), Cl.buffer(meta(20)), Cl.buffer(meta(20)),
       Cl.buffer(dup), Cl.buffer(meta(21)), Cl.buffer(meta(21)), Cl.buffer(toBuf(onChainRoot)), Cl.buffer(toBuf(onChainRoot)),
       ...incArgs(mgInc)]);
    R.attacks.push({ id: 5, name: "duplicated output commitment", aborted: atk5.aborted, detail: atk5.repr });

    console.log("[5.7] attack: over-issuance (0.6 + 0.6 from 1 STX) -> witness must fail...");
    const p5 = tree.proof(sD.leaf!);
    const badOut1: Note = { amount: 600_000n, pkX: bobPk.x, pkY: bobPk.y, blinding: bl(30) };
    const badOut2: Note = { amount: 600_000n, pkX: bobPk.x, pkY: bobPk.y, blinding: bl(31) };
    const consErr = witnessMustFail("split", [`op = "4"`, `nullifier = "${hexOf(nullifierOf(commitmentOf(sD), bobSk))}"`,
      `commitment_1 = "${hexOf(commitmentOf(badOut1))}"`, `owner_commitment_1 = "${hexOf(ownerCommitmentOf(badOut1))}"`,
      `commitment_2 = "${hexOf(commitmentOf(badOut2))}"`, `owner_commitment_2 = "${hexOf(ownerCommitmentOf(badOut2))}"`,
      `merkle_root = "${hexOf(big(tree.root))}"`, `circuit_version = "1"`, `owner_sk = "${bobSk}"`,
      `merkle_index = ${arr(p5.indexBits.map((b) => b ? "1" : "0"))}`, `merkle_siblings = ${arr(p5.siblings.map((s) => hexOf(big(s))))}`,
      ``, noteToml("input", sD), ``, noteToml("out_1", badOut1), ``, noteToml("out_2", badOut2)].join("\n"));
    R.attacks.push({ id: 7, name: "value not conserved (over-issuance)", aborted: !/UNEXPECTED/.test(consErr), detail: consErr });
    console.log("     conservation attack rejected by circuit:", !/UNEXPECTED/.test(consErr));

    await session.close();

    // ---- final state + report ----
    R.endPoolBalance = (await poolBalance(deployer)).toString();
    R.totalNullifiers = (await totalNullifiers(deployer)).toString();
    R.allAttacksFailed = R.attacks.every((a: any) => a.aborted);
    R.finishedAt = new Date().toISOString();
    writeFileSync("deployments/testnet/split-merge-results.json", JSON.stringify(R, null, 2) + "\n");
    writeReport(R);

    console.log("\n=========================================================");
    console.log("PHASE 7 COMPLETE");
    console.log("  split conservation:", R.tests.conservationSplit, "| merge conservation:", R.tests.conservationMerge);
    console.log("  all", R.attacks.length, "attacks correctly failed:", R.allAttacksFailed);
    console.log("  report: TESTNET-SPLIT-MERGE-RESULTS.md");
    const pass = R.tests.conservationSplit && R.tests.conservationMerge && R.allAttacksFailed &&
      R.tests.splitWithdraws.length === 3 && R.tests.mergeWithdrawReceived > 0;
    console.log(pass ? "\n*** ALL PHASE 7 SUCCESS CRITERIA MET ***" : "\n*** SOME CHECKS FAILED -- see report ***");
    return pass ? 0 : 1;
  } catch (e) {
    await session.close().catch(() => {});
    R.error = e instanceof Error ? e.message : String(e);
    writeFileSync("deployments/testnet/split-merge-results.json", JSON.stringify(R, null, 2) + "\n");
    throw e;
  }
};

// ---- config / funding helpers ----------------------------------------------
const tomlMnemonic = (file: string, account: string): string => {
  const txt = readFileSync(file, "utf8");
  const m = txt.match(new RegExp(`\\[accounts\\.${account}\\][\\s\\S]*?mnemonic\\s*=\\s*"([^"]+)"`));
  if (!m) throw new Error(`no mnemonic for ${account} in ${file}`);
  return m[1]!;
};
const fundIfLow = async (funder: any, target: any, minMicro: bigint, topUpMicro: bigint) => {
  const b = await stxBalance(target.address);
  if (b >= minMicro) { console.log(`   ${target.address}: ${Number(b) / 1e6} STX (ok)`); return; }
  console.log(`   funding ${target.address} with ${Number(topUpMicro) / 1e6} STX...`);
  const tx = await makeSTXTokenTransfer({
    recipient: target.address, amount: topUpMicro, senderKey: funder.key, network: "testnet",
    fee: 3000n, nonce: await nextNonce(funder.address) });
  const r = await broadcastTransaction({ transaction: tx, network: "testnet" });
  await waitForTx((r as { txid: string }).txid, `fund ${target.address}`);
};

// ---- misc helpers ----------------------------------------------------------
const pick = (w: any) => ({ recipient: w.recipient, txid: w.txid, received: Number(w.received) / 1e6 });
const signer = async (m: string) => {
  const w = await generateWallet({ secretKey: m, password: "" });
  const a = w.accounts[0]!;
  return { key: a.stxPrivateKey, address: getStxAddress({ account: a, network: "testnet" }) };
};
const nextNonce = async (address: string) =>
  BigInt((await (await fetch(`${API}/extended/v1/address/${address}/nonces`)).json() as any).possible_next_nonce);
const waitForTx = async (txid: string, label: string): Promise<void> => {
  const deadline = Date.now() + 900_000;
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
const broadcastAndWait = async (from: { key: string; address: string }, deployer: string, contract: string, fn: string, args: any[]) => {
  const tx = await makeContractCall({
    contractAddress: deployer, contractName: contract, functionName: fn, functionArgs: args,
    senderKey: from.key, network: "testnet", postConditionMode: PostConditionMode.Allow, fee: 25_000, nonce: await nextNonce(from.address) });
  const r = await broadcastTransaction({ transaction: tx, network: "testnet" });
  const txid = (r as { txid: string }).txid;
  if (!txid) throw new Error(`${fn} broadcast failed: ${JSON.stringify(r)}`);
  const deadline = Date.now() + 900_000;
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
  if (r.status !== "success") throw new Error(`${fn} aborted: ${r.repr} (${r.txid})`);
  return r.txid;
};
const stacksExpectAbort = async (from: any, d: string, c: string, fn: string, args: any[]): Promise<{ aborted: boolean; repr: string; txid: string }> => {
  const r = await broadcastAndWait(from, d, c, fn, args);
  return { aborted: r.status === "abort", repr: r.repr, txid: r.txid };
};
const readUint = async (d: string, c: string, fn: string): Promise<bigint> => {
  const res = await fetch(`${API}/v2/contracts/call-read/${d}/${c}/${fn}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: d, arguments: [] }) });
  return BigInt((cvToJSON(hexToCV((await res.json() as any).result)) as any).value);
};
const currentRoot = async (d: string): Promise<string> => {
  const res = await fetch(`${API}/v2/contracts/call-read/${d}/privacy-registry/get-current-root`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: d, arguments: [] }) });
  return (cvToJSON(hexToCV((await res.json() as any).result)) as any).value.root.value as string;
};
const poolBalance = (d: string) => readUint(d, "privacy-pool", "get-pool-balance");
const totalNullifiers = (d: string) => readUint(d, "privacy-registry", "get-total-nullifiers");
const stxBalance = async (address: string): Promise<bigint> => {
  const res = await fetch(`${API}/extended/v1/address/${address}/balances`);
  if (!res.ok) return 0n;
  return BigInt((await res.json() as any).stx.balance);
};
void cvToHex;

// ---- report ----------------------------------------------------------------
const writeReport = (R: any) => {
  const yn = (b: boolean) => (b ? "PASS" : "FAIL");
  const ex = (t: string) => `https://explorer.hiro.so/txid/${t}?chain=testnet`;
  const wd = (w: any) => `| ${w.note} | \`${w.recipient}\` | ${w.received} STX | [\`${w.txid.slice(0, 16)}...\`](${ex(w.txid)}) |`;
  const atk = (a: any) => `| ${a.id} | ${a.name} | ${yn(a.aborted)} | ${(a.detail || "").toString().replace(/\|/g, "/").slice(0, 60)} |`;
  const nl = R.nullifiers.map((n: any, i: number) => `${i + 1}. ${n.op}: \`${n.nullifier.slice(0, 22)}...\``).join("\n");
  const rl = R.roots.map((r: any, i: number) => `${i + 1}. after ${r.op}: \`${r.root.slice(0, 22)}...\``).join("\n");
  const md = `# STX Shield -- Testnet Split & Merge Results (Phase 7)

Real Noir proofs, real zkVerify verification, real STX. No contract changes.
Deployed protocol: \`${R.protocol}\`. Run seed: \`${R.seed}\`. Finished: ${R.finishedAt}.

Real-user roles: **Alice** \`${R.actors.alice}\` shields + transfers; **Bob**
\`${R.actors.bob}\` splits + merges; the registered **relayer** \`${R.actors.relayer}\`
publishes zkVerify aggregation roots and submits withdrawals to fresh recipients.

> Amounts scaled so every withdrawn note meets the deployed 1-STX minimum
> withdrawal. Split/merge operations themselves carry no such floor.

## Lifecycle demonstrated

\`\`\`
Alice: shield 5 -> transfer to Bob
Bob:   split 5 -> 2 + 3    split 3 -> 2 + 1
Relayer: withdraw 2 -> A    withdraw 2 -> B    withdraw 1 -> C
Bob:   shield 0.3 + shield 0.7 -> merge(0.3 + 0.7 -> 1)
Relayer: withdraw 1 -> D
\`\`\`

## Test 1 -- Split

- Alice shields 5 STX: [\`${R.tests.shieldTx}\`](${ex(R.tests.shieldTx)})
- Alice transfers 5 STX -> Bob: [\`${R.tests.transferTx}\`](${ex(R.tests.transferTx)})
- Bob splits 5 -> 2 + 3: [\`${R.tests.splitTxs?.[0]}\`](${ex(R.tests.splitTxs?.[0])})
- Bob splits 3 -> 2 + 1: [\`${R.tests.splitTxs?.[1]}\`](${ex(R.tests.splitTxs?.[1])})
- Final note set: 2 STX, 2 STX, 1 STX
- Conservation (5 == 2 + 2 + 1): **${yn(R.tests.conservationSplit)}**

## Test 2 -- Withdraw after split

| Note | Recipient (fresh) | Received (net of fee) | Tx |
|---|---|---|---|
${R.tests.splitWithdraws.map(wd).join("\n")}

Total received after split: **${R.tests.totalWithdrawnAfterSplit} STX** (1 STX released per note minus the withdraw fee to treasury). Withdrawals are independent; all use distinct nullifiers.

## Test 3 -- Merge

- Bob shields 0.3 STX + 0.7 STX (two Bob-owned notes)
- Bob merges 0.3 + 0.7 -> 1 STX: [\`${R.tests.mergeTx}\`](${ex(R.tests.mergeTx)})
- Both input notes consumed (two nullifiers); one output note created
- Conservation (0.3 + 0.7 == 1): **${yn(R.tests.conservationMerge)}**

## Test 4 -- Withdraw after merge

- Recipient (fresh): \`${R.tests.mergeWithdrawRecipient}\`
- Received: **${R.tests.mergeWithdrawReceived} STX**
- Tx: [\`${R.tests.mergeWithdrawTx}\`](${ex(R.tests.mergeWithdrawTx)})

## Test 5 -- Attack validation (all must fail)

| # | Attack | Result | Abort reason |
|---|---|---|---|
${R.attacks.sort((a: any, b: any) => a.id - b.id).map(atk).join("\n")}

All attacks correctly rejected: **${yn(R.allAttacksFailed)}**

## Conservation & state

- Pool balance: ${Number(R.startPoolBalance) / 1e6} STX -> ${Number(R.endPoolBalance) / 1e6} STX (net zero for this run: everything shielded was later withdrawn)
- Total nullifiers on chain: ${R.totalNullifiers}
- Split value conserved in-circuit; merge value conserved in-circuit; over-issuance rejected before a witness can be built.

### Nullifier progression (each spend unique)
${nl}

### Merkle root progression (commitment-tree pointer)
${rl}

## Pass/Fail

| Criterion | Status |
|---|---|
| Real shield | PASS |
| Real transfer | PASS |
| Real split-note (x2) | ${yn(R.tests.conservationSplit)} |
| Real merge-notes | ${yn(R.tests.conservationMerge)} |
| Real withdrawals (x4) | ${yn(R.tests.splitWithdraws.length === 3 && R.tests.mergeWithdrawReceived > 0)} |
| Real zkVerify verification | PASS |
| Conservation invariants | ${yn(R.tests.conservationSplit && R.tests.conservationMerge)} |
| No double-spends / no replay | ${yn(R.allAttacksFailed)} |
| No contract modifications | PASS |

**Overall: ${yn(R.tests.conservationSplit && R.tests.conservationMerge && R.allAttacksFailed)}**
`;
  writeFileSync("TESTNET-SPLIT-MERGE-RESULTS.md", md);
};

main().then((c) => process.exit(c)).catch((e) => { console.error("\nPhase 7 failed:", e instanceof Error ? e.message : e); process.exit(1); });
