// =============================================================================
// STX Shield -- SIP-10 testnet e2e: shared harness
// =============================================================================
// The SIP-10 sibling of scripts/testnet/e2e-*.ts. Same real pipeline as the STX
// flows -- real Noir/UltraHonk proofs, real zkVerify Volta aggregation, real
// on-chain submission -- with the ONE cryptographic difference of SIP-10:
//
//   commitment = Poseidon2([ Poseidon4([amount, pk_x, pk_y, blinding]), asset_id ])
//   asset_id   = fePrincipal(token-contract-principal)
//
// so a note (and its nullifier and tree membership) is bound to a specific token.
// Everything else -- Grumpkin owner keys, the depth-20 CommitmentTree, the
// off-chain tree that mirrors the shared registry and drives each on-chain
// new-root -- is identical to the STX harness by design.
//
// Runs from the MINGW64 shell: proof generation shells out to `wsl` for nargo+bb
// (the ZK toolchain lives under WSL). Reads:
//   .env.deploy   NEW_DEPLOYER_MNEMONIC (relayer) + <PREFIX>_ZKV_VKEY_HASH
//   .env.testnet  ZKVERIFY_SEED_PHRASE
//   .env.users    {ALICE,BOB,CAROL}_{MNEMONIC,ADDRESS}
// The deployer mnemonic is used only to sign the relayer's submit-aggregation; it
// is never printed.

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
import { generateWallet, getStxAddress } from "@stacks/wallet-sdk";
import { poseidon2, poseidon4 } from "poseidon-lite";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { loadEnv, loadClarinetApiUrl } from "../../deployment/config.js";
import { fePrincipal } from "../../../sdk/public-inputs/index.js";
import { CommitmentTree } from "../../../sdk/merkle-tree/index.js";

export const API = loadClarinetApiUrl("testnet") ?? "https://api.testnet.hiro.so";
const PATHENV = "export PATH=$HOME/.nargo/bin:$HOME/.bb:$PATH";
export const REPO = "/mnt/g/2026/Blockchain/Stacks/stx-shield";

// ---- byte / field helpers --------------------------------------------------
export const hexOf = (x: bigint): string => "0x" + x.toString(16).padStart(64, "0");
export const toBuf = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
export const big = (b: Uint8Array): bigint => BigInt("0x" + Buffer.from(b).toString("hex"));
export const hx = (b: Uint8Array): string => "0x" + Buffer.from(b).toString("hex");
export const concat = (...a: Uint8Array[]): Uint8Array => {
  const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o;
};
export const wsl = (cmd: string): string =>
  execFileSync("wsl", ["-e", "bash", "-lc", `${PATHENV}; ${cmd}`], { encoding: "utf8", maxBuffer: 64 << 20 });

// ---- circuit registry ------------------------------------------------------
export type Circuit = "shield" | "transfer" | "withdraw" | "split" | "merge";
export const OP: Record<Circuit, number> = { shield: 1, transfer: 2, withdraw: 3, split: 4, merge: 5 };
/** nargo package name -> zk/circuits/sip10/<c>/target/<pkg>.json */
export const PKG: Record<Circuit, string> = {
  shield: "sip10_shield_note", transfer: "sip10_transfer_note", withdraw: "sip10_withdraw_note",
  split: "sip10_split_note", merge: "sip10_merge_note",
};
const ENV_PREFIX: Record<Circuit, string> = {
  shield: "SHIELD", transfer: "TRANSFER", withdraw: "WITHDRAW", split: "SPLIT", merge: "MERGE",
};
/** The zkVerify-assigned vk hash per circuit, from .env.deploy (register step). */
export const zkvVk = (deployEnv: Record<string, string>, c: Circuit): string => {
  const v = deployEnv[`${ENV_PREFIX[c]}_ZKV_VKEY_HASH`];
  if (!v) throw new Error(`.env.deploy missing ${ENV_PREFIX[c]}_ZKV_VKEY_HASH`);
  return v;
};
// zkVerify statement-leaf constants (same pallet + proof system as STX).
export const CTX = keccak_256(new TextEncoder().encode("ultrahonk"));
export const VERSION = toBuf("0x55b52ad2b4153c872e27d688f567c1406f0d93b5528dd2b0bf2a9a40df97f1f9");

