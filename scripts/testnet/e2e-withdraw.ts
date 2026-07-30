// =============================================================================
// STX Shield -- real private WITHDRAW on Stacks Testnet
// =============================================================================
//   npx tsx scripts/testnet/e2e-withdraw.ts <relayMnemonic> <seed>
//
// Closes the lifecycle: Bob (who received a note via the transfer at <seed>)
// cashes it out to a FRESH address that has no prior on-chain link to anyone.
//
//   Bob proves ownership (owner_sk * G == owner_pk) + Merkle membership of his
//   note, binds the recipient in-circuit, and the pool pays transparent STX to
//   that address. The note is consumed via its nullifier; the chain never
//   learns which leaf funded the payout.
//
// Reproduces Bob's note deterministically from the same <seed> the transfer
// used, so no secret state needs to be persisted.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  Cl,
  broadcastTransaction,
  makeContractCall,
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
const PATH = "export PATH=$HOME/.nargo/bin:$HOME/.bb:$PATH";
const REPO = "/mnt/g/2026/Blockchain/Stacks/stx-shield";

const hexOf = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");
const toBuf = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const big = (b: Uint8Array) => BigInt("0x" + Buffer.from(b).toString("hex"));
const feUint = (n: bigint) => {
  const b = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0 && x > 0n; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
};
const concat = (...a: Uint8Array[]) => {
  const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o;
};
const wsl = (c: string) =>
  execFileSync("wsl", ["-e", "bash", "-lc", `${PATH}; ${c}`], { encoding: "utf8", maxBuffer: 64 << 20 });

const grumpkinPk = (sk: bigint): { x: bigint; y: bigint } => {
  writeFileSync("zk/circuits/keygen/Prover.toml", `owner_sk = "${sk}"\n`);
  const o = wsl(`cd ${REPO}/zk/circuits/keygen && nargo execute 2>&1 | grep "Circuit output"`);
  const m = o.match(/\[(0x[0-9a-f]+), (0x[0-9a-f]+)\]/i)!;
  return { x: BigInt(m[1]!), y: BigInt(m[2]!) };
};

const ZKV = {
  ctx: keccak_256(new TextEncoder().encode("ultrahonk")),
  version: toBuf("0x55b52ad2b4153c872e27d688f567c1406f0d93b5528dd2b0bf2a9a40df97f1f9"),
  withdrawVk: toBuf("0x5e1ad470b0b8b0094acd87360989f31c1059ba73e6613522d0b07d55e6b749de"),
};

