// =============================================================================
// STX Shield relayer -- transaction manager
// =============================================================================
// Turns a validated relay request into a signed Stacks transaction submitted
// from the RELAYER's account. This is the component that makes the user
// disappear from the chain: `tx-sender` is the relayer, never the user.
//
// The relayer signs the transaction but cannot alter its meaning — every
// operation parameter is bound into the zkVerify statement the contracts
// re-derive and check against the published aggregation root. Tampering
// produces a different leaf and the transaction reverts.
//
// Nonce handling is serialized through a mutex: relayers submit many
// transactions from one account, and Stacks rejects out-of-order nonces
// (BadNonce). We track the nonce locally and resync on error.

import {
  Cl,
  PostConditionMode,
  broadcastTransaction,
  makeContractCall,
  type ClarityValue,
} from "@stacks/transactions";
import { RelayError, type Operation, type RelayRequest } from "../types/index.js";

/** A signed Stacks transaction, as returned by makeContractCall. */
type SignedTx = Awaited<ReturnType<typeof makeContractCall>>;

export interface TxManagerConfig {
  network: "mainnet" | "testnet";
  apiUrl: string;
  /** Relayer's signing key. Never leaves this process. */
  senderKey: string;
  /** Relayer's own address (for nonce lookups). */
  address: string;
  /** Contract deployer address (contracts live under it). */
  deployer: string;
  /** micro-STX fee the relayer pays per transaction. */
  txFee: number;
}

