// =============================================================================
// STX Shield -- fresh testnet deployment with corrected contracts
// =============================================================================
//   npx tsx scripts/deployment/deploy-fresh.ts
//
// Deploys the full 6-contract stack under a FRESH deployer address (from
// .env.deploy), then wires it AND configures the real zkVerify statement
// binding constants (solved from the live network and the verifier pallet).
//
// A fresh address is required because contract names are permanent per
// principal — the previous deployment carries the old public-input encoding
// and cannot be replaced in place.

import { readFileSync } from "node:fs";
import { CONTRACT_ORDER, NETWORKS, loadClarinetApiUrl } from "./config.js";
import { Deployer, signerFromMnemonic } from "./deployer.js";
import { saveAddresses } from "./save-addresses.js";
import { wireContracts } from "./wire-contracts.js";
import { verifyDeployment } from "./verify-deployment.js";

// ---- real zkVerify constants (deployments/testnet/circuits.json) ----------
const CONTEXT_HASH = "0xa33e2e948e18eac44032d702b6274d45df693c3ddd3b1260bbadf0c89c16d7cb";
const VERSION_HASH_V3_0 = "0x55b52ad2b4153c872e27d688f567c1406f0d93b5528dd2b0bf2a9a40df97f1f9";
const ZKV_VK_HASH: Record<number, string> = {
  1: "0x96889d2466624e271b44d4e32ac8b557bdfdc922a1a16dc42f5c807f2dcacad8", // shield
  2: "0x3668b8b291ddf8cb0bc60bf9f3f33ce9e5af9d2de631ebd3bfb10a4455e91595", // transfer
  3: "0x5e1ad470b0b8b0094acd87360989f31c1059ba73e6613522d0b07d55e6b749de", // withdraw
  4: "0x7a3fbca8876dbbd32c5977c886cc843b41b18201330a80378719b12383ec2b01", // split
  5: "0x025d92c5d1f17b50433ab138f5f603eb64cb94b48299b5f23b9b8fcda76735de", // merge
};

// barretenberg vk hashes (the on-chain vkey registry anchor — distinct from
// zkVerify's vk hash). From deployments/testnet/circuits.json.
const BB_VK_HASH: Record<number, string> = {
  1: "0x1b918ee0842466ece68ed65f8af7433f51c8084e8a6a131baed0faacd6f8b237",
  2: "0x17c1549c53081bab1af5d6841ccab3c0405f45268939496c29665a09cf7dbf6c",
  3: "0x0c0811267d4b1887c037897f3b8bf32ac24e9b6c8bef62a8b35c673ade354634",
  4: "0x20749435d6ff8a442d1fd1f512a73cf35dc33cf4dbca237ff394041c34727821",
  5: "0x11f61b5081e3a5fd0f3dc8087f16173ad33558696a9bcd97324d52eb21995241",
};
const PROOF_LEN = 7872;
const GENESIS_ROOT = "0x2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3e";

const loadDeployEnv = (): { mnemonic: string; address: string } => {
  const text = readFileSync(".env.deploy", "utf8");
  const m = text.match(/NEW_DEPLOYER_MNEMONIC=(.+)/);
  const a = text.match(/NEW_DEPLOYER_ADDRESS=(.+)/);
  if (!m || !a) throw new Error(".env.deploy missing mnemonic/address");
  return { mnemonic: m[1]!.trim(), address: a[1]!.trim() };
};

const main = async (): Promise<number> => {
  const network = "testnet" as const;
  const { mnemonic } = loadDeployEnv();
  const signer = await signerFromMnemonic(mnemonic, network);
  const apiUrl = loadClarinetApiUrl(network) ?? NETWORKS[network].coreApiUrl;
  const d = new Deployer(network, signer, apiUrl);

  console.log("=".repeat(70));
  console.log(`STX Shield FRESH deployment — corrected encoding — ${network}`);
  console.log(`Deployer: ${signer.address}`);
  console.log("=".repeat(70));

  const balance = await d.accountBalance();
  console.log(`Balance: ${Number(balance) / 1e6} STX`);
  if (balance < 5_000_000n) {
    console.error("Deployer underfunded — fund .env.deploy address first.");
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
    proofLengths: { 1: PROOF_LEN, 2: PROOF_LEN, 3: PROOF_LEN, 4: PROOF_LEN, 5: PROOF_LEN },
    relayer: signer.address,
    genesisRootHex: GENESIS_ROOT,
    fees: [
      [1, 25, 0], // shield 0.25%
      [2, 0, 10_000], // transfer 0.01 STX flat
      [3, 30, 0], // withdraw 0.30%
    ],
    zkverifyContextHash: CONTEXT_HASH,
    zkverifyBindings: {
      1: [ZKV_VK_HASH[1]!, VERSION_HASH_V3_0],
      2: [ZKV_VK_HASH[2]!, VERSION_HASH_V3_0],
      3: [ZKV_VK_HASH[3]!, VERSION_HASH_V3_0],
      4: [ZKV_VK_HASH[4]!, VERSION_HASH_V3_0],
      5: [ZKV_VK_HASH[5]!, VERSION_HASH_V3_0],
    },
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