const main = async (): Promise<number> => {
  const [relayM, seedStr] = process.argv.slice(2);
  if (!relayM || !seedStr) { console.error("usage: e2e-withdraw.ts <relayMnemonic> <seed>"); return 1; }
  const seed = BigInt(seedStr);
  const amount = 1_000_000n;
  const env = loadEnv(".env.testnet");
  const { deployer } = JSON.parse(readFileSync("deployments/testnet/addresses.json", "utf8"));

  // -- 1. reproduce Alice's and Bob's notes from the transfer seed --------
  console.log("[1] reproducing Bob's note from the transfer seed...");
  const aliceSk = (seed % 2n ** 240n) + 1n;
  const bobSk = ((seed * 3n + 7n) % 2n ** 240n) + 1n;
  const apk = grumpkinPk(aliceSk), bpk = grumpkinPk(bobSk);
  const aBlind = (seed * 5n + 2n) % 2n ** 240n;
  const bBlind = (seed * 11n + 4n) % 2n ** 240n;
  const aCommit = BigInt(poseidon4([amount, apk.x, apk.y, aBlind]));
  const bCommit = BigInt(poseidon4([amount, bpk.x, bpk.y, bBlind]));
  console.log("    bob note commitment:", hexOf(bCommit).slice(0, 20) + "...");

  // rebuild the tree exactly as it stood after the transfer: Alice@0, Bob@1
  const tree = new CommitmentTree();
  tree.insert(toBuf(hexOf(aCommit)));
  const bobLeaf = tree.insert(toBuf(hexOf(bCommit)));
  const R2 = "0x" + Buffer.from(tree.root).toString("hex");
  const mp = tree.proof(bobLeaf);
  const nullifier = BigInt(poseidon2([bCommit, bobSk]));

  // -- 2. fresh, unlinkable recipient -------------------------------------
  const recipMnemonic = generateSecretKey(256);
  const recipWallet = await generateWallet({ secretKey: recipMnemonic, password: "" });
  const recipient = getStxAddress({ account: recipWallet.accounts[0]!, network: "testnet" });
  const recipientHash = big(fePrincipal(recipient));
  console.log("[2] fresh recipient (no prior on-chain link):", recipient);

  // -- 3. withdraw proof --------------------------------------------------
  console.log("[3] generating withdraw proof (ownership + membership)...");
  const arr = (xs: string[]) => "[" + xs.map((x) => `"${x}"`).join(", ") + "]";
  const prover = [
    `op = "3"`,
    `nullifier = "${hexOf(nullifier)}"`,
    `amount = "${amount}"`,
    `recipient_hash = "${hexOf(recipientHash)}"`,
    `merkle_root = "${hexOf(big(tree.root))}"`,
    `circuit_version = "1"`,
    `owner_sk = "${bobSk}"`,
    `merkle_index = ${arr(mp.indexBits.map((b) => (b ? "1" : "0")))}`,
    `merkle_siblings = ${arr(mp.siblings.map((s) => hexOf(big(s))))}`,
    ``,
    `[input]`, `amount = "${amount}"`, `owner_pk_x = "${bpk.x}"`,
    `owner_pk_y = "${bpk.y}"`, `blinding = "${bBlind}"`,
  ].join("\n");
  writeFileSync("zk/circuits/withdraw/Prover.toml", prover + "\n");
  wsl(`cd ${REPO}/zk/circuits/withdraw && nargo execute witness && bb prove -b target/withdraw_note.json -w target/witness.gz -k target/vk/vk -o target/proofout -t evm`);
  const v = wsl(`cd ${REPO}/zk/circuits/withdraw && bb verify -k target/vk/vk -p target/proofout/proof -i target/proofout/public_inputs -t evm 2>&1 | tail -1`);
  if (!/verified successfully/i.test(v)) throw new Error("withdraw proof failed local verify: " + v.trim());
  console.log("    withdraw proof verifies locally ✓");

  // -- 4. zkVerify: verify + aggregate + path -----------------------------
  console.log("[4] submitting to zkVerify + aggregating...");
  const pubBytes = readFileSync("zk/circuits/withdraw/target/proofout/public_inputs");
  const proof = "0x" + Buffer.from(readFileSync("zk/circuits/withdraw/target/proofout/proof")).toString("hex");
  const vk = "0x" + Buffer.from(readFileSync("zk/circuits/withdraw/target/vk/vk")).toString("hex");
  const signals: string[] = [];
  for (let i = 0; i < pubBytes.length; i += 32) signals.push("0x" + Buffer.from(pubBytes.subarray(i, i + 32)).toString("hex"));
  const zk = await import("zkverifyjs");
  const session = await zk.zkVerifySession.start().Volta().withAccount(env.ZKVERIFY_SEED_PHRASE!);
  const { transactionResult } = await session.verify()
    .ultrahonk({ version: zk.UltrahonkVersion.V3_0, variant: zk.UltrahonkVariant.ZK })
    .execute({ proofData: { proof, publicSignals: signals, vk }, domainId: 0 });
  const sub = await transactionResult;
  const leaf = keccak_256(concat(ZKV.ctx, ZKV.withdrawVk, ZKV.version, keccak_256(pubBytes)));
  if ("0x" + Buffer.from(leaf).toString("hex") !== sub.statement) { await session.close(); throw new Error("withdraw leaf mismatch"); }
  console.log("    verified by zkVerify (agg " + sub.aggregationId + "), leaf == statement ✓");
  const receipt = await session.waitForAggregationReceipt(0, sub.aggregationId, 480_000);
  const path = await session.getAggregateStatementPath(receipt.blockHash, 0, sub.aggregationId, sub.statement);
  await session.close();

  // -- 5. relay root + submit withdraw ------------------------------------
  console.log("[5] relaying root + submitting withdraw...");
  const relay = await signer(relayM);
  await stacks(relay, deployer, "zk-verifier", "submit-aggregation", [
    Cl.uint(0), Cl.uint(sub.aggregationId), Cl.buffer(toBuf(path.root)), Cl.uint(path.numberOfLeaves),
  ]);
  const poolBefore = await poolBalance(deployer);
  const recipBefore = await stxBalance(recipient);
  const txid = await stacks(relay, deployer, "privacy-pool", "withdraw", [
    Cl.buffer(toBuf(hexOf(nullifier))), Cl.uint(amount), Cl.principal(recipient), Cl.buffer(toBuf(R2)),
    Cl.uint(0), Cl.uint(sub.aggregationId), Cl.list(path.proof.map((p: string) => Cl.buffer(toBuf(p)))), Cl.uint(path.leafIndex),
  ]);
  console.log("    withdraw tx:", txid);

  // -- 6. verify ----------------------------------------------------------
  const poolAfter = await poolBalance(deployer);
  const recipAfter = await stxBalance(recipient);
  console.log("[6] verification:");
  console.log("    pool balance:", Number(poolBefore) / 1e6, "->", Number(poolAfter) / 1e6, "STX");
  console.log("    recipient balance:", Number(recipBefore) / 1e6, "->", Number(recipAfter) / 1e6, "STX (net of withdraw fee)");
  const ok = poolBefore - poolAfter === amount && recipAfter > recipBefore;
  console.log(ok
    ? "\n*** REAL PRIVATE WITHDRAW SUCCEEDED -- STX left the pool to an unlinkable address ***"
    : "\nwithdraw did not settle as expected");
  console.log(`\nLifecycle complete: shield -> transfer -> withdraw, all real, all private.`);
  return ok ? 0 : 1;
};

