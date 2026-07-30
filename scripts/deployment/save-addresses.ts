// =============================================================================
// STX Shield -- deployment artifacts
// =============================================================================
// Writes deployments/<network>/addresses.json and contracts.json. These are
// the inputs the SDK, the verification script, and the testnet validation
// script all read, so no address is ever typed by hand.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { CONTRACT_ORDER, type ContractName, type Network } from "./config.js";

export interface Addresses {
  network: Network;
  deployer: string;
  registry: string;
  verifier: string;
  noteRegistry: string;
  privacyPool: string;
  splitMergeManager: string;
  protocolFees: string;
}

export interface ContractRecord {
  name: ContractName;
  address: string;
  deployTxId: string | null;
}

export interface DeploymentArtifact {
  network: Network;
  deployer: string;
  deployedAt: string;
  zkVerifyDomainId: number;
  contracts: ContractRecord[];
}

const dir = (network: Network) => `deployments/${network}`;

export const toAddresses = (network: Network, deployer: string): Addresses => {
  const id = (c: ContractName) => `${deployer}.${c}`;
  return {
    network,
    deployer,
    registry: id("privacy-registry"),
    verifier: id("zk-verifier"),
    noteRegistry: id("note-manager"),
    privacyPool: id("privacy-pool"),
    splitMergeManager: id("split-merge-manager"),
    protocolFees: id("protocol-fees"),
  };
};

export const saveAddresses = (
  network: Network,
  deployer: string,
  txids: Record<string, string | null>,
  zkVerifyDomainId: number,
): { addresses: Addresses; artifact: DeploymentArtifact } => {
  mkdirSync(dir(network), { recursive: true });

  const addresses = toAddresses(network, deployer);
  const artifact: DeploymentArtifact = {
    network,
    deployer,
    deployedAt: new Date().toISOString(),
    zkVerifyDomainId,
    contracts: CONTRACT_ORDER.map((name) => ({
      name,
      address: `${deployer}.${name}`,
      deployTxId: txids[name] ?? null,
    })),
  };

  writeFileSync(`${dir(network)}/addresses.json`, JSON.stringify(addresses, null, 2) + "\n");
  writeFileSync(`${dir(network)}/contracts.json`, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`  · wrote ${dir(network)}/addresses.json and contracts.json`);
  return { addresses, artifact };
};

export const loadAddresses = (network: Network): Addresses => {
  const path = `${dir(network)}/addresses.json`;
  if (!existsSync(path)) {
    throw new Error(`${path} not found — run the deployment first (pnpm deploy:${network}).`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Addresses;
};
