// =============================================================================
// STX Shield SDK -- operation submission
// =============================================================================
// Decides HOW an operation reaches the chain, and that decision is the whole
// of sender privacy:
//
//   RELAYED (default for spends)  the relayer signs and pays -> the chain
//                                 records the RELAYER's address. The user
//                                 never appears.
//
//   DIRECT                        the user signs and pays -> the chain records
//                                 THE USER's address, which links every spend
//                                 to them. Available deliberately (for local
//                                 testing, or when no relayer is reachable and
//                                 the user prefers execution over privacy) but
//                                 never silent: it warns.
//
// Shield is always direct — it moves STX out of the user's own account, so it
// cannot be relayed and is inherently public on the input side.

import { RelayerClient, type RelayerSelection } from "../relayer/index.js";
import {
  toRelayPayload,
  type ContractCall,
  type MergeArgs,
  type SplitArgs,
  type TransferArgs,
  type WithdrawArgs,
} from "../transactions/index.js";

export type SpendOperation = "transfer" | "withdraw" | "split" | "merge";

export interface SubmitOptions {
  /** "random" (default), "ordered", or a specific relayer name. */
  relayer?: RelayerSelection;
  /** Opt out of relaying. Publishes the user's address — see the warning. */
  direct?: boolean;
  /** Encrypted note payload for the receiver, carried alongside the operation. */
  encryptedPayload?: string;
}

export interface SubmissionResult {
  /** How it was submitted — callers should surface this to users. */
  mode: "relayed" | "direct";
  /** Relayer name when relayed. */
  relayer?: string;
  /** Relayer job id, for status polling. */
  jobId?: string;
  /** Transaction id when submitted directly. */
  txid?: string;
  /** True when the submitting address is the user's own. */
  senderExposed: boolean;
}

/** Signs and broadcasts locally. Supplied by the wallet integration. */
export type DirectSubmitter = (call: ContractCall) => Promise<string>;

export interface SubmissionConfig {
  relayers?: RelayerClient;
  directSubmitter?: DirectSubmitter;
  /** Default selection when none is given per call. */
  defaultSelection?: RelayerSelection;
  /** Emitted when an operation is about to expose the user's address. */
  onPrivacyWarning?: (message: string) => void;
}

const DIRECT_WARNING =
  "Submitting directly: this transaction is signed and paid by your own " +
  "account, so the chain will link this spend to your address. Configure a " +
  "relayer (STX_SHIELD_RELAYERS) for sender privacy.";

export class Submitter {
  constructor(private readonly config: SubmissionConfig) {}

  private warn(): void {
    (this.config.onPrivacyWarning ?? ((m: string) => console.warn(`[stx-shield] ${m}`)))(
      DIRECT_WARNING,
    );
  }

  /**
   * Route a spend. Prefers a relayer; falls back to direct submission only if
   * explicitly asked, or if no relayer is configured at all — and says so.
   */
  async submitSpend(
    operation: SpendOperation,
    payload: unknown,
    call: ContractCall,
    options: SubmitOptions = {},
  ): Promise<SubmissionResult> {
    const canRelay = this.config.relayers && !options.direct;

    if (canRelay) {
      const accepted = await this.config.relayers!.submit(
        operation,
        payload,
        options.relayer ?? this.config.defaultSelection ?? "random",
      );
      return {
        mode: "relayed",
        relayer: accepted.relayer,
        jobId: accepted.jobId,
        senderExposed: false,
      };
    }

    if (!this.config.directSubmitter) {
      throw new Error(
        "no relayer configured and no direct submitter available — set " +
          "STX_SHIELD_RELAYERS or provide a wallet signer",
      );
    }
    this.warn();
    const txid = await this.config.directSubmitter(call);
    return { mode: "direct", txid, senderExposed: true };
  }

  /** Shield always goes direct: it spends the user's transparent STX. */
  async submitShield(call: ContractCall): Promise<SubmissionResult> {
    if (!this.config.directSubmitter) {
      throw new Error("shield requires a wallet signer");
    }
    const txid = await this.config.directSubmitter(call);
    // Not a warning: a deposit is public by nature. Privacy begins once the
    // note is in the pool, and every later spend can be relayed.
    return { mode: "direct", txid, senderExposed: true };
  }

  // -- payload helpers, so callers never hand-roll the relay body ----------

  transfer(a: TransferArgs, call: ContractCall, o: SubmitOptions = {}) {
    return this.submitSpend("transfer", toRelayPayload.transfer(a, o.encryptedPayload), call, o);
  }
  withdraw(a: WithdrawArgs, call: ContractCall, o: SubmitOptions = {}) {
    return this.submitSpend("withdraw", toRelayPayload.withdraw(a), call, o);
  }
  split(a: SplitArgs, call: ContractCall, o: SubmitOptions = {}) {
    return this.submitSpend("split", toRelayPayload.split(a, o.encryptedPayload), call, o);
  }
  merge(a: MergeArgs, call: ContractCall, o: SubmitOptions = {}) {
    return this.submitSpend("merge", toRelayPayload.merge(a, o.encryptedPayload), call, o);
  }
}

/** Build a relayer client from `STX_SHIELD_RELAYERS=R1=https://…,R2=https://…`. */
export const relayersFromEnv = (
  value: string | undefined,
  selection?: RelayerSelection,
): RelayerClient | undefined => {
  if (!value?.trim()) return undefined;
  const relayers = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const eq = entry.indexOf("=");
      return eq === -1
        ? { name: `R${i + 1}`, url: entry, priority: i }
        : { name: entry.slice(0, eq).trim(), url: entry.slice(eq + 1).trim(), priority: i };
    });
  return relayers.length > 0 ? new RelayerClient({ relayers, selection }) : undefined;
};