// ---- SIP-10 asset + note crypto --------------------------------------------
/** asset_id field element for a token contract principal ("ADDR.name"). */
export const assetIdBig = (tokenPrincipal: string): bigint => big(fePrincipal(tokenPrincipal));
export const assetIdHex = (tokenPrincipal: string): string => hexOf(assetIdBig(tokenPrincipal));

export interface Note { amount: bigint; pkX: bigint; pkY: bigint; blinding: bigint; leaf?: number; }
/** SIP-10 asset-bound commitment: Poseidon2([Poseidon4([amt,pkx,pky,bl]), asset_id]). */
export const commitmentOf = (n: Note, assetId: bigint): bigint =>
  BigInt(poseidon2([BigInt(poseidon4([n.amount, n.pkX, n.pkY, n.blinding])), assetId]));
export const ownerCommitmentOf = (n: Note): bigint => BigInt(poseidon2([n.pkX, n.pkY]));
export const nullifierOf = (commitment: bigint, sk: bigint): bigint => BigInt(poseidon2([commitment, sk]));

// ---- Grumpkin keys (keygen circuit -> matches assert_owner) ----------------
export const grumpkinPk = (sk: bigint): { x: bigint; y: bigint } => {
  writeFileSync("zk/circuits/keygen/Prover.toml", `owner_sk = "${sk}"\n`);
  const o = wsl(`cd ${REPO}/zk/circuits/keygen && nargo execute 2>&1 | grep "Circuit output"`);
  const m = o.match(/\[(0x[0-9a-f]+), (0x[0-9a-f]+)\]/i);
  if (!m) throw new Error("keygen failed: " + o.slice(0, 200));
  return { x: BigInt(m[1]!), y: BigInt(m[2]!) };
};

// ---- Prover.toml helpers ---------------------------------------------------
export const arr = (xs: string[]): string => "[" + xs.map((x) => `"${x}"`).join(", ") + "]";
export const noteToml = (label: string, n: Note): string =>
  [`[${label}]`, `amount = "${n.amount}"`, `owner_pk_x = "${n.pkX}"`, `owner_pk_y = "${n.pkY}"`, `blinding = "${n.blinding}"`].join("\n");
export const bitsToml = (indexBits: boolean[]): string => arr(indexBits.map((b) => (b ? "1" : "0")));
export const sibsToml = (siblings: Uint8Array[]): string => arr(siblings.map((s) => hexOf(big(s))));

// ---- proof generation (WSL: nargo execute + bb prove -t evm) ----------------
export const prove = (c: Circuit, proverToml: string): void => {
  const dir = `zk/circuits/sip10/${c}`;
  writeFileSync(`${dir}/Prover.toml`, proverToml + "\n");
  wsl(`cd ${REPO}/${dir} && nargo execute witness && bb prove -b target/${PKG[c]}.json -w target/witness.gz -k target/vk/vk -o target/proofout -t evm`);
  const v = wsl(`cd ${REPO}/${dir} && bb verify -k target/vk/vk -p target/proofout/proof -i target/proofout/public_inputs -t evm 2>&1 | tail -1`);
  if (!/verified successfully/i.test(v)) throw new Error(`${c} proof failed local verify: ${v.trim()}`);
};

// ---- zkVerify: submit -> verify leaf == statement -> aggregate -> path ------
export interface Inc { domainId: number; aggregationId: number; root: string; leaves: number; path: string[]; leafIndex: number; statement: string; }

