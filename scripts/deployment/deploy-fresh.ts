// =============================================================================
// STX Shield -- fresh testnet deployment with corrected contracts
// =============================================================================
//   npx tsx scripts/deployment/deploy-fresh.ts
//
// Deploys the full 6-contract stack under a FRESH deployer address (from
// .env.v2.deploy), then wires it AND configures the zkVerify statement binding
// constants. The per-circuit vk hashes are read from .env.v2.deploy (regenerated
// for v2 by scripts/deployment/sip10/generate-vkeys.ts).
//
// A fresh address is required because contract names are permanent per
// principal — the previous deployment carries the old public-input encoding
// and cannot be replaced in place.

import { CONTRACT_ORDER, NETWORKS, loadClarinetApiUrl, loadEnv, requireEnv, resolveDeployerMnemonic } from "./config.js";
import { Deployer, signerFromMnemonic } from "./deployer.js";
import { saveAddresses } from "./save-addresses.js";
import { wireContracts } from "./wire-contracts.js";
import { verifyDeployment } from "./verify-deployment.js";

// zkVerify constants shared across circuits (same pallet + proof system). The
// per-circuit vk hashes are NOT hardcoded any more: the v2 circuits changed, so
// they are regenerated (scripts/deployment/sip10/generate-vkeys.ts) and read from
// .env.v2.deploy. This keeps a stale v1 key from ever being wired by mistake.
const VERSION_HASH_V3_0 = "0x55b52ad2b4153c872e27d688f567c1406f0d93b5528dd2b0bf2a9a40df97f1f9";
const PROOF_LEN = 7872;

const KEY: Record<number, string> = { 1: "SHIELD", 2: "TRANSFER", 3: "WITHDRAW", 4: "SPLIT", 5: "MERGE" };

const ENV_FILE = process.env["DEPLOY_ENV_FILE"] ?? ".env.v2.deploy";

const main = async (): Promise<number> => {
  const network = "testnet" as const;
  const env = loadEnv(ENV_FILE);
  const mnemonic = resolveDeployerMnemonic(env, network);
  const signer = await signerFromMnemonic(mnemonic, network);
  // Guard: the derived address must match the declared new wallet, so a stale
  // mnemonic elsewhere can never deploy the STX core under the wrong account.
  const expectedAddr = env["NEW_DEPLOYER_ADDRESS"];
  if (expectedAddr && signer.address !== expectedAddr) {
    throw new Error(
      `Deployer address mismatch: mnemonic derives ${signer.address}, but NEW_DEPLOYER_ADDRESS ` +
        `in ${ENV_FILE} is ${expectedAddr}. A stale DEPLOYER_MNEMONIC in .env or your shell is ` +
        `likely overriding it. Refusing to deploy under the wrong account.`,
    );
  }
  const apiUrl = env["STACKS_API_URL"] || loadClarinetApiUrl(network) || NETWORKS[network].coreApiUrl;
  const d = new Deployer(network, signer, apiUrl);

  // v2 vkey material, regenerated + pasted into .env.v2.deploy.
  const CONTEXT_HASH = requireEnv(env, "ZKVERIFY_CONTEXT_HASH");
  const versionHash = env["STX_VERSION_HASH"] || VERSION_HASH_V3_0;
  const GENESIS_ROOT = env["GENESIS_ROOT"] || NETWORKS[network].genesisRootHex;
  const BB_VK_HASH: Record<number, string> = {};
  const ZKV_VK_HASH: Record<number, string> = {};
  const proofLengths: Record<number, number> = {};
  const zkverifyBindings: Record<number, [string, string]> = {};
  for (const pt of [1, 2, 3, 4, 5]) {
    BB_VK_HASH[pt] = requireEnv(env, `VKEY_HASH_${KEY[pt]}`);
    ZKV_VK_HASH[pt] = requireEnv(env, `STX_ZKV_VKEY_HASH_${KEY[pt]}`);
    proofLengths[pt] = Number(env[`PROOF_LEN_${KEY[pt]}`] || PROOF_LEN);
    zkverifyBindings[pt] = [ZKV_VK_HASH[pt]!, versionHash];
  }

  console.log("=".repeat(70));
  console.log(`STX Shield FRESH deployment — corrected encoding — ${network}`);
  console.log(`Deployer: ${signer.address}`);
  console.log("=".repeat(70));

  const balance = await d.accountBalance();
  console.log(`Balance: ${Number(balance) / 1e6} STX`);
  if (balance < 5_000_000n) {
    console.error(`Deployer ${signer.address} underfunded — fund it (NEW_DEPLOYER_ADDRESS in ${ENV_FILE}) at the testnet faucet first.`);
    return 1;
  }

  console.log("\nDeploying contracts...");
  const txids: Record<string, string | null> = {};
  for (const contract of CONTRACT_ORDER) {
    txids[contract] = await d.deployContract(contract);
  }

  console.log("\nSaving deployment artifacts...");
  saveAddresses(network, signer.address, txids, NETWORKS[network].zkVerifyDomainId);

  await wireContracts(d, network, {
    vkeyHashes: BB_VK_HASH,
    proofLengths,
    relayer: env["AGGREGATION_RELAYER"] || signer.address,
    treasury: env["TREASURY_ADDRESS"],
    genesisRootHex: GENESIS_ROOT,
    fees: [
      [1, Number(env["SHIELD_FEE_BPS"] ?? 25), 0], // shield
      [2, 0, Number(env["TRANSFER_FEE_FLAT"] ?? 10_000)], // transfer flat
      [3, Number(env["WITHDRAW_FEE_BPS"] ?? 30), 0], // withdraw
    ],
    zkverifyContextHash: CONTEXT_HASH,
    zkverifyBindings,
  });

  const { passed } = await verifyDeployment(d, network);

  console.log("\n" + "=".repeat(70));
  console.log(passed ? "FRESH DEPLOYMENT COMPLETE" : "COMPLETED WITH FAILURES");
  console.log(`Deployer / addresses: ${signer.address}`);
  console.log("=".repeat(70));
  return passed ? 0 : 1;
};

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error("\nDeployment failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
