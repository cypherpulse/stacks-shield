// =============================================================================
// generate-vkeys.ts -- derive ALL verification-key material for .env.v2.deploy
// =============================================================================
//   npx tsx scripts/deployment/sip10/generate-vkeys.ts            # offline VK hashes only
//   npx tsx scripts/deployment/sip10/generate-vkeys.ts --register # + register on zkVerify Volta
//
// Covers BOTH circuit families of the v2 relaunch:
//   - native STX : zk/circuits/<dir>/target/<pkg>.json         (deploy-fresh.ts)
//   - SIP-10     : zk/circuits/sip10/<dir>/target/<pkg>.json   (register-verification-keys.ts)
//
// This is the vkey tool -- you do NOT need the raw `bb write_vk` CLI. It computes
// each vk with @aztec/bb.js (verifierTarget "evm", the exact flavor zkVerify
// accepts), so its sha256 IS the on-chain register-vk anchor, and it writes the
// vk bytes to target/vk/vk (that directory is created HERE -- if an older stale
// copy exists it is overwritten). Prints a paste-ready block for .env.v2.deploy.
//
// PREREQUISITE: compile every circuit first, so each ACIR json exists:
//   for c in shield transfer withdraw split merge \
//            sip10/shield sip10/transfer sip10/withdraw sip10/split sip10/merge; do
//     (cd zk/circuits/$c && nargo compile); done
//
// Hash kinds:
//   ZKVERIFY_CONTEXT_HASH  = keccak256("ultrahonk")   -- shared UltraHonk pallet
//   *_VERSION_HASH         = UltraHonk V3_0 version    -- shared proof system
//   native VKEY_HASH_<K> / SIP-10 <PREFIX>_VK_HASH = sha256(bb.js vk)  -- OFFLINE
//   *_ZKV_VKEY_HASH        = vk hash zkVerify assigns  -- only with --register
//
// bb.js and zkVerify need WSL; run this locally and paste the output block.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";

const hx = (b: Uint8Array): string => "0x" + Buffer.from(b).toString("hex");

// Reused constants -- identical to the live STX deployment (deploy-fresh.ts)
// because it is the same pallet and the same proof system.
const CONTEXT_HASH = hx(keccak_256(new TextEncoder().encode("ultrahonk")));
const VERSION_HASH_V3_0 = "0x55b52ad2b4153c872e27d688f567c1406f0d93b5528dd2b0bf2a9a40df97f1f9";
const EXPECTED_CONTEXT = "0xa33e2e948e18eac44032d702b6274d45df693c3ddd3b1260bbadf0c89c16d7cb";

type Family = "native" | "sip10";
interface Circuit {
  family: Family;
  prefix: string;   // SHIELD | TRANSFER | WITHDRAW | SPLIT | MERGE
  proofType: number;
  acir: string;     // path to the compiled ACIR json
  vkDir: string;    // where to persist the vk bytes
}

// Native STX circuits (dir == package prefix; pkg == <name>_note).
const NATIVE: Circuit[] = [
  ["shield", 1], ["transfer", 2], ["withdraw", 3], ["split", 4], ["merge", 5],
].map(([dir, proofType]) => ({
  family: "native" as const,
  prefix: (dir as string).toUpperCase(),
  proofType: proofType as number,
  acir: `zk/circuits/${dir}/target/${dir}_note.json`,
  vkDir: `zk/circuits/${dir}/target/vk`,
}));

// SIP-10 circuits (pkg == sip10_<name>_note).
const SIP10: Circuit[] = [
  ["shield", 1], ["transfer", 2], ["withdraw", 3], ["split", 4], ["merge", 5],
].map(([dir, proofType]) => ({
  family: "sip10" as const,
  prefix: (dir as string).toUpperCase(),
  proofType: proofType as number,
  acir: `zk/circuits/sip10/${dir}/target/sip10_${dir}_note.json`,
  vkDir: `zk/circuits/sip10/${dir}/target/vk`,
}));

interface Row extends Circuit {
  vkHash: string;
  zkvVkeyHash: string; // "" until --register
  vkLen: number;
}

