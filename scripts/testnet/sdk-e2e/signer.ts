// =============================================================================
// STX Shield -- Node wallet signer for the SDK e2e harness
// =============================================================================
// A WalletSigner backed by a mnemonic (Node/server-side). In a browser the app
// supplies a @stacks/connect-backed signer instead; the SDK is identical either
// way. Signs the API auth message (RSV, matching verifyMessageSignatureRsv) and
// the user-signed shield tx, and derives a STABLE 32-byte shield secret so the
// same wallet always yields the same owner/viewing keys (notes stay discoverable).

import { generateWallet, getStxAddress } from "@stacks/wallet-sdk";
import {
  makeContractCall, broadcastTransaction, PostConditionMode,
  privateKeyToPublic, publicKeyToHex, signMessageHashRsv, type ClarityValue,
} from "@stacks/transactions";
import { hashMessage } from "@stacks/encryption";
import { sha256 } from "@noble/hashes/sha2.js";
import type { WalletSigner, ContractCall, Network } from "../../../sdk/src/index.js";

const bytesToHex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export class MnemonicSigner implements WalletSigner {
  private key = "";
  private address = "";
  private constructor(private readonly apiUrl: string) {}

  static async fromMnemonic(mnemonic: string, network: Network, apiUrl: string): Promise<MnemonicSigner> {
    const s = new MnemonicSigner(apiUrl);
    const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
    const account = wallet.accounts[0]!;
    s.key = account.stxPrivateKey;
    s.address = getStxAddress({ account, network });
    return s;
  }

  getAddress(): string {
    return this.address;
  }

  async signMessage(message: string): Promise<{ signature: string; publicKey: string }> {
    const messageHash = bytesToHex(hashMessage(message)).replace(/^0x/, "");
    const signature = signMessageHashRsv({ messageHash, privateKey: this.key });
    const publicKey = publicKeyToHex(privateKeyToPublic(this.key));
    return { signature, publicKey };
  }

  /** Sign + broadcast the (user-signed) shield tx, then wait for confirmation so
   *  the commitment is on chain before the SDK spends against it. */
  async signAndBroadcast(call: ContractCall, network: Network): Promise<string> {
    const tx = await makeContractCall({
      contractAddress: call.contractAddress,
      contractName: call.contractName,
      functionName: call.functionName,
      functionArgs: call.functionArgs as ClarityValue[],
      senderKey: this.key,
      network,
      postConditionMode: PostConditionMode.Allow,
      fee: 30_000n,
      nonce: await this.nextNonce(),
    });
    const r = await broadcastTransaction({ transaction: tx, network });
    const txid = (r as { txid?: string }).txid;
    if (!txid) throw new Error(`shield broadcast failed: ${JSON.stringify(r)}`);
    await this.waitForConfirmation(txid);
    return txid;
  }

  getShieldSecret(): Uint8Array {
    // Stable, derived from the wallet key. Never transmitted.
    return sha256(new TextEncoder().encode("stx-shield-secret:" + this.key));
  }

  private async nextNonce(): Promise<bigint> {
    const res = await fetch(`${this.apiUrl}/extended/v1/address/${this.address}/nonces`);
    const j = (await res.json()) as { possible_next_nonce: number };
    return BigInt(j.possible_next_nonce);
  }

  private async waitForConfirmation(txid: string, timeoutMs = 900_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`${this.apiUrl}/extended/v1/tx/${txid.startsWith("0x") ? txid : "0x" + txid}`);
      if (res.ok) {
        const b = (await res.json()) as { tx_status: string; tx_result?: { repr: string } };
        if (b.tx_status === "success") return;
        if (b.tx_status.startsWith("abort")) throw new Error(`shield aborted: ${b.tx_result?.repr ?? b.tx_status} (${txid})`);
      }
      await new Promise((r) => setTimeout(r, 8000));
    }
    throw new Error(`shield not confirmed within timeout (${txid})`);
  }
}
