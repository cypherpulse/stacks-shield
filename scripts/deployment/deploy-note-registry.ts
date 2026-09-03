// Deploys note-manager on its own. Part of the ordered pipeline in
// deploy-all.ts; exposed separately for targeted redeploys and recovery.
// Deployment is idempotent — an existing contract is skipped.
import {
  NETWORKS,
  loadClarinetApiUrl,
  loadEnv,
  resolveDeployerMnemonic,
  type Network,
} from "./config.js";
import { Deployer, signerFromMnemonic } from "./deployer.js";

const main = async () => {
  const network = (process.argv[2] as Network) ?? "testnet";
  const env = loadEnv(network === "mainnet" ? ".env.mainnet" : (process.env["DEPLOY_ENV_FILE"] ?? ".env.v2.deploy"));
  const signer = await signerFromMnemonic(resolveDeployerMnemonic(env, network), network);
  const d = new Deployer(network, signer, env["STACKS_API_URL"] || loadClarinetApiUrl(network) || NETWORKS[network].coreApiUrl);
  const txid = await d.deployContract("note-manager");
  console.log(txid ? `note-manager deployed: ${txid}` : "note-manager already deployed");
};

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
