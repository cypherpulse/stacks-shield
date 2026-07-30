// =============================================================================
// bb.js vs bb CLI vs zkVerify V3_0 -- compatibility validation
// =============================================================================
//   npx tsx scripts/validation/bbjs-validate.ts <circuit> [--submit]
//
// For a circuit that already has CLI artifacts on disk (target/witness.gz,
// target/vk/vk, target/proofout/{proof,public_inputs}) from the canonical
// `nargo execute` + `bb prove -t evm` path, this:
//   1. regenerates the proof with @aztec/bb.js UltraHonkBackend { verifierTarget: 'evm' }
//   2. compares vk bytes, public inputs, proof bytes against the CLI
//   3. verifies the bb.js proof locally
//   4. (optional) submits the bb.js proof to zkVerify V3_0 (ZK)
// The CLI path is NEVER modified.

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";

const CIRCUITS: Record<string, { pkg: string; zkvVk: string }> = {
  shield: { pkg: "shield_note", zkvVk: "0x96889d2466624e271b44d4e32ac8b557bdfdc922a1a16dc42f5c807f2dcacad8" },
  transfer: { pkg: "transfer_note", zkvVk: "0x3668b8b291ddf8cb0bc60bf9f3f33ce9e5af9d2de631ebd3bfb10a4455e91595" },
  split: { pkg: "split_note", zkvVk: "0x7a3fbca8876dbbd32c5977c886cc843b41b18201330a80378719b12383ec2b01" },
  merge: { pkg: "merge_note", zkvVk: "0x025d92c5d1f17b50433ab138f5f603eb64cb94b48299b5f23b9b8fcda76735de" },
  withdraw: { pkg: "withdraw_note", zkvVk: "0x5e1ad470b0b8b0094acd87360989f31c1059ba73e6613522d0b07d55e6b749de" },
};
const CTX = keccak_256(new TextEncoder().encode("ultrahonk"));
const VERSION = Uint8Array.from(Buffer.from("55b52ad2b4153c872e27d688f567c1406f0d93b5528dd2b0bf2a9a40df97f1f9", "hex"));
const hx = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const concat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

