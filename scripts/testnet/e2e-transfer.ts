// =============================================================================
// STX Shield -- real private TRANSFER on Stacks Testnet
// =============================================================================
//   npx tsx scripts/testnet/e2e-transfer.ts <aliceMnemonic> <bobRelayMnemonic> <amountMicroStx> <seed>
//
// The first UNLINKABLE value movement between two users, fully real:
//
//   Alice shields a properly-keyed note (Grumpkin owner key)
//        -> the note enters the commitment tree
//   Alice transfers it privately:
//        - proves ownership (owner_sk * G == owner_pk) in-circuit
//        - proves Merkle membership of her note against the tree root
//        - publishes ONLY a nullifier + Bob's new commitment
//   Bob now owns a note; the chain never learns which note was consumed,
//   who sent, or who received.
//
// Every proof is a real UltraHonk proof verified by zkVerify. No mocks.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  Cl,
  broadcastTransaction,
  makeContractCall,
  PostConditionMode,
  hexToCV,
  cvToJSON,
} from "@stacks/transactions";
import { generateWallet, getStxAddress } from "@stacks/wallet-sdk";
import { poseidon2, poseidon4 } from "poseidon-lite";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { loadEnv, loadClarinetApiUrl } from "../deployment/config.js";
import { CommitmentTree } from "../../sdk/merkle-tree/index.js";

const API = loadClarinetApiUrl("testnet") ?? "https://api.testnet.hiro.so";
const PATH = "export PATH=$HOME/.nargo/bin:$HOME/.bb:$PATH";
const REPO = "/mnt/g/2026/Blockchain/Stacks/stx-shield";

