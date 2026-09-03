// =============================================================================
// register-verification-keys.ts -- register SIP-10 vkeys + zkVerify bindings
// =============================================================================
//   npx tsx scripts/deployment/sip10/register-verification-keys.ts
//
// Registers, on sip10-zk-verifier, for each of the five circuits (proof-types
// u1-u5, circuit-version 1):
//   - register-verification-key(proof-type, 1, vkey-hash, proof-length)
//   - set-zkverify-binding(proof-type, 1, zkv-vkey-hash, version-hash)
// and once: set-zkverify-context-hash(context-hash).
//
// ALL hash material comes from .env.v2.deploy (never hardcoded). Each circuit needs
// THREE hashes plus the shared context hash:
//   <PREFIX>_VK_HASH        the bb.js verification-key hash (register-vk anchor)
//   <PREFIX>_ZKV_VKEY_HASH  the vk hash zkVerify assigns (from its VkRegistered event)
//   <PREFIX>_VERSION_HASH   the zkVerify proof version hash
//   ZKVERIFY_CONTEXT_HASH   keccak256(verifier_ctx) for the UltraHonk pallet
// (The contract's set-zkverify-binding requires BOTH zkv-vkey-hash and
//  version-hash, so two binding vars per circuit -- see DEPLOYMENT.md.)

import { CIRCUITS, Cl, PROOF_LEN, SIP10_CIRCUIT_VERSION, VERIFIER, asContract, buff32, getDeployer, isEntrypoint, requireEnvVars, env } from "./lib.js";
import type { Deployer } from "../deployer.js";

export const vkEnvKeys = (): string[] => {
  const keys = ["ZKVERIFY_CONTEXT_HASH"];
  for (const c of CIRCUITS) keys.push(`${c.prefix}_VK_HASH`, `${c.prefix}_ZKV_VKEY_HASH`, `${c.prefix}_VERSION_HASH`);
  return keys;
};

export async function registerVerificationKeys(deployer: Deployer, e: Record<string, string>): Promise<void> {
  requireEnvVars(e, vkEnvKeys());
  const V = asContract(VERIFIER);

  console.log("Setting zkVerify context hash …");
  await deployer.callContract(V, "set-zkverify-context-hash", [buff32(e["ZKVERIFY_CONTEXT_HASH"]!)], `${VERIFIER}.set-context`);

  for (const c of CIRCUITS) {
    console.log(`Registering vkey for ${c.name} (proof-type ${c.proofType}) …`);
    // vkeys are immutable: a re-run hits ERR-VKEY-EXISTS (u556). Tolerate it so
    // the whole configure step stays safely re-runnable (matches wire-contracts).
    try {
      await deployer.callContract(V, "register-verification-key",
        [Cl.uint(c.proofType), Cl.uint(SIP10_CIRCUIT_VERSION), buff32(e[`${c.prefix}_VK_HASH`]!), Cl.uint(PROOF_LEN)],
        `${VERIFIER}.register-vk.${c.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("u556")) console.log(`  · ${c.name} vkey already registered (immutable) — skipping`);
      else throw err;
    }
    // set-binding uses map-set (overwrite), so it is always safe to re-run.
    await deployer.callContract(V, "set-zkverify-binding",
      [Cl.uint(c.proofType), Cl.uint(SIP10_CIRCUIT_VERSION), buff32(e[`${c.prefix}_ZKV_VKEY_HASH`]!), buff32(e[`${c.prefix}_VERSION_HASH`]!)],
      `${VERIFIER}.set-binding.${c.name}`);
  }
  console.log("  ✓ all five vkeys + bindings registered");
}

async function main(): Promise<void> {
  await registerVerificationKeys(await getDeployer(), env());
}

// Run only when invoked directly.
if (isEntrypoint(import.meta.url)) {
  main().catch((err) => { console.error("VK REGISTRATION FAILED:", err instanceof Error ? err.message : err); process.exit(1); });
}