// zkVerify's domain-0 aggregation is published on the domain's own schedule, not
// on demand, so the wait time is variable. The STX scripts used a single 8-min
// wait; on a quiet domain that can time out and DISCARD a paid+verified proof.
// We wait longer and retry the receipt subscription, so a slow aggregation is
// tolerated rather than thrown away. Tunable via env for very slow windows.
const AGG_ATTEMPTS = Number(process.env.SIP10_AGG_ATTEMPTS ?? 12);        // publish retries
const AGG_RETRY_MS = Number(process.env.SIP10_AGG_RETRY_MS ?? 15_000);    // delay between them
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Our size-1 domain never auto-publishes (that is the hang seen on domain 0 too):
// on an Untrusted domain someone must call `aggregate(domain, aggId)` to publish
// the completed batch. We own it, so we publish it ourselves. `aggregate` returns
// the block the aggregation landed in, which feeds getAggregateStatementPath
// directly — no fragile websocket receipt subscription. The aggregation may need
// a moment after verify() to become "complete", so we retry. If it auto-published
// (a receipt already exists), we fall back to the receipt for the block hash.
const publishAndPath = async (session: any, domainId: number, aggregationId: number, statement: string): Promise<any> => {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= AGG_ATTEMPTS; attempt++) {
    try {
      const info = await session.aggregate(domainId, aggregationId).transactionResult;
      return await session.getAggregateStatementPath(info.blockHash, domainId, aggregationId, statement);
    } catch (e) {
      lastErr = e;
      // maybe it already published on its own — try to grab the receipt block hash.
      try {
        const receipt = await session.waitForAggregationReceipt(domainId, aggregationId, 30_000);
        return await session.getAggregateStatementPath(receipt.blockHash, domainId, aggregationId, statement);
      } catch { /* not published yet */ }
      console.log(`      publish attempt ${attempt}/${AGG_ATTEMPTS} not ready (${(e instanceof Error ? e.message : String(e)).slice(0, 90)}); retrying in ${AGG_RETRY_MS / 1000}s...`);
      await sleep(AGG_RETRY_MS);
    }
  }
  throw new Error(`could not publish aggregation ${domainId}/${aggregationId} after ${AGG_ATTEMPTS} attempts: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
};

// Register a DEDICATED aggregation domain with aggregationSize=1, so every proof
// publishes its own aggregation immediately. The shared public domain 0 only
// publishes when its batch fills / on its own schedule, which stalls a single
// isolated proof (both earlier runs hung on the same unpublished domain-0 batch).
// Owning a size-1 domain removes that dependency. Returns the new domain id.
export const registerFastDomain = async (session: any, zk: any): Promise<number> => {
  const opts = {
    destination: zk.Destination.None,
    aggregateRules: zk.AggregateSecurityRules.Untrusted,
    proofSecurityRules: zk.ProofSecurityRules.Untrusted, // required for zkVerify runtime >= 1.3.0
  };
  const info = await session.registerDomain(1, undefined, opts).transactionResult;
  const domainId = Number(info.domainId);
  if (!Number.isFinite(domainId)) throw new Error(`registerDomain returned no domainId: ${JSON.stringify(info)}`);
  console.log(`  [zkVerify] registered fast domain ${domainId} (aggregationSize=1)`);
  return domainId;
};
export const unregisterFastDomain = async (session: any, domainId: number): Promise<void> => {
  try { await session.holdDomain(domainId).transactionResult; } catch { /* may already be held/empty */ }
  try { await session.unregisterDomain(domainId).transactionResult; console.log(`  [zkVerify] unregistered domain ${domainId}`); } catch { /* best-effort reclaim */ }
};

export const aggregate = async (session: any, zk: any, deployEnv: Record<string, string>, c: Circuit, domainId: number): Promise<Inc> => {
  const dir = `zk/circuits/sip10/${c}`;
  const pub = readFileSync(`${dir}/target/proofout/public_inputs`);
  const proof = hx(readFileSync(`${dir}/target/proofout/proof`));
  const vk = hx(readFileSync(`${dir}/target/vk/vk`));
  const signals: string[] = [];
  for (let i = 0; i < pub.length; i += 32) signals.push(hx(pub.subarray(i, i + 32)));
  const { transactionResult } = await session.verify()
    .ultrahonk({ version: zk.UltrahonkVersion.V3_0, variant: zk.UltrahonkVariant.ZK })
    .execute({ proofData: { proof, publicSignals: signals, vk }, domainId });
  const sub = await transactionResult;
  // our contract-side leaf must equal zkVerify's statement (fail before paying)
  const leaf = hx(keccak_256(concat(CTX, toBuf(zkvVk(deployEnv, c)), VERSION, keccak_256(pub))));
  if (leaf !== sub.statement) throw new Error(`${c} statement mismatch: local ${leaf} vs zkVerify ${sub.statement}`);
  console.log(`      zkVerify verified ${c} (domain ${domainId}, agg ${sub.aggregationId}), leaf==statement OK — publishing aggregation...`);
  const path = await publishAndPath(session, domainId, sub.aggregationId, sub.statement);
  return { domainId, aggregationId: sub.aggregationId, root: path.root, leaves: path.numberOfLeaves, path: path.proof, leafIndex: path.leafIndex, statement: sub.statement };
};
/** trailing aggregation args shared by every pool op: domain, agg-id, path, leaf-index. */
export const incArgs = (i: Inc) => [Cl.uint(i.domainId), Cl.uint(i.aggregationId), Cl.list(i.path.map((p) => Cl.buffer(toBuf(p)))), Cl.uint(i.leafIndex)];

// ---- token trait arg + reads -----------------------------------------------
/** "ADDR.name" -> contract-principal Clarity value for the <sip-010-trait> arg. */
export const tokenArg = (tokenPrincipal: string) => {
  const [addr, name] = tokenPrincipal.split(".");
  if (!addr || !name) throw new Error(`bad token principal: ${tokenPrincipal}`);
  return Cl.contractPrincipal(addr, name);
};
export const tokenBalance = async (tokenPrincipal: string, owner: string): Promise<bigint> => {
  const [addr, name] = tokenPrincipal.split(".");
  const res = await fetch(`${API}/v2/contracts/call-read/${addr}/${name}/get-balance`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: owner, arguments: [cvToHexArg(Cl.principal(owner))] }),
  });
  const j = (await res.json()) as { result?: string; okay?: boolean };
  if (!j.result) throw new Error(`get-balance failed for ${tokenPrincipal}: ${JSON.stringify(j)}`);
  const cv = cvToJSON(hexToCV(j.result)) as any;
  return BigInt(cv.value?.value ?? cv.value); // (ok uint)
};

// ---- Stacks call plumbing --------------------------------------------------
export interface Signer { key: string; address: string; }
export const signer = async (mnemonic: string): Promise<Signer> => {
  const w = await generateWallet({ secretKey: mnemonic, password: "" });
  const a = w.accounts[0]!;
  return { key: a.stxPrivateKey, address: getStxAddress({ account: a, network: "testnet" }) };
};
export const nextNonce = async (address: string): Promise<bigint> =>
  BigInt((await (await fetch(`${API}/extended/v1/address/${address}/nonces`)).json() as any).possible_next_nonce);

const cvToHexArg = (cv: Parameters<typeof cvToHex>[0]): string => cvToHex(cv);

const broadcastAndWait = async (from: Signer, deployer: string, contract: string, fn: string, args: any[]) => {
  const tx = await makeContractCall({
    contractAddress: deployer, contractName: contract, functionName: fn, functionArgs: args,
    senderKey: from.key, network: "testnet", postConditionMode: PostConditionMode.Allow, fee: 30_000n, nonce: await nextNonce(from.address),
  });
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
/** Broadcast and require success; returns txid or throws with the abort repr. */
export const stacks = async (from: Signer, deployer: string, contract: string, fn: string, args: any[]): Promise<string> => {
  const r = await broadcastAndWait(from, deployer, contract, fn, args);
  if (r.status !== "success") throw new Error(`${fn} aborted: ${r.repr} (${r.txid})`);
  return r.txid;
};
/** Broadcast and EXPECT an abort (attack tests); returns whether it aborted. */
export const stacksExpectAbort = async (from: Signer, deployer: string, contract: string, fn: string, args: any[]): Promise<{ aborted: boolean; repr: string; txid: string }> => {
  const r = await broadcastAndWait(from, deployer, contract, fn, args);
  return { aborted: r.status === "abort", repr: r.repr, txid: r.txid };
};

// ---- read-only registry / pool reads ---------------------------------------
const callReadUint = async (deployer: string, contract: string, fn: string, args: string[] = []): Promise<bigint> => {
  const res = await fetch(`${API}/v2/contracts/call-read/${deployer}/${contract}/${fn}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: deployer, arguments: args }),
  });
  const cv = cvToJSON(hexToCV((await res.json() as any).result)) as any;
  return BigInt(cv.value?.value ?? cv.value);
};
export const currentRoot = async (deployer: string): Promise<string> => {
  const res = await fetch(`${API}/v2/contracts/call-read/${deployer}/privacy-registry/get-current-root`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: deployer, arguments: [] }),
  });
  return (cvToJSON(hexToCV((await res.json() as any).result)) as any).value.root.value as string;
};
export const shieldedTotal = (deployer: string, assetUid: number): Promise<bigint> =>
  callReadUint(deployer, "sip10-pool", "get-shielded-total", [cvToHexArg(Cl.uint(assetUid))]);