const main = async (): Promise<number> => {
  const circuit = process.argv[2];
  const doSubmit = process.argv.includes("--submit");
  if (!circuit || !CIRCUITS[circuit]) { console.error("usage: bbjs-validate.ts <shield|transfer|split|merge|withdraw> [--submit]"); return 1; }
  const { pkg, zkvVk } = CIRCUITS[circuit]!;
  const dir = `zk/circuits/${circuit}/target`;

  // ---- CLI artifacts (canonical) ----
  const program = JSON.parse(readFileSync(`${dir}/${pkg}.json`, "utf8"));
  const witness = new Uint8Array(readFileSync(`${dir}/witness.gz`));
  const cliVk = new Uint8Array(readFileSync(`${dir}/vk/vk`));
  const cliProof = new Uint8Array(readFileSync(`${dir}/proofout/proof`));
  const cliPubBytes = new Uint8Array(readFileSync(`${dir}/proofout/public_inputs`));
  const cliPub: string[] = [];
  for (let i = 0; i < cliPubBytes.length; i += 32) cliPub.push(hx(cliPubBytes.subarray(i, i + 32)));

  console.log(`\n=== ${circuit} ===`);
  console.log(`CLI: vk ${cliVk.length}B, proof ${cliProof.length}B, ${cliPub.length} public inputs`);

  // ---- bb.js ----
  // This bb.js nightly requires an explicit Barretenberg api instance passed to
  // the backend constructor (no lazy init).
  const { UltraHonkBackend, Barretenberg } = await import("@aztec/bb.js");
  const api = await Barretenberg.new({ threads: 4 });
  const backend = new UltraHonkBackend(program.bytecode, api);
  const opts = { verifierTarget: "evm" as const };

  const t0 = performance.now();
  const bbVk = await backend.getVerificationKey(opts);
  const tVk = performance.now() - t0;

  const t1 = performance.now();
  const { proof: bbProof, publicInputs: bbPub } = await backend.generateProof(witness, opts);
  const tProve = performance.now() - t1;

  const bbProofU8 = bbProof instanceof Uint8Array ? bbProof : new Uint8Array(bbProof as any);
  const memMB = Math.round(process.memoryUsage().rss / 1e6);

  // ---- comparisons ----
  const vkMatch = Buffer.compare(Buffer.from(cliVk), Buffer.from(bbVk)) === 0;
  const vkHashCli = hx(sha256(cliVk));
  const vkHashBb = hx(sha256(bbVk));
  const proofMatch = Buffer.compare(Buffer.from(cliProof), Buffer.from(bbProofU8)) === 0;
  const pubMatch = JSON.stringify(cliPub.map((p) => p.toLowerCase())) === JSON.stringify(bbPub.map((p) => p.toLowerCase()));

  console.log(`bb.js: vk ${bbVk.length}B (${(tVk / 1000).toFixed(1)}s), proof ${bbProofU8.length}B (${(tProve / 1000).toFixed(1)}s prove), rss ${memMB}MB, ${bbPub.length} public inputs`);
  console.log(`  vk bytes identical:         ${vkMatch}`);
  console.log(`  vk sha256:  CLI ${vkHashCli.slice(0, 18)}...  bb.js ${vkHashBb.slice(0, 18)}...  ${vkHashCli === vkHashBb ? "MATCH" : "DIFFER"}`);
  console.log(`  public inputs identical:    ${pubMatch}`);
  console.log(`  proof bytes identical:      ${proofMatch}  (CLI ${cliProof.length} vs bb.js ${bbProofU8.length})`);

  // local verify of the bb.js proof
  const bbVerify = await backend.verifyProof({ proof: bbProofU8, publicInputs: bbPub }, opts);
  console.log(`  bb.js proof verifies (bb.js): ${bbVerify}`);

  // statement-leaf comparison: what the CONTRACT would derive from each proof's
  // public inputs, using the REGISTERED zkv_vk_hash (from the CLI vk).
  const leafOf = (pub: Uint8Array) => hx(keccak_256(concat(CTX, Uint8Array.from(Buffer.from(zkvVk.slice(2), "hex")), VERSION, keccak_256(pub))));
  const bbPubBytes = concat(...bbPub.map((p) => Uint8Array.from(Buffer.from(p.replace(/^0x/, "").padStart(64, "0"), "hex"))));
  const cliLeaf = leafOf(cliPubBytes);
  const bbLeaf = leafOf(bbPubBytes);
  console.log(`  statement leaf: CLI ${cliLeaf.slice(0, 18)}...  bb.js ${bbLeaf.slice(0, 18)}...  ${cliLeaf === bbLeaf ? "MATCH" : "DIFFER"}`);

  let zkvResult = "not submitted";
  if (doSubmit) {
    const zk = await import("zkverifyjs");
    const seed = readFileSync(".env.testnet", "utf8").match(/ZKVERIFY_SEED_PHRASE=(.+)/)![1]!.trim();
    const session = await zk.zkVerifySession.start().Volta().withAccount(seed);
    try {
      const { transactionResult } = await session.verify()
        .ultrahonk({ version: zk.UltrahonkVersion.V3_0, variant: zk.UltrahonkVariant.ZK })
        .execute({ proofData: { proof: hx(bbProofU8), publicSignals: bbPub, vk: hx(bbVk) }, domainId: 0 });
      const sub = await transactionResult;
      zkvResult = `ACCEPTED (agg ${sub.aggregationId}, statement ${sub.statement.slice(0, 18)}...)`;
    } catch (e) {
      zkvResult = "REJECTED: " + (e instanceof Error ? e.message : String(e));
    } finally {
      await session.close();
    }
    console.log(`  zkVerify V3_0 (bb.js proof): ${zkvResult}`);
  }

  const verdict = vkMatch && pubMatch && bbVerify;
  console.log(`  => ${verdict ? "COMPATIBLE (vk+pub+verify)" : "INCOMPATIBLE"}${proofMatch ? ", proof byte-identical" : ""}`);
  return verdict ? 0 : 2;
};

main().then((c) => process.exit(c)).catch((e) => { console.error("validation error:", e instanceof Error ? e.message : e); process.exit(1); });
