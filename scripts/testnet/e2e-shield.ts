// =============================================================================
// STX Shield -- real end-to-end shield on Stacks Testnet
// =============================================================================
//   npx tsx scripts/testnet/e2e-shield.ts <userMnemonic> <amountMicroStx> <seed>
//
// The FIRST real private operation, with no mocks, shortcuts, or self-attested
// aggregations. Every step is genuine:
//
//   1. derive a note (Poseidon commitment) for `amount`
//   2. generate a real UltraHonk proof with Noir + Barretenberg
//   3. submit it to zkVerify Volta (real verification)
//   4. wait for the domain to aggregate it (real Merkle tree)
//   5. relay the aggregation root to the deployed Stacks zk-verifier
//   6. the user submits pool.shield with the real inclusion path
//   7. real STX moves into the pool, gated only by the zk proof
//
// Requires the corrected deployment (Substrate-exact Merkle verification) and
// the ZK toolchain (nargo + bb) under WSL. Reads the deployer/relayer key from
// .env.deploy and the zkVerify account from .env.testnet.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  Cl,
  broadcastTransaction,
  makeContractCall,
  PostConditionMode,
} from "@stacks/transactions";
import { generateWallet, getStxAddress } from "@stacks/wallet-sdk";
import { poseidon2, poseidon4 } from "poseidon-lite";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { loadEnv, loadClarinetApiUrl } from "../deployment/config.js";

const API = loadClarinetApiUrl("testnet") ?? "https://api.testnet.hiro.so";
const WSL_PATH = "export PATH=$HOME/.nargo/bin:$HOME/.bb:$PATH";
const REPO = "/mnt/g/2026/Blockchain/Stacks/stx-shield";

const hexOf = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");
const toBuf = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const feUint = (n: bigint) => {
  const b = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0 && x > 0n; i--) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
};
const concat = (...a: Uint8Array[]) => {
  const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let i = 0;
  for (const x of a) {
    o.set(x, i);
    i += x.length;
  }
  return o;
};

const deployEnv = () => {
  const t = readFileSync("deployments/testnet/addresses.json", "utf8");
  return JSON.parse(t) as { deployer: string };
};

