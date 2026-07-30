// =============================================================================
// STX Shield -- one-command deployment
// =============================================================================
//   pnpm deploy:testnet
//
// Deploys all six contracts in dependency order, wires them, saves the
// artifacts, and verifies the result. No manual step is required afterwards.
//
//   deploy -> addresses -> wire -> register vkeys -> configure -> verify
//
// Every step is idempotent: re-running after a partial failure resumes rather
// than duplicating.

import {
  CONTRACT_ORDER,
  NETWORKS,
  loadClarinetApiUrl,
  loadEnv,
  resolveDeployerMnemonic,
  type Network,
} from "./config.js";
import { Deployer, signerFromMnemonic } from "./deployer.js";
import { saveAddresses } from "./save-addresses.js";
import { wireContracts } from "./wire-contracts.js";
import { verifyDeployment } from "./verify-deployment.js";

const parseVkeys = (env: Record<string, string>) => {
  const vkeyHashes: Record<number, string> = {};
  const proofLengths: Record<number, number> = {};
  for (const [proofType, key] of [
    [1, "SHIELD"],
    [2, "TRANSFER"],
    [3, "WITHDRAW"],
    [4, "SPLIT"],
    [5, "MERGE"],
  ] as const) {
    const hash = env[`VKEY_HASH_${key}`];
    const len = env[`PROOF_LEN_${key}`];
    if (hash) vkeyHashes[proofType] = hash;
    if (len) proofLengths[proofType] = Number(len);
  }
  return { vkeyHashes, proofLengths };
};

export const main = async (): Promise<number> => {
  const network = (process.argv[2] as Network) ?? "testnet";
  if (!NETWORKS[network]) throw new Error(`unknown network: ${network}`);

  const env = loadEnv(network === "mainnet" ? ".env.mainnet" : ".env.testnet");
  const mnemonic = resolveDeployerMnemonic(env, network);
  const apiUrl =
    env["STACKS_API_URL"] || loadClarinetApiUrl(network) || NETWORKS[network].coreApiUrl;

  const signer = await signerFromMnemonic(mnemonic, network);
  const d = new Deployer(network, signer, apiUrl);

  console.log("=".repeat(70));
  console.log(`STX Shield deployment — ${network}`);
  console.log(`Deployer: ${signer.address}`);
  console.log("=".repeat(70));

  const balance = await d.accountBalance();
  console.log(`Balance: ${Number(balance) / 1e6} STX`);
  if (balance < 10_000_000n) {
    console.error(
      `\nInsufficient balance. Fund ${signer.address} from the testnet faucet:\n` +
        `  https://explorer.hiro.so/sandbox/faucet?chain=testnet\n`,
    );
    return 1;
  }

  // --- 1. deploy in dependency order ---------------------------------------
  console.log("\nDeploying contracts...");
  const txids: Record<string, string | null> = {};
  for (const contract of CONTRACT_ORDER) {
    txids[contract] = await d.deployContract(contract);
  }

  // --- 2. artifacts (before wiring, so wiring failures still leave a record)
  console.log("\nSaving deployment artifacts...");
  saveAddresses(network, signer.address, txids, NETWORKS[network].zkVerifyDomainId);

  // --- 3. wire ------------------------------------------------------------
  const { vkeyHashes, proofLengths } = parseVkeys(env);
  await wireContracts(d, network, {
    vkeyHashes,
    proofLengths,
    relayer: env["AGGREGATION_RELAYER"] || signer.address,
    treasury: env["TREASURY_ADDRESS"],
    fees: env["SHIELD_FEE_BPS"]
      ? [
          [1, Number(env["SHIELD_FEE_BPS"]), 0],
          [2, 0, Number(env["TRANSFER_FEE_FLAT"] ?? 0)],
          [3, Number(env["WITHDRAW_FEE_BPS"] ?? 0), 0],
        ]
      : undefined,
    genesisRootHex: env["GENESIS_ROOT"] || NETWORKS[network].genesisRootHex,
  });

  // --- 4. verify ----------------------------------------------------------
  const { passed } = await verifyDeployment(d, network);

  console.log("\n" + "=".repeat(70));
  console.log(passed ? "DEPLOYMENT COMPLETE" : "DEPLOYMENT COMPLETED WITH FAILURES");
  console.log(`Artifacts: deployments/${network}/`);
  console.log("=".repeat(70));
  return passed ? 0 : 1;
};

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("\nDeployment failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
