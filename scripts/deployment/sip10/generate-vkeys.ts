// =============================================================================
// generate-vkeys.ts -- derive the SIP-10 verification-key material for .env.deploy
// =============================================================================
//   npx tsx scripts/deployment/sip10/generate-vkeys.ts            # offline VK hashes only
//   npx tsx scripts/deployment/sip10/generate-vkeys.ts --register # + register on zkVerify Volta
//
// Produces every hash `configure-sip10.ts` / `register-verification-keys.ts`
// need, printed as a paste-ready .env.deploy block. Mirrors scripts/validation/
// bbjs-validate.ts (offline vk via @aztec/bb.js) and the zkVerify Volta session.
//
// PREREQUISITE: compile the five SIP-10 circuits first, so each ACIR json exists at
//   zk/circuits/sip10/<dir>/target/<pkg>.json
// e.g. (run from the workspace, in WSL):
//   for c in shield transfer withdraw split merge; do \
//     (cd zk/circuits/sip10/$c && nargo compile); done
//
// Two of the four hash kinds are REUSED constants (not new per deployment):
//   ZKVERIFY_CONTEXT_HASH  = keccak256("ultrahonk")   -- same UltraHonk pallet
//   <PREFIX>_VERSION_HASH  = UltraHonk V3_0 version    -- same proof system
// The other two are circuit-specific:
//   <PREFIX>_VK_HASH        = sha256(bb.js vk)         -- OFFLINE, deterministic
//   <PREFIX>_ZKV_VKEY_HASH  = vk hash zkVerify assigns -- only with --register
//
// bb.js and zkVerify need WSL; run this locally and paste the output block.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { CIRCUITS } from "./lib.js";

const hx = (b: Uint8Array): string => "0x" + Buffer.from(b).toString("hex");

// Reused constants — identical to the live STX deployment (scripts/deployment/
// deploy-fresh.ts) because it is the same pallet and the same proof system.
const CONTEXT_HASH = hx(keccak_256(new TextEncoder().encode("ultrahonk")));
const VERSION_HASH_V3_0 = "0x55b52ad2b4153c872e27d688f567c1406f0d93b5528dd2b0bf2a9a40df97f1f9";
const EXPECTED_CONTEXT = "0xa33e2e948e18eac44032d702b6274d45df693c3ddd3b1260bbadf0c89c16d7cb";

interface Row {
  prefix: string;
  vkHash: string;
  zkvVkeyHash: string; // "" until --register
  vkLen: number;
}

async function main(): Promise<void> {
  const doRegister = process.argv.includes("--register");

  if (CONTEXT_HASH.toLowerCase() !== EXPECTED_CONTEXT) {
    // Non-fatal: surface it loudly so we never silently drift from the STX value.
    console.warn(`WARNING: computed context hash ${CONTEXT_HASH} != known STX value ${EXPECTED_CONTEXT}`);
  }

  const { UltraHonkBackend, Barretenberg } = await import("@aztec/bb.js");
  const api = await Barretenberg.new({ threads: 4 });
  const evm = { verifierTarget: "evm" as const };

  // zkVerify session only when registering.
  const ctx = doRegister ? await openSession() : null;

  const rows: Row[] = [];
  try {
    for (const c of CIRCUITS) {
      const acirPath = `zk/circuits/sip10/${c.dir}/target/${c.pkg}.json`;
      let program: { bytecode: string };
      try {
        program = JSON.parse(readFileSync(acirPath, "utf8"));
      } catch {
        throw new Error(`missing compiled circuit: ${acirPath} — run \`nargo compile\` in zk/circuits/sip10/${c.dir} first`);
      }

      const backend = new UltraHonkBackend(program.bytecode, api);
      const vk = await backend.getVerificationKey(evm);
      const vkHash = hx(sha256(vk));
      // Persist the vk so `bb prove -k target/vk/vk` (the e2e prover) binds to the
      // EXACT bytes registered on zkVerify — no bb-CLI vs bb.js mismatch.
      const vkDir = `zk/circuits/sip10/${c.dir}/target/vk`;
      mkdirSync(vkDir, { recursive: true });
      writeFileSync(`${vkDir}/vk`, Buffer.from(vk));
      writeFileSync(`${vkDir}/vk_hash`, Buffer.from(sha256(vk)));
      console.log(`${c.name.padEnd(9)} vk ${vk.length}B  ${c.prefix}_VK_HASH=${vkHash}  (wrote ${vkDir}/vk)`);

      let zkvVkeyHash = "";
      if (ctx) {
        zkvVkeyHash = await registerVk(ctx, hx(vk));
        console.log(`${" ".repeat(9)} zkVerify vk hash  ${c.prefix}_ZKV_VKEY_HASH=${zkvVkeyHash}`);
      }
      rows.push({ prefix: c.prefix, vkHash, zkvVkeyHash, vkLen: vk.length });
    }
  } finally {
    if (ctx) await ctx.session.close();
  }

  // ---- paste-ready .env.deploy block --------------------------------------
  console.log("\n" + "=".repeat(70));
  console.log("# ---- paste into .env.deploy (SIP-10 zkVerify key material) ----");
  console.log(`ZKVERIFY_CONTEXT_HASH=${CONTEXT_HASH}`);
  for (const r of rows) {
    console.log(`${r.prefix}_VK_HASH=${r.vkHash}`);
    console.log(`${r.prefix}_ZKV_VKEY_HASH=${r.zkvVkeyHash || "0x<run with --register, or paste from zkVerify VkRegistered>"}`);
    console.log(`${r.prefix}_VERSION_HASH=${VERSION_HASH_V3_0}`);
  }
  console.log("=".repeat(70));

  if (!doRegister) {
    console.log("\nOffline VK hashes only. Re-run with --register to fill the *_ZKV_VKEY_HASH values,");
    console.log("or register each vk on zkVerify Volta and paste its VkRegistered hash.");
  }
}

// zkVerify Volta session, seeded exactly like scripts/validation/bbjs-validate.ts
// (ZKVERIFY_SEED_PHRASE in .env.testnet). Registration costs Volta test tokens.
async function openSession() {
  const zk = await import("zkverifyjs");
  const m = readFileSync(".env.testnet", "utf8").match(/ZKVERIFY_SEED_PHRASE=(.+)/);
  if (!m) throw new Error(".env.testnet missing ZKVERIFY_SEED_PHRASE (needed for --register)");
  const session = await zk.zkVerifySession.start().Volta().withAccount(m[1]!.trim());
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
  // zkverifyjs returns the assigned hash as statementHash / vkHash depending on version.
  const hash = (res["statementHash"] ?? res["vkHash"] ?? res["hash"]) as string | undefined;
  if (!hash) throw new Error(`zkVerify registration returned no vk hash: ${JSON.stringify(res)}`);
  return hash.startsWith("0x") ? hash : "0x" + hash;
}

main().catch((err) => {
  console.error("VKEY GENERATION FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
