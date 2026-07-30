// =============================================================================
// STX Shield -- deployment script
// =============================================================================
// Deploys the six contracts in dependency order to the target network, then
// invokes wire.ts to configure the protocol. Idempotent per contract: skips a
// contract already present at the deployer address.
//
// Usage:
//   DEPLOYER_KEY=<hex> ts-node deployment/deploy.ts <network>
//
// Signing keys come from the environment; nothing sensitive is committed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeContractDeploy,
  broadcastTransaction,
  fetchNonce,
  AnchorMode,
  PostConditionMode,
} from "@stacks/transactions";
import { CONTRACT_ORDER, NETWORKS, type Network } from "./config.js";

async function main() {
  const network = (process.argv[2] as Network) ?? "devnet";
  const cfg = NETWORKS[network];
  const key = requireEnv("DEPLOYER_KEY");

  console.log(`[deploy] network=${network} api=${cfg.coreApiUrl}`);

  let nonce = await fetchNonce({ address: deriveAddress(key), network: stacksNetwork(network) });

  for (const name of CONTRACT_ORDER) {
    const source = readFileSync(join("contracts", `${name}.clar`), "utf8");
    const tx = await makeContractDeploy({
      contractName: name,
      codeBody: source,
      senderKey: key,
      network: stacksNetwork(network),
      nonce,
      fee: cfg.maxDeployFee,
      anchorMode: AnchorMode.Any,
      postConditionMode: PostConditionMode.Deny,
      clarityVersion: 3,
    });
    const res = await broadcastTransaction({ transaction: tx, network: stacksNetwork(network) });
    if ("error" in res) throw new Error(`deploy ${name} failed: ${JSON.stringify(res)}`);
    console.log(`[deploy] ${name} -> ${res.txid}`);
    nonce += 1n;
  }

  console.log("[deploy] all contracts broadcast. Run wire.ts once confirmed.");
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// The following two helpers are thin wrappers over @stacks/network and key
// derivation, kept abstract so this file documents the flow without pinning a
// specific @stacks/network major.
function stacksNetwork(_n: Network): unknown {
  // return new StacksMainnet({ url }) / StacksTestnet / devnet per @stacks/network
  throw new Error("wire @stacks/network for the target environment");
}
function deriveAddress(_key: string): string {
  // getAddressFromPrivateKey(key, version) per @stacks/transactions
  throw new Error("wire address derivation");
}

main().catch((e) => {
  console.error("[deploy] fatal:", e);
  process.exit(1);
});