// ---- helpers ---------------------------------------------------------------

const signer = async (m: string) => {
  const w = await generateWallet({ secretKey: m, password: "" });
  const a = w.accounts[0]!;
  return { key: a.stxPrivateKey, address: getStxAddress({ account: a, network: "testnet" }) };
};
const nextNonce = async (address: string) =>
  BigInt((await (await fetch(`${API}/extended/v1/address/${address}/nonces`)).json() as any).possible_next_nonce);
const stacks = async (from: { key: string; address: string }, deployer: string, contract: string, fn: string, args: any[]): Promise<string> => {
  const tx = await makeContractCall({
    contractAddress: deployer, contractName: contract, functionName: fn, functionArgs: args,
    senderKey: from.key, network: "testnet", postConditionMode: PostConditionMode.Allow, fee: 20_000, nonce: await nextNonce(from.address),
  });
  const r = await broadcastTransaction({ transaction: tx, network: "testnet" });
  const txid = (r as { txid: string }).txid;
  if (!txid) throw new Error(`${fn} broadcast failed: ${JSON.stringify(r)}`);
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/extended/v1/tx/${txid}`);
    if (res.ok) {
      const b = (await res.json()) as { tx_status: string; tx_result?: { repr: string } };
      if (b.tx_status === "success") return txid;
      if (b.tx_status.startsWith("abort")) throw new Error(`${fn} aborted: ${b.tx_result?.repr ?? b.tx_status} (${txid})`);
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error(`${fn} not confirmed (${txid})`);
};
const poolBalance = async (deployer: string): Promise<bigint> => {
  const res = await fetch(`${API}/v2/contracts/call-read/${deployer}/privacy-pool/get-pool-balance`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: deployer, arguments: [] }) });
  return BigInt((cvToJSON(hexToCV((await res.json() as any).result)) as any).value);
};
const stxBalance = async (address: string): Promise<bigint> => {
  const res = await fetch(`${API}/extended/v1/address/${address}/balances`);
  if (!res.ok) return 0n;
  return BigInt((await res.json() as any).stx.balance);
};
void cvToHex;

main().then((c) => process.exit(c)).catch((e) => { console.error("\nWithdraw E2E failed:", e instanceof Error ? e.message : e); process.exit(1); });