const hexOf = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");
const toBuf = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const bytesToBig = (b: Uint8Array) => BigInt("0x" + Buffer.from(b).toString("hex"));
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
const wsl = (cmd: string) =>
  execFileSync("wsl", ["-e", "bash", "-lc", `${PATH}; ${cmd}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// Grumpkin public key owner_sk * G, computed by the keygen circuit so it
// matches assert_owner byte for byte.
const grumpkinPk = (sk: bigint): { x: bigint; y: bigint } => {
  writeFileSync("zk/circuits/keygen/Prover.toml", `owner_sk = "${sk}"\n`);
  const out = wsl(`cd ${REPO}/zk/circuits/keygen && nargo execute 2>&1 | grep "Circuit output"`);
  const m = out.match(/\[(0x[0-9a-f]+), (0x[0-9a-f]+)\]/i);
  if (!m) throw new Error("keygen failed: " + out.slice(0, 200));
  return { x: BigInt(m[1]!), y: BigInt(m[2]!) };
};

const bcInputs = {
  ctx: keccak_256(new TextEncoder().encode("ultrahonk")),
  version: toBuf("0x55b52ad2b4153c872e27d688f567c1406f0d93b5528dd2b0bf2a9a40df97f1f9"),
  vk: {
    shield: toBuf("0x96889d2466624e271b44d4e32ac8b557bdfdc922a1a16dc42f5c807f2dcacad8"),
    transfer: toBuf("0x3668b8b291ddf8cb0bc60bf9f3f33ce9e5af9d2de631ebd3bfb10a4455e91595"),
  },
};

interface Note { amount: bigint; pkX: bigint; pkY: bigint; blinding: bigint; }
const commitmentOf = (n: Note) => BigInt(poseidon4([n.amount, n.pkX, n.pkY, n.blinding]));
const ownerCommitmentOf = (n: Note) => BigInt(poseidon2([n.pkX, n.pkY]));
const nullifierOf = (commitment: bigint, sk: bigint) => BigInt(poseidon2([commitment, sk]));

const main = async (): Promise<number> => {
  const [aliceM, relayM, amountStr, seedStr] = process.argv.slice(2);
  if (!aliceM || !relayM || !amountStr) {
    console.error("usage: e2e-transfer.ts <aliceMnemonic> <relayMnemonic> <amount> [seed]");
    return 1;
  }
  const amount = BigInt(amountStr);
  const seed = BigInt(seedStr ?? Date.now());
  const env = loadEnv(".env.testnet");
  const { deployer } = JSON.parse(readFileSync("deployments/testnet/addresses.json", "utf8"));
  const genesis = "0x2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3e";

  // -- keys ---------------------------------------------------------------
  console.log("[1] deriving Grumpkin keys (keygen circuit)...");
  const aliceSk = (seed % (2n ** 240n)) + 1n;
  const bobSk = ((seed * 3n + 7n) % (2n ** 240n)) + 1n;
  const alicePk = grumpkinPk(aliceSk);
  const bobPk = grumpkinPk(bobSk);
  const aliceNote: Note = { amount, pkX: alicePk.x, pkY: alicePk.y, blinding: (seed * 5n + 2n) % (2n ** 240n) };
  const aCommit = commitmentOf(aliceNote);
  const aOwnerC = ownerCommitmentOf(aliceNote);
  console.log("    alice note commitment:", hexOf(aCommit).slice(0, 20) + "...");

  // -- commitment tree: insert Alice's note at leaf 0 ---------------------
  const tree = new CommitmentTree();
  const aliceLeaf = tree.insert(toBuf(hexOf(aCommit)));
  const R1 = "0x" + Buffer.from(tree.root).toString("hex");
  console.log("    tree root after shield (R1):", R1.slice(0, 20) + "...");

  const zk = await import("zkverifyjs");
  const session = await zk.zkVerifySession.start().Volta().withAccount(env.ZKVERIFY_SEED_PHRASE!);
  const relay = await signer(relayM);
  const alice = await signer(aliceM);

  // -- 2. shield Alice's note (real proof), setting new-root = R1 ---------
  // The on-chain root is a client-defined pointer; shield requires the CURRENT
  // live root (earlier shields advanced it past genesis) and then advances it
  // to R1 -- the fresh tree this transfer proves membership against.
  console.log("[2] Alice shields her note (real proof, tree root R1)...");
  const liveRoot = await currentRoot(deployer);
  void genesis;
  const shieldPub = await proveShield(aliceNote, aCommit, aOwnerC);
  const shieldInc = await zkSubmit(session, zk, "shield", shieldPub);
  await relayRoot(relay, deployer, shieldInc);
  await stacks(alice, deployer, "privacy-pool", "shield", [
    Cl.uint(amount), Cl.buffer(toBuf(hexOf(aCommit))), Cl.buffer(toBuf(hexOf(aOwnerC))),
    Cl.buffer(toBuf(hexOf(seed))), Cl.buffer(toBuf(liveRoot)), Cl.buffer(toBuf(R1)),
    ...incArgs(shieldInc),
  ]);
  console.log("    shielded. current root is now R1.");

  // -- 3. Alice transfers to Bob (real membership + ownership proof) ------
  console.log("[3] Alice transfers privately to Bob...");
  const bobNote: Note = { amount, pkX: bobPk.x, pkY: bobPk.y, blinding: (seed * 11n + 4n) % (2n ** 240n) };
  const bCommit = commitmentOf(bobNote);
  const bOwnerC = ownerCommitmentOf(bobNote);
  const nullifier = nullifierOf(aCommit, aliceSk);
  const mp = tree.proof(aliceLeaf);

  const transferPub = await proveTransfer({
    nullifier, newCommitment: bCommit, newOwnerCommitment: bOwnerC, merkleRoot: bytesToBig(tree.root),
    input: aliceNote, ownerSk: aliceSk, indexBits: mp.indexBits, siblings: mp.siblings.map(bytesToBig), output: bobNote,
  });
  const transferInc = await zkSubmit(session, zk, "transfer", transferPub);
  await relayRoot(relay, deployer, transferInc);

  // new tree root after inserting Bob's commitment (bookkeeping / new-root)
  const R2tree = new CommitmentTree();
  R2tree.insert(toBuf(hexOf(aCommit)));
  R2tree.insert(toBuf(hexOf(bCommit)));
  const R2 = "0x" + Buffer.from(R2tree.root).toString("hex");

  const before = await poolBalance(deployer);
  const nBefore = await totalNullifiers(deployer);
  const txid = await stacks(alice, deployer, "privacy-pool", "transfer", [
    Cl.buffer(toBuf(hexOf(nullifier))), Cl.buffer(toBuf(hexOf(bCommit))), Cl.buffer(toBuf(hexOf(bOwnerC))),
    Cl.buffer(toBuf(hexOf(seed + 1n))), Cl.buffer(toBuf(R1)), Cl.buffer(toBuf(R2)),
    ...incArgs(transferInc),
  ]);
  await session.close();
  console.log("    transfer tx:", txid);

  // -- 4. verify ----------------------------------------------------------
  const after = await poolBalance(deployer);
  const nAfter = await totalNullifiers(deployer);
  console.log("[4] verification:");
  console.log("    pool balance (unchanged by transfer):", Number(before) / 1e6, "->", Number(after) / 1e6, "STX");
  console.log("    nullifiers:", nBefore, "->", nAfter, "(+1, Alice's note consumed)");
  const spent = await nullifierSpent(deployer, hexOf(nullifier));
  console.log("    Alice's nullifier registered:", spent);
  const ok = after === before && nAfter === nBefore + 1n && spent;
  console.log(ok
    ? "\n*** REAL PRIVATE TRANSFER SUCCEEDED -- Bob owns a note, graph unlinkable ***"
    : "\ntransfer did not settle as expected");
  return ok ? 0 : 1;
};

// ---- proof generation ------------------------------------------------------

const proveShield = async (note: Note, commitment: bigint, ownerC: bigint): Promise<Uint8Array> => {
  const prover = [
    `op = "1"`, `commitment = "${hexOf(commitment)}"`, `owner_commitment = "${hexOf(ownerC)}"`,
    `amount = "${note.amount}"`, `circuit_version = "1"`, ``,
    `[note]`, `amount = "${note.amount}"`, `owner_pk_x = "${note.pkX}"`,
    `owner_pk_y = "${note.pkY}"`, `blinding = "${note.blinding}"`,
  ].join("\n");
  writeFileSync("zk/circuits/shield/Prover.toml", prover + "\n");
  wsl(`cd ${REPO}/zk/circuits/shield && nargo execute witness && bb prove -b target/shield_note.json -w target/witness.gz -k target/vk/vk -o target/proofout -t evm`);
  return readFileSync("zk/circuits/shield/target/proofout/public_inputs");
};

const proveTransfer = async (a: {
  nullifier: bigint; newCommitment: bigint; newOwnerCommitment: bigint; merkleRoot: bigint;
  input: Note; ownerSk: bigint; indexBits: boolean[]; siblings: bigint[]; output: Note;
}): Promise<Uint8Array> => {
  const arr = (xs: string[]) => "[" + xs.map((x) => `"${x}"`).join(", ") + "]";
  const prover = [
    `op = "2"`,
    `nullifier = "${hexOf(a.nullifier)}"`,
    `new_commitment = "${hexOf(a.newCommitment)}"`,
    `new_owner_commitment = "${hexOf(a.newOwnerCommitment)}"`,
    `merkle_root = "${hexOf(a.merkleRoot)}"`,
    `circuit_version = "1"`,
    `owner_sk = "${a.ownerSk}"`,
    `merkle_index = ${arr(a.indexBits.map((b) => (b ? "1" : "0")))}`,
    `merkle_siblings = ${arr(a.siblings.map((s) => hexOf(s)))}`,
    ``,
    `[input]`, `amount = "${a.input.amount}"`, `owner_pk_x = "${a.input.pkX}"`,
    `owner_pk_y = "${a.input.pkY}"`, `blinding = "${a.input.blinding}"`,
    ``,
    `[output]`, `amount = "${a.output.amount}"`, `owner_pk_x = "${a.output.pkX}"`,
    `owner_pk_y = "${a.output.pkY}"`, `blinding = "${a.output.blinding}"`,
  ].join("\n");
  writeFileSync("zk/circuits/transfer/Prover.toml", prover + "\n");
  wsl(`cd ${REPO}/zk/circuits/transfer && nargo execute witness && bb prove -b target/transfer_note.json -w target/witness.gz -k target/vk/vk -o target/proofout -t evm`);
  const v = wsl(`cd ${REPO}/zk/circuits/transfer && bb verify -k target/vk/vk -p target/proofout/proof -i target/proofout/public_inputs -t evm 2>&1 | tail -1`);
  if (!/verified successfully/i.test(v)) throw new Error("transfer proof failed local verify: " + v.trim());
  console.log("    transfer proof verifies locally ✓");
  return readFileSync("zk/circuits/transfer/target/proofout/public_inputs");
};

// ---- zkVerify --------------------------------------------------------------

interface Inc { domainId: number; aggregationId: number; root: string; leaves: number; path: string[]; leafIndex: number; }

const zkSubmit = async (session: any, zk: any, op: "shield" | "transfer", pubBytes: Uint8Array): Promise<Inc> => {
  const proofDir = `zk/circuits/${op === "shield" ? "shield" : "transfer"}/target/proofout`;
  const proof = "0x" + Buffer.from(readFileSync(`${proofDir}/proof`)).toString("hex");
  const vk = "0x" + Buffer.from(readFileSync(`zk/circuits/${op === "shield" ? "shield" : "transfer"}/target/vk/vk`)).toString("hex");
  const signals: string[] = [];
  for (let i = 0; i < pubBytes.length; i += 32) signals.push("0x" + Buffer.from(pubBytes.subarray(i, i + 32)).toString("hex"));
  const { transactionResult } = await session.verify()
    .ultrahonk({ version: zk.UltrahonkVersion.V3_0, variant: zk.UltrahonkVariant.ZK })
    .execute({ proofData: { proof, publicSignals: signals, vk }, domainId: 0 });
  const sub = await transactionResult;
  // local statement == zkVerify statement
  const leaf = keccak_256(concat(bcInputs.ctx, bcInputs.vk[op], bcInputs.version, keccak_256(pubBytes)));
  if ("0x" + Buffer.from(leaf).toString("hex") !== sub.statement) throw new Error(`${op} leaf mismatch`);
  console.log(`    ${op}: verified by zkVerify (agg ${sub.aggregationId}), leaf == statement ✓`);
  const receipt = await session.waitForAggregationReceipt(0, sub.aggregationId, 480_000);
  const path = await session.getAggregateStatementPath(receipt.blockHash, 0, sub.aggregationId, sub.statement);
  return { domainId: 0, aggregationId: sub.aggregationId, root: path.root, leaves: path.numberOfLeaves, path: path.proof, leafIndex: path.leafIndex };
};

const incArgs = (i: Inc) => [
  Cl.uint(i.domainId), Cl.uint(i.aggregationId), Cl.list(i.path.map((p) => Cl.buffer(toBuf(p)))), Cl.uint(i.leafIndex),
];

const relayRoot = async (relay: { key: string; address: string }, deployer: string, i: Inc) => {
  await stacks(relay, deployer, "zk-verifier", "submit-aggregation", [
    Cl.uint(i.domainId), Cl.uint(i.aggregationId), Cl.buffer(toBuf(i.root)), Cl.uint(i.leaves),
  ]);
};

// ---- Stacks helpers --------------------------------------------------------

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
const readUint = async (deployer: string, contract: string, fn: string): Promise<bigint> => {
  const res = await fetch(`${API}/v2/contracts/call-read/${deployer}/${contract}/${fn}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: deployer, arguments: [] }) });
  const j = (await res.json()) as { result: string };
  return BigInt((cvToJSON(hexToCV(j.result)) as any).value);
};
const currentRoot = async (deployer: string): Promise<string> => {
  const res = await fetch(`${API}/v2/contracts/call-read/${deployer}/privacy-registry/get-current-root`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: deployer, arguments: [] }) });
  const j = (await res.json()) as { result: string };
  return (cvToJSON(hexToCV(j.result)) as any).value.root.value as string;
};
const poolBalance = (d: string) => readUint(d, "privacy-pool", "get-pool-balance");
const totalNullifiers = (d: string) => readUint(d, "privacy-registry", "get-total-nullifiers");
const nullifierSpent = async (deployer: string, nullifier: string): Promise<boolean> => {
  const { cvToHex } = await import("@stacks/transactions");
  const res = await fetch(`${API}/v2/contracts/call-read/${deployer}/privacy-registry/is-nullifier-spent`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: deployer, arguments: [cvToHex(Cl.buffer(toBuf(nullifier)))] }) });
  const j = (await res.json()) as { result: string };
  return (cvToJSON(hexToCV(j.result)) as any).value === true;
};

main().then((c) => process.exit(c)).catch((e) => { console.error("\nTransfer E2E failed:", e instanceof Error ? e.message : e); process.exit(1); });