export const stxBalance = async (address: string): Promise<bigint> => {
  const res = await fetch(`${API}/extended/v1/address/${address}/balances`);
  if (!res.ok) return 0n;
  return BigInt((await res.json() as any).stx.balance);
};

// ---- STX gas funding (users need tSTX for fees) ----------------------------
export const waitForTx = async (txid: string, label: string): Promise<void> => {
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
export const fundStxIfLow = async (funder: Signer, target: string, minMicro: bigint, topUpMicro: bigint): Promise<void> => {
  const b = await stxBalance(target);
  if (b >= minMicro) { console.log(`   ${target}: ${Number(b) / 1e6} STX (ok)`); return; }
  console.log(`   funding ${target} with ${Number(topUpMicro) / 1e6} STX for gas...`);
  const tx = await makeSTXTokenTransfer({ recipient: target, amount: topUpMicro, senderKey: funder.key, network: "testnet", fee: 3000n, nonce: await nextNonce(funder.address) });
  const r = await broadcastTransaction({ transaction: tx, network: "testnet" });
  await waitForTx((r as { txid: string }).txid, `fund ${target}`);
};

// ---- environment / actors --------------------------------------------------
export interface Env {
  deployer: string;
  deployEnv: Record<string, string>;
  testnetEnv: Record<string, string>;
  users: Record<string, string>;
}
export const loadAll = (): Env => {
  const deployEnv = loadEnv(".env.deploy");
  const testnetEnv = loadEnv(".env.testnet");
  const users = loadEnv(".env.users");
  const deployer = deployEnv.NEW_DEPLOYER_ADDRESS ?? "ST2HXRZ8A82JJAP14KD83JEXNRCF34J67088WJSJH";
  return { deployer, deployEnv, testnetEnv, users };
};
export const openSession = async (testnetEnv: Record<string, string>) => {
  const zk = await import("zkverifyjs");
  const seed = testnetEnv.ZKVERIFY_SEED_PHRASE;
  if (!seed) throw new Error(".env.testnet missing ZKVERIFY_SEED_PHRASE");
  const session = await zk.zkVerifySession.start().Volta().withAccount(seed);
  return { session, zk };
};

// =============================================================================
// Operation helpers -- one correct implementation of each SIP-10 flow, shared by
// every test script. Each threads the off-chain CommitmentTree (mirror of the
// shared registry) and keeps `onChainRoot` in lockstep: prove against the current
// tree root, aggregate, insert the new leaf/leaves, then submit with
// current-root/new-root. The first op in any run must be a shield (membership-free)
// so the on-chain root syncs to the off-chain tree.
// =============================================================================
export interface Ctx {
  deployer: string; deployEnv: Record<string, string>;
  session: any; zk: any; relay: Signer; domainId: number;
  tree: CommitmentTree; onChainRoot: string;
}
export const meta = (i: number): Uint8Array => toBuf(hexOf(BigInt(1000 + i)));
export const blinding = (i: number): bigint => (BigInt(i) * 7919n + 101n) % 2n ** 240n;

export const relayAgg = (ctx: Ctx, inc: Inc): Promise<string> =>
  stacks(ctx.relay, ctx.deployer, "sip10-zk-verifier", "submit-aggregation",
    [Cl.uint(inc.domainId), Cl.uint(inc.aggregationId), Cl.buffer(toBuf(inc.root)), Cl.uint(inc.leaves)]);

/** Shield: create a note for `owner`, deposit `amount` of the token into the pool. */
export const doShield = async (ctx: Ctx, from: Signer, owner: { x: bigint; y: bigint }, token: string, assetId: bigint, amount: bigint, tag: number): Promise<Note> => {
  const n: Note = { amount, pkX: owner.x, pkY: owner.y, blinding: blinding(tag) };
  const c = commitmentOf(n, assetId), oc = ownerCommitmentOf(n);
  n.leaf = ctx.tree.insert(toBuf(hexOf(c)));
  const newRoot = hx(ctx.tree.root);
  console.log(`  [shield] ${from.address.slice(0, 8)}… deposits ${amount} (tag ${tag})...`);
  prove("shield", [`op = "1"`, `commitment = "${hexOf(c)}"`, `owner_commitment = "${hexOf(oc)}"`,
    `amount = "${amount}"`, `asset_id = "${hexOf(assetId)}"`, `circuit_version = "1"`, ``, noteToml("note", n)].join("\n"));
  const inc = await aggregate(ctx.session, ctx.zk, ctx.deployEnv, "shield", ctx.domainId);
  await relayAgg(ctx, inc);
  const tx = await stacks(from, ctx.deployer, "sip10-pool", "shield",
    [tokenArg(token), Cl.uint(amount), Cl.buffer(toBuf(hexOf(c))), Cl.buffer(toBuf(hexOf(oc))), Cl.buffer(meta(tag)),
     Cl.buffer(toBuf(ctx.onChainRoot)), Cl.buffer(toBuf(newRoot)), ...incArgs(inc)]);
  ctx.onChainRoot = newRoot;
  console.log("     shield tx:", tx);
  return n;
};

// PRIVACY: transfer/split/merge/withdraw are submitted by the RELAYER, not the
// note owner, so on-chain the tx caller is only ever the relayer — the user is
// never linked to a private operation. The zkSNARK (not tx-sender) authorizes
// the op, and none of these pay tokens TO the caller (withdraw pays the
// proof-bound recipient from the pool), so relaying is safe. Only `shield` (a
// deposit of the user's own tokens) is necessarily user-signed.

/** Transfer: spend `input` (owned by inSk), create one note for `owner`. Relayed. */
export const doTransfer = async (ctx: Ctx, input: Note, inSk: bigint, owner: { x: bigint; y: bigint }, token: string, assetId: bigint, tag: number): Promise<Note> => {
  const inC = commitmentOf(input, assetId);
  const out: Note = { amount: input.amount, pkX: owner.x, pkY: owner.y, blinding: blinding(tag) };
  const oc2 = commitmentOf(out, assetId), ooc = ownerCommitmentOf(out);
  const nf = nullifierOf(inC, inSk);
  const p = ctx.tree.proof(input.leaf!);
  console.log(`  [transfer] relayer moves note (tag ${tag})...`);
  prove("transfer", [`op = "2"`, `nullifier = "${hexOf(nf)}"`, `new_commitment = "${hexOf(oc2)}"`,
    `new_owner_commitment = "${hexOf(ooc)}"`, `merkle_root = "${hexOf(big(ctx.tree.root))}"`, `asset_id = "${hexOf(assetId)}"`,
    `circuit_version = "1"`, `owner_sk = "${inSk}"`, `merkle_index = ${bitsToml(p.indexBits)}`, `merkle_siblings = ${sibsToml(p.siblings)}`,
    ``, noteToml("input", input), ``, noteToml("output", out)].join("\n"));
  const inc = await aggregate(ctx.session, ctx.zk, ctx.deployEnv, "transfer", ctx.domainId);
  await relayAgg(ctx, inc);
  out.leaf = ctx.tree.insert(toBuf(hexOf(oc2)));
  const newRoot = hx(ctx.tree.root);
  const tx = await stacks(ctx.relay, ctx.deployer, "sip10-pool", "transfer",
    [tokenArg(token), Cl.buffer(toBuf(hexOf(nf))), Cl.buffer(toBuf(hexOf(oc2))), Cl.buffer(toBuf(hexOf(ooc))), Cl.buffer(meta(tag)),
     Cl.buffer(toBuf(ctx.onChainRoot)), Cl.buffer(toBuf(newRoot)), ...incArgs(inc)]);
  ctx.onChainRoot = newRoot;
  console.log("     transfer tx (relayer):", tx);
  return out;
};

/** Split: spend `input`, create two notes for `owner` summing to input.amount. Relayed. */
export const doSplit = async (ctx: Ctx, input: Note, inSk: bigint, owner: { x: bigint; y: bigint }, token: string, assetId: bigint, a1: bigint, a2: bigint, tag: number): Promise<[Note, Note]> => {
  const inC = commitmentOf(input, assetId);
  const o1: Note = { amount: a1, pkX: owner.x, pkY: owner.y, blinding: blinding(tag) };
  const o2: Note = { amount: a2, pkX: owner.x, pkY: owner.y, blinding: blinding(tag + 1) };
  const c1 = commitmentOf(o1, assetId), oc1 = ownerCommitmentOf(o1);
  const c2 = commitmentOf(o2, assetId), oc2 = ownerCommitmentOf(o2);
  const nf = nullifierOf(inC, inSk);
  const p = ctx.tree.proof(input.leaf!);
  console.log(`  [split] relayer ${input.amount} -> ${a1} + ${a2}...`);
  prove("split", [`op = "4"`, `nullifier = "${hexOf(nf)}"`, `commitment_1 = "${hexOf(c1)}"`, `owner_commitment_1 = "${hexOf(oc1)}"`,
    `commitment_2 = "${hexOf(c2)}"`, `owner_commitment_2 = "${hexOf(oc2)}"`, `merkle_root = "${hexOf(big(ctx.tree.root))}"`,
    `asset_id = "${hexOf(assetId)}"`, `circuit_version = "1"`, `owner_sk = "${inSk}"`,
    `merkle_index = ${bitsToml(p.indexBits)}`, `merkle_siblings = ${sibsToml(p.siblings)}`,
    ``, noteToml("input", input), ``, noteToml("out_1", o1), ``, noteToml("out_2", o2)].join("\n"));
  const inc = await aggregate(ctx.session, ctx.zk, ctx.deployEnv, "split", ctx.domainId);
  await relayAgg(ctx, inc);
  o1.leaf = ctx.tree.insert(toBuf(hexOf(c1))); o2.leaf = ctx.tree.insert(toBuf(hexOf(c2)));
  const newRoot = hx(ctx.tree.root);
  const tx = await stacks(ctx.relay, ctx.deployer, "sip10-pool", "split",
    [tokenArg(token), Cl.buffer(toBuf(hexOf(nf))), Cl.buffer(toBuf(hexOf(c1))), Cl.buffer(toBuf(hexOf(oc1))), Cl.buffer(meta(tag)),
     Cl.buffer(toBuf(hexOf(c2))), Cl.buffer(toBuf(hexOf(oc2))), Cl.buffer(meta(tag + 1)),
     Cl.buffer(toBuf(ctx.onChainRoot)), Cl.buffer(toBuf(newRoot)), ...incArgs(inc)]);
  ctx.onChainRoot = newRoot;
  console.log("     split tx (relayer):", tx);
  return [o1, o2];
};

/** Merge: spend two notes (same owner/sk), create one note summing them. Relayed. */
export const doMerge = async (ctx: Ctx, i1: Note, i2: Note, inSk: bigint, owner: { x: bigint; y: bigint }, token: string, assetId: bigint, tag: number): Promise<Note> => {
  const c1 = commitmentOf(i1, assetId), c2 = commitmentOf(i2, assetId);
  const out: Note = { amount: i1.amount + i2.amount, pkX: owner.x, pkY: owner.y, blinding: blinding(tag) };
  const oc = commitmentOf(out, assetId), ooc = ownerCommitmentOf(out);
  const nf1 = nullifierOf(c1, inSk), nf2 = nullifierOf(c2, inSk);
  const p1 = ctx.tree.proof(i1.leaf!), p2 = ctx.tree.proof(i2.leaf!);
  console.log(`  [merge] relayer ${i1.amount} + ${i2.amount} -> ${out.amount}...`);
  prove("merge", [`op = "5"`, `nullifier_1 = "${hexOf(nf1)}"`, `nullifier_2 = "${hexOf(nf2)}"`, `commitment = "${hexOf(oc)}"`,
    `owner_commitment = "${hexOf(ooc)}"`, `merkle_root = "${hexOf(big(ctx.tree.root))}"`, `asset_id = "${hexOf(assetId)}"`,
    `circuit_version = "1"`, `owner_sk_1 = "${inSk}"`, `merkle_index_1 = ${bitsToml(p1.indexBits)}`, `merkle_siblings_1 = ${sibsToml(p1.siblings)}`,
    `owner_sk_2 = "${inSk}"`, `merkle_index_2 = ${bitsToml(p2.indexBits)}`, `merkle_siblings_2 = ${sibsToml(p2.siblings)}`,
    ``, noteToml("input_1", i1), ``, noteToml("input_2", i2), ``, noteToml("output", out)].join("\n"));
  const inc = await aggregate(ctx.session, ctx.zk, ctx.deployEnv, "merge", ctx.domainId);
  await relayAgg(ctx, inc);
  out.leaf = ctx.tree.insert(toBuf(hexOf(oc)));
  const newRoot = hx(ctx.tree.root);
  const tx = await stacks(ctx.relay, ctx.deployer, "sip10-pool", "merge-notes",
    [tokenArg(token), Cl.buffer(toBuf(hexOf(nf1))), Cl.buffer(toBuf(hexOf(nf2))), Cl.buffer(toBuf(hexOf(oc))), Cl.buffer(toBuf(hexOf(ooc))),
     Cl.buffer(meta(tag)), Cl.buffer(toBuf(ctx.onChainRoot)), Cl.buffer(toBuf(newRoot)), ...incArgs(inc)]);
  ctx.onChainRoot = newRoot;
  console.log("     merge tx (relayer):", tx);
  return out;
};

/** Withdraw: spend `note`, pay its amount of the token out to `recipient`. Relayed. */
export const doWithdraw = async (ctx: Ctx, note: Note, inSk: bigint, recipient: string, token: string, assetId: bigint): Promise<{ nf: bigint; inc: Inc; root: string }> => {
  const c = commitmentOf(note, assetId);
  const nf = nullifierOf(c, inSk);
  const p = ctx.tree.proof(note.leaf!);
  const root = ctx.onChainRoot;
  console.log(`  [withdraw] relayer pays ${note.amount} -> ${recipient.slice(0, 10)}…...`);
  prove("withdraw", [`op = "3"`, `nullifier = "${hexOf(nf)}"`, `amount = "${note.amount}"`,
    `recipient_hash = "${hexOf(big(fePrincipal(recipient)))}"`, `merkle_root = "${hexOf(big(toBuf(root)))}"`,
    `asset_id = "${hexOf(assetId)}"`, `circuit_version = "1"`, `owner_sk = "${inSk}"`,
    `merkle_index = ${bitsToml(p.indexBits)}`, `merkle_siblings = ${sibsToml(p.siblings)}`, ``, noteToml("input", note)].join("\n"));
  const inc = await aggregate(ctx.session, ctx.zk, ctx.deployEnv, "withdraw", ctx.domainId);
  await relayAgg(ctx, inc);
  const tx = await stacks(ctx.relay, ctx.deployer, "sip10-pool", "withdraw",
    [tokenArg(token), Cl.buffer(toBuf(hexOf(nf))), Cl.uint(note.amount), Cl.principal(recipient), Cl.buffer(toBuf(root)), ...incArgs(inc)]);
  console.log("     withdraw tx (relayer):", tx);
  return { nf, inc, root };
};