const buf = (hex: string) =>
  Cl.buffer(Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex")));

/** The four inclusion arguments every operation ends with. */
const inclusionArgs = (r: RelayRequest): ClarityValue[] => [
  Cl.uint(r.inclusion.domainId),
  Cl.uint(r.inclusion.aggregationId),
  Cl.list(r.inclusion.merklePath.map(buf)),
  Cl.uint(r.inclusion.leafIndex),
];

/** Maps a relay request onto its contract call. The ONLY place request
 *  fields become transaction arguments — so the mapping is auditable in one
 *  spot, and any drift from the contract signatures shows up here. */
export const buildCall = (
  op: Operation,
  r: RelayRequest,
): { contract: string; fn: string; args: ClarityValue[] } => {
  switch (op) {
    case "transfer": {
      const t = r as import("../types/index.js").TransferRequest;
      return {
        contract: "privacy-pool",
        fn: "transfer",
        args: [
          buf(t.nullifier),
          buf(t.newCommitment),
          buf(t.newOwnerCommitment),
          buf(t.newMetadata),
          buf(t.currentRoot),
          buf(t.newRoot),
          ...inclusionArgs(r),
        ],
      };
    }
    case "withdraw": {
      const w = r as import("../types/index.js").WithdrawRequest;
      return {
        contract: "privacy-pool",
        fn: "withdraw",
        args: [
          buf(w.nullifier),
          Cl.uint(BigInt(w.amount)),
          Cl.principal(w.recipient),
          buf(w.root),
          ...inclusionArgs(r),
        ],
      };
    }
    case "split": {
      const s = r as import("../types/index.js").SplitRequest;
      return {
        contract: "split-merge-manager",
        fn: "split-note",
        args: [
          buf(s.nullifier),
          buf(s.commitment1),
          buf(s.ownerCommitment1),
          buf(s.metadata1),
          buf(s.commitment2),
          buf(s.ownerCommitment2),
          buf(s.metadata2),
          buf(s.currentRoot),
          buf(s.newRoot),
          ...inclusionArgs(r),
        ],
      };
    }
    case "merge": {
      const m = r as import("../types/index.js").MergeRequest;
      return {
        contract: "split-merge-manager",
        fn: "merge-notes",
        args: [
          buf(m.nullifier1),
          buf(m.nullifier2),
          buf(m.commitment),
          buf(m.ownerCommitment),
          buf(m.metadata),
          buf(m.currentRoot),
          buf(m.newRoot),
          ...inclusionArgs(r),
        ],
      };
    }
  }
};

export class TransactionManager {
  private nonce: bigint | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** Signed txs retained so a timed-out broadcast can be re-sent verbatim. */
  private readonly signed = new Map<string, SignedTx>();

  constructor(private readonly cfg: TxManagerConfig) {}

  private remember(txid: string, tx: SignedTx): void {
    this.signed.set(txid, tx);
    if (this.signed.size > 256) {
      const oldest = this.signed.keys().next().value;
      if (oldest) this.signed.delete(oldest);
    }
  }

  /** Serialize submissions so nonces are consumed in order. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run as Promise<T>;
  }

  private async fetchNonce(): Promise<bigint> {
    const res = await fetch(
      `${this.cfg.apiUrl}/extended/v1/address/${this.cfg.address}/nonces`,
    );
    if (!res.ok) throw new RelayError("nonce_unavailable", `nonce ${res.status}`, 502);
    const body = (await res.json()) as { possible_next_nonce: number };
    return BigInt(body.possible_next_nonce);
  }

  async submit(op: Operation, r: RelayRequest): Promise<string> {
    const { contract, fn, args } = buildCall(op, r);
    return this.submitRaw(contract, fn, args);
  }

  /**
   * Submit an arbitrary contract call from the relayer account. Ops AND root
   * publication go through here so they share ONE serialized nonce sequence
   * (both come from the same relayer key). Returns the txid.
   */
  async submitRaw(contract: string, fn: string, args: ClarityValue[]): Promise<string> {
    return this.enqueue(async () => {
      if (this.nonce === null) this.nonce = await this.fetchNonce();

      const tx = await makeContractCall({
        contractAddress: this.cfg.deployer,
        contractName: contract,
        functionName: fn,
        functionArgs: args,
        senderKey: this.cfg.senderKey,
        network: this.cfg.network,
        postConditionMode: PostConditionMode.Allow,
        fee: this.cfg.txFee,
        nonce: this.nonce,
      });

      const result = await broadcastTransaction({ transaction: tx, network: this.cfg.network });
      if ("error" in result && result.error) {
        const reason = JSON.stringify(result);
        // a nonce conflict means our local counter drifted — resync and let
        // the worker retry rather than wedging the queue
        if (reason.includes("BadNonce")) {
          this.nonce = null;
          throw new RelayError("nonce_conflict", "nonce drift; retry", 503);
        }
        this.nonce = null;
        throw new RelayError("broadcast_failed", reason, 502);
      }
      this.nonce += 1n;
      const txid = (result as { txid: string }).txid;
      this.remember(txid, tx);
      return txid;
    });
  }

  /** Re-send a previously signed transaction verbatim (same nonce + txid). */
  async rebroadcast(txid: string): Promise<boolean> {
    const tx = this.signed.get(txid);
    if (!tx) return false;
    try {
      await broadcastTransaction({ transaction: tx, network: this.cfg.network });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Poll until anchored. On a full timeout window without confirmation, the tx
   * is re-broadcast verbatim (it may have been dropped from the mempool) and we
   * wait again, up to `rebroadcasts` times. Returns the final status.
   */
  async waitForConfirmation(
    txid: string,
    opts: { timeoutMs?: number; pollMs?: number; rebroadcasts?: number } = {},
  ): Promise<"success" | "failed"> {
    const pollMs = opts.pollMs ?? 30_000;
    const windowMs = opts.timeoutMs ?? 900_000;
    let rebroadcasts = opts.rebroadcasts ?? 3;

    for (;;) {
      const deadline = Date.now() + windowMs;
      while (Date.now() < deadline) {
        const res = await fetch(`${this.cfg.apiUrl}/extended/v1/tx/${txid}`);
        if (res.ok) {
          const body = (await res.json()) as { tx_status: string };
          if (body.tx_status === "success") return "success";
          if (body.tx_status.startsWith("abort")) return "failed";
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      if (rebroadcasts <= 0 || !(await this.rebroadcast(txid))) return "failed";
      rebroadcasts -= 1;
    }
  }

  async balance(): Promise<bigint> {
    const res = await fetch(
      `${this.cfg.apiUrl}/extended/v1/address/${this.cfg.address}/balances`,
    );
    if (!res.ok) return 0n;
    const body = (await res.json()) as { stx: { balance: string } };
    return BigInt(body.stx.balance);
  }
}