async function main(): Promise<void> {
  const doRegister = process.argv.includes("--register");

  if (CONTEXT_HASH.toLowerCase() !== EXPECTED_CONTEXT) {
    console.warn(`WARNING: computed context hash ${CONTEXT_HASH} != known STX value ${EXPECTED_CONTEXT}`);
  }

  const { UltraHonkBackend, Barretenberg } = await import("@aztec/bb.js");
  const api = await Barretenberg.new({ threads: 4 });
  const evm = { verifierTarget: "evm" as const };
  const ctx = doRegister ? await openSession() : null;

  const rows: Row[] = [];
  try {
    for (const c of [...NATIVE, ...SIP10]) {
      let program: { bytecode: string };
      try {
        program = JSON.parse(readFileSync(c.acir, "utf8"));
      } catch {
        throw new Error(`missing compiled circuit: ${c.acir} -- run \`nargo compile\` in its package first`);
      }

      const backend = new UltraHonkBackend(program.bytecode, api);
      const vk = await backend.getVerificationKey(evm);
      const vkHash = hx(sha256(vk));

      // Persist the vk bytes so `bb prove -k <vkDir>/vk` binds to the EXACT bytes
      // registered on zkVerify. Replace any stale copy (older bb wrote a plain
      // file here; this writes a directory) to avoid an "Is a directory" clash.
      if (existsSync(c.vkDir)) rmSync(c.vkDir, { recursive: true, force: true });
      mkdirSync(c.vkDir, { recursive: true });
      writeFileSync(`${c.vkDir}/vk`, Buffer.from(vk));
      writeFileSync(`${c.vkDir}/vk_hash`, Buffer.from(sha256(vk)));
      console.log(`${c.family.padEnd(6)} ${c.prefix.padEnd(9)} vk ${vk.length}B  VK_HASH=${vkHash}  (wrote ${c.vkDir}/vk)`);

      let zkvVkeyHash = "";
      if (ctx) {
        zkvVkeyHash = await registerVk(ctx, hx(vk));
        console.log(`${" ".repeat(16)} zkVerify vk hash  ZKV_VKEY_HASH=${zkvVkeyHash}`);
      }
      rows.push({ ...c, vkHash, zkvVkeyHash, vkLen: vk.length });
    }
  } finally {
    if (ctx) await ctx.session.close();
  }

  // ---- paste-ready .env.v2.deploy block -----------------------------------
  const zkvOr = (h: string) => h || "0x<run with --register, or paste from zkVerify VkRegistered>";
  console.log("\n" + "=".repeat(70));
  console.log("# ---- paste into .env.v2.deploy (v2 zkVerify key material) ----");
  console.log(`ZKVERIFY_CONTEXT_HASH=${CONTEXT_HASH}`);
  console.log("# native STX (consumed by deploy-fresh.ts):");
  for (const r of rows.filter((r) => r.family === "native")) {
    console.log(`VKEY_HASH_${r.prefix}=${r.vkHash}`);
    console.log(`PROOF_LEN_${r.prefix}=7872`);
    console.log(`STX_ZKV_VKEY_HASH_${r.prefix}=${zkvOr(r.zkvVkeyHash)}`);
  }
  console.log("STX_VERSION_HASH=" + VERSION_HASH_V3_0);
  console.log("# SIP-10 (consumed by register-verification-keys.ts):");
  for (const r of rows.filter((r) => r.family === "sip10")) {
    console.log(`${r.prefix}_VK_HASH=${r.vkHash}`);
    console.log(`${r.prefix}_ZKV_VKEY_HASH=${zkvOr(r.zkvVkeyHash)}`);
    console.log(`${r.prefix}_VERSION_HASH=${VERSION_HASH_V3_0}`);
  }
  console.log("=".repeat(70));

  if (!doRegister) {
    console.log("\nOffline VK hashes only. Re-run with --register to fill the *_ZKV_VKEY_HASH values,");
    console.log("or register each vk on zkVerify Volta and paste its VkRegistered hash.");
  }
}

// zkVerify Volta session. The seed (ZKVERIFY_SEED_PHRASE) can live in
// .env.v2.deploy OR the existing .env.testnet -- the Volta ACCOUNT is reused
// across deployments; only the vkeys are re-registered. Registration costs
// Volta test tokens. Runs only under --register.
function readSeed(): string {
  for (const file of [".env.v2.deploy", ".env.testnet", ".env.deploy"]) {
    if (!existsSync(file)) continue;
    const m = readFileSync(file, "utf8").match(/^ZKVERIFY_SEED_PHRASE=(.+)$/m);
    if (m && m[1]!.trim()) return m[1]!.trim();
  }
  throw new Error(
    "ZKVERIFY_SEED_PHRASE not found in .env.v2.deploy, .env.testnet, or .env.deploy. " +
      "Set it (a funded zkVerify Volta account) to use --register, or run WITHOUT " +
      "--register to get the offline VK_HASH values.",
  );
}
async function openSession() {
  const zk = await import("zkverifyjs");
  const session = await zk.zkVerifySession.start().Volta().withAccount(readSeed());
  return { session, zk };
}

/** Register one UltraHonk vk (V3_0/ZK) and return the vk hash zkVerify assigns. */
async function registerVk(
  ctx: Awaited<ReturnType<typeof openSession>>,
  vkHex: string,
): Promise<string> {
  const { session, zk } = ctx;
  const { transactionResult } = await session
    .registerVerificationKey()
    .ultrahonk({ version: zk.UltrahonkVersion.V3_0, variant: zk.UltrahonkVariant.ZK })
    .execute(vkHex);
  const res = (await transactionResult) as unknown as Record<string, unknown>;
  const hash = (res["statementHash"] ?? res["vkHash"] ?? res["hash"]) as string | undefined;
  if (!hash) throw new Error(`zkVerify registration returned no vk hash: ${JSON.stringify(res)}`);
  return hash.startsWith("0x") ? hash : "0x" + hash;
}

main().catch((err) => {
  console.error("VKEY GENERATION FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