const wsl = (cmd: string) =>
  execFileSync("wsl", ["-e", "bash", "-lc", `${WSL_PATH}; ${cmd}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

const main = async (): Promise<number> => {
  const [userMnemonic, amountStr, seedStr] = process.argv.slice(2);
  if (!userMnemonic || !amountStr) {
    console.error("usage: e2e-shield.ts <userMnemonic> <amountMicroStx> [seed]");
    return 1;
  }
  const amount = BigInt(amountStr);
  const seed = BigInt(seedStr ?? Date.now());
  const env = loadEnv(".env.testnet");
  const { deployer } = deployEnv();
  const CV = 1;

  // -- 1. derive the note (Poseidon commitment matches the circuit) --------
  const ownerSk = seed % (2n ** 250n);
  const ownerPkX = (seed * 7n + 1n) % (2n ** 250n);
  const ownerPkY = (seed * 11n + 3n) % (2n ** 250n);
  const blinding = (seed * 13n + 5n) % (2n ** 250n);
  const commitment = BigInt(poseidon4([amount, ownerPkX, ownerPkY, blinding]));
  const ownerCommitment = BigInt(poseidon2([ownerPkX, ownerPkY]));
  console.log("[1] note derived");
  console.log("    commitment:", hexOf(commitment).slice(0, 20) + "...");

  // -- 2. generate a real UltraHonk proof ----------------------------------
  console.log("[2] generating Noir witness + UltraHonk proof (WSL)...");
  const prover = [
    `op = "1"`,
    `commitment = "${hexOf(commitment)}"`,
    `owner_commitment = "${hexOf(ownerCommitment)}"`,
    `amount = "${amount}"`,
    `circuit_version = "1"`,
    ``,
    `[note]`,
    `amount = "${amount}"`,
    `owner_pk_x = "${ownerPkX}"`,
    `owner_pk_y = "${ownerPkY}"`,
    `blinding = "${blinding}"`,
  ].join("\n");
  writeFileSync("zk/circuits/shield/Prover.toml", prover + "\n");
  wsl(`cd ${REPO}/zk/circuits/shield && nargo execute witness`);
  // -k binds the proof to the registered vk; -t evm = keccak transcript + ZK,
  // matching zkVerify's UltraHonk V3_0 pallet.
  wsl(
    `cd ${REPO}/zk/circuits/shield && bb prove -b target/shield_note.json -w target/witness.gz -k target/vk/vk -o target/proofout -t evm`,
  );
  // fail fast: the proof must verify locally against the exact vk we submit
  const localVerify = wsl(
    `cd ${REPO}/zk/circuits/shield && bb verify -k target/vk/vk -p target/proofout/proof -i target/proofout/public_inputs -t evm 2>&1 | tail -1`,
  );
  if (!/verified successfully/i.test(localVerify)) {
    console.error("    local proof verification failed:", localVerify.trim());
    return 1;
  }
  console.log("    proof verifies locally against vk ✓");
  const proofDir = "zk/circuits/shield/target/proofout";
  const proof = "0x" + Buffer.from(readFileSync(`${proofDir}/proof`)).toString("hex");
  const pubBytes = readFileSync(`${proofDir}/public_inputs`);
  const publicSignals: string[] = [];
  for (let i = 0; i < pubBytes.length; i += 32) {
    publicSignals.push("0x" + Buffer.from(pubBytes.subarray(i, i + 32)).toString("hex"));
  }
  const vk = "0x" + Buffer.from(readFileSync("zk/circuits/shield/target/vk/vk")).toString("hex");
  console.log("    proof generated, size", (proof.length - 2) / 2, "bytes");

  // -- 3-4. submit to zkVerify, aggregate, fetch path ----------------------
  console.log("[3] submitting to zkVerify Volta + aggregating...");
  const mod: any = await import("zkverifyjs");
  const session = await mod.zkVerifySession.start().Volta().withAccount(env.ZKVERIFY_SEED_PHRASE!);
  const DOMAIN = 0;
  const { transactionResult } = await session
    .verify()
    .ultrahonk({ version: mod.UltrahonkVersion.V3_0, variant: mod.UltrahonkVariant.ZK })
    .execute({ proofData: { proof, publicSignals, vk }, domainId: DOMAIN });
  const sub = await transactionResult;
  console.log("    verified. statement:", sub.statement.slice(0, 20) + "...", "agg:", sub.aggregationId);
  console.log("[4] waiting for aggregation receipt (up to 8 min)...");
  const receipt = await session.waitForAggregationReceipt(DOMAIN, sub.aggregationId, 480_000);
  const path = await session.getAggregateStatementPath(
    receipt.blockHash,
    DOMAIN,
    sub.aggregationId,
    sub.statement,
  );
  await session.close();
  console.log("    aggregated. root:", path.root.slice(0, 20) + "...", "leaves:", path.numberOfLeaves);

  // sanity: our contract-side leaf must equal zkVerify's statement
  const ctxHash = keccak_256(new TextEncoder().encode("ultrahonk"));
  const zkvVk = toBuf("0x96889d2466624e271b44d4e32ac8b557bdfdc922a1a16dc42f5c807f2dcacad8");
  const versionHash = toBuf("0x55b52ad2b4153c872e27d688f567c1406f0d93b5528dd2b0bf2a9a40df97f1f9");
  const pih = keccak_256(pubBytes);
  const leaf = keccak_256(concat(ctxHash, zkvVk, versionHash, pih));
  const localStatement = "0x" + Buffer.from(leaf).toString("hex");
  if (localStatement !== sub.statement) {
    console.error("    LEAF MISMATCH — local", localStatement, "!=", sub.statement);
    return 1;
  }
  console.log("    local statement == zkVerify statement ✓");

  // -- 5. relay the aggregation root to Stacks (as deployer/relayer) --------
  console.log("[5] relaying aggregation root to Stacks zk-verifier...");
  const relayer = await signer(readDeployMnemonic());
  await stacksCall(relayer, deployer, "zk-verifier", "submit-aggregation", [
    Cl.uint(DOMAIN),
    Cl.uint(sub.aggregationId),
    Cl.buffer(toBuf(path.root)),
    Cl.uint(path.numberOfLeaves),
  ]);

  // -- 6. the USER submits the shield with the real inclusion path ---------
  console.log("[6] user submits pool.shield with the real inclusion path...");
  const currentRoot = await readCurrentRoot(deployer);
  const newRoot = hexOf(commitment); // any distinct non-zero value; not bound
  const user = await signer(userMnemonic);
  const before = await poolBalance(deployer);
  const shieldTx = await stacksCall(user, deployer, "privacy-pool", "shield", [
    Cl.uint(amount),
    Cl.buffer(toBuf(hexOf(commitment))),
    Cl.buffer(toBuf(hexOf(ownerCommitment))),
    Cl.buffer(toBuf(hexOf(seed))), // metadata (opaque, not bound)
    Cl.buffer(toBuf(currentRoot)),
    Cl.buffer(toBuf(newRoot)),
    Cl.uint(DOMAIN),
    Cl.uint(sub.aggregationId),
    Cl.list(path.proof.map((p: string) => Cl.buffer(toBuf(p)))),
    Cl.uint(path.leafIndex),
  ]);
  console.log("    shield tx:", shieldTx);

  // -- 7. confirm STX moved into the pool ----------------------------------
  const after = await poolBalance(deployer);
  console.log("[7] pool balance:", Number(before) / 1e6, "->", Number(after) / 1e6, "STX");
  const ok = after - before === amount;
  console.log(ok ? "\n*** REAL PRIVATE SHIELD SUCCEEDED ***" : "\nshield did not move the expected amount");
  return ok ? 0 : 1;
};

// ---- Stacks helpers --------------------------------------------------------

const readDeployMnemonic = () => {
  const t = readFileSync(".env.deploy", "utf8");
  return t.match(/NEW_DEPLOYER_MNEMONIC=(.+)/)![1]!.trim();
};

const signer = async (mnemonic: string) => {
  const w = await generateWallet({ secretKey: mnemonic, password: "" });
  const a = w.accounts[0]!;
  return { key: a.stxPrivateKey, address: getStxAddress({ account: a, network: "testnet" }) };
};

const nextNonce = async (address: string) =>
  BigInt((await (await fetch(`${API}/extended/v1/address/${address}/nonces`)).json() as any).possible_next_nonce);

const stacksCall = async (
  from: { key: string; address: string },
  deployer: string,
  contract: string,
  fn: string,
  args: ReturnType<typeof Cl.uint>[],
): Promise<string> => {
  const tx = await makeContractCall({
    contractAddress: deployer,
    contractName: contract,
    functionName: fn,
    functionArgs: args,
    senderKey: from.key,
    network: "testnet",
    postConditionMode: PostConditionMode.Allow,
    fee: 20_000,
    nonce: await nextNonce(from.address),
  });
  const r = await broadcastTransaction({ transaction: tx, network: "testnet" });
  const txid = (r as { txid: string }).txid;
  if (!txid) throw new Error(`${fn} broadcast failed: ${JSON.stringify(r)}`);
  // wait for confirmation
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/extended/v1/tx/${txid}`);
    if (res.ok) {
      const b = (await res.json()) as { tx_status: string; tx_result?: { repr: string } };
      if (b.tx_status === "success") return txid;
      if (b.tx_status.startsWith("abort")) {
        throw new Error(`${fn} aborted: ${b.tx_result?.repr ?? b.tx_status} (${txid})`);
      }
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error(`${fn} not confirmed (${txid})`);
};

const readCurrentRoot = async (deployer: string): Promise<string> => {
  const { cvToHex, hexToCV, cvToJSON } = await import("@stacks/transactions");
  const res = await fetch(
    `${API}/v2/contracts/call-read/${deployer}/privacy-registry/get-current-root`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: deployer, arguments: [] }) },
  );
  const j = (await res.json()) as { result: string };
  const cv = cvToJSON(hexToCV(j.result)) as any;
  void cvToHex;
  return cv.value.root.value as string;
};

const poolBalance = async (deployer: string): Promise<bigint> => {
  const { hexToCV, cvToJSON } = await import("@stacks/transactions");
  const res = await fetch(
    `${API}/v2/contracts/call-read/${deployer}/privacy-pool/get-pool-balance`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: deployer, arguments: [] }) },
  );
  const j = (await res.json()) as { result: string };
  return BigInt((cvToJSON(hexToCV(j.result)) as any).value);
};

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error("\nE2E failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
