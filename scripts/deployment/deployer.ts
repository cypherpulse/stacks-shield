// =============================================================================
// STX Shield -- deployment engine
// =============================================================================
// Shared machinery for deploying and calling contracts on a live Stacks
// network. The per-contract deploy scripts and deploy-all.ts are thin wrappers
// over this module, so there is exactly one implementation of signing, fee
// handling, broadcast, and confirmation polling.

import { readFileSync } from "node:fs";
import {
  PostConditionMode,
  broadcastTransaction,
  makeContractCall,
  makeContractDeploy,
  type ClarityValue,
  type StacksTransactionWire,
} from "@stacks/transactions";
import { generateWallet } from "@stacks/wallet-sdk";
import { NETWORKS, type ContractName, type Network, type NetworkConfig } from "./config.js";

export interface Signer {
  address: string;
  privateKey: string;
}

/** Derive the deployer account from a 24-word mnemonic. Never logs the key. */
export const signerFromMnemonic = async (
  mnemonic: string,
  network: Network,
): Promise<Signer> => {
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  const account = wallet.accounts[0];
  if (!account) throw new Error("could not derive an account from the mnemonic");
  const { getStxAddress } = await import("@stacks/wallet-sdk");
  const address = getStxAddress({
    account,
    network: network === "mainnet" ? "mainnet" : "testnet",
  });
  return { address, privateKey: account.stxPrivateKey };
};

export class Deployer {
  readonly cfg: NetworkConfig;
  readonly signer: Signer;

  constructor(network: Network, signer: Signer, apiUrlOverride?: string) {
    this.cfg = { ...NETWORKS[network] };
    if (apiUrlOverride) (this.cfg as { coreApiUrl: string }).coreApiUrl = apiUrlOverride;
    this.signer = signer;
  }

  private get networkArg() {
    return this.cfg.network === "mainnet" ? "mainnet" : "testnet";
  }

  async accountBalance(): Promise<bigint> {
    const res = await fetch(
      `${this.cfg.coreApiUrl}/extended/v1/address/${this.signer.address}/balances`,
    );
    if (!res.ok) throw new Error(`balance query failed: ${res.status}`);
    const body = (await res.json()) as { stx: { balance: string } };
    return BigInt(body.stx.balance);
  }

  /** True when the contract already exists on chain (idempotent deploys). */
  async isDeployed(contract: ContractName): Promise<boolean> {
    const res = await fetch(
      `${this.cfg.coreApiUrl}/v2/contracts/interface/${this.signer.address}/${contract}`,
    );
    return res.ok;
  }

  async deployContract(contract: ContractName): Promise<string | null> {
    if (await this.isDeployed(contract)) {
      console.log(`  · ${contract} already deployed — skipping`);
      return null;
    }
    const source = readFileSync(`contracts/${contract}.clar`, "utf8");
    const tx = await makeContractDeploy({
      contractName: contract,
      codeBody: source,
      senderKey: this.signer.privateKey,
      network: this.networkArg,
      fee: this.cfg.maxDeployFee,
      clarityVersion: 3,
    });
    const txid = await this.broadcast(tx, `deploy ${contract}`);
    await this.waitForConfirmation(txid);
    return txid;
  }

  async callContract(
    contract: ContractName,
    fn: string,
    args: ClarityValue[],
    label = `${contract}.${fn}`,
  ): Promise<string> {
    const tx = await makeContractCall({
      contractAddress: this.signer.address,
      contractName: contract,
      functionName: fn,
      functionArgs: args,
      senderKey: this.signer.privateKey,
      network: this.networkArg,
      postConditionMode: PostConditionMode.Allow,
      fee: 10_000,
    });
    const txid = await this.broadcast(tx, label);
    await this.waitForConfirmation(txid);
    return txid;
  }

  /** Read-only call via the node's API — no transaction, no fee. */
  async readOnly(
    contract: ContractName,
    fn: string,
    args: string[] = [],
  ): Promise<{ okay: boolean; result?: string; cause?: string }> {
    const res = await fetch(
      `${this.cfg.coreApiUrl}/v2/contracts/call-read/${this.signer.address}/${contract}/${fn}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: this.signer.address, arguments: args }),
      },
    );
    return (await res.json()) as { okay: boolean; result?: string; cause?: string };
  }

  private async broadcast(tx: StacksTransactionWire, label: string): Promise<string> {
    const result = await broadcastTransaction({ transaction: tx, network: this.networkArg });
    if ("error" in result && result.error) {
      throw new Error(`${label} failed to broadcast: ${JSON.stringify(result)}`);
    }
    const txid = (result as { txid: string }).txid;
    console.log(`  · ${label} -> ${txid}`);
    return txid;
  }

  /** Polls until the transaction is anchored. Throws on abort. */
  async waitForConfirmation(txid: string, timeoutMs = 900_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`${this.cfg.coreApiUrl}/extended/v1/tx/${txid}`);
      if (res.ok) {
        const body = (await res.json()) as { tx_status: string };
        if (body.tx_status === "success") return;
        if (body.tx_status.startsWith("abort")) {
          throw new Error(`transaction ${txid} aborted: ${body.tx_status}`);
        }
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
    throw new Error(`transaction ${txid} not confirmed within ${timeoutMs}ms`);
  }
}
