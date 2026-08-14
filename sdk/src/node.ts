// =============================================================================
// @stacks-shield/sdk/node -- Node convenience entry
// =============================================================================
// Loads circuit artifacts from disk and builds the (validated) bb.js engine.
//   import { createNodeEngine } from "@stacks-shield/sdk/node";
//   const shield = new STXShield({ network: "testnet", signer,
//     proofEngine: createNodeEngine({ circuitsDir }), zkVerify: { seed } });

import { readFile } from "node:fs/promises";
import { createBbjsEngine, type CircuitName, type CompiledCircuit } from "./proving/bbjs.js";
import type { ProofEngine } from "./proving/engine.js";

const PKG: Record<CircuitName, string> = {
  shield: "shield/target/shield_note.json",
  transfer: "transfer/target/transfer_note.json",
  split: "split/target/split_note.json",
  merge: "merge/target/merge_note.json",
  withdraw: "withdraw/target/withdraw_note.json",
  keygen: "keygen/target/keygen.json",
  // SIP-10 circuit family (zk/circuits/sip10/*). Shares circuitsDir root.
  "sip10-shield": "sip10/shield/target/sip10_shield_note.json",
  "sip10-transfer": "sip10/transfer/target/sip10_transfer_note.json",
  "sip10-split": "sip10/split/target/sip10_split_note.json",
  "sip10-merge": "sip10/merge/target/sip10_merge_note.json",
  "sip10-withdraw": "sip10/withdraw/target/sip10_withdraw_note.json",
};

export interface NodeEngineOptions {
  /** Path to the compiled circuits root (contains shield/, transfer/, ...). */
  circuitsDir: string;
  threads?: number;
}

/** Build the bb.js proof engine, loading artifacts from `circuitsDir`. */
export const createNodeEngine = (opts: NodeEngineOptions): ProofEngine =>
  createBbjsEngine({
    threads: opts.threads,
    loadArtifact: async (name: CircuitName): Promise<CompiledCircuit> =>
      JSON.parse(await readFile(`${opts.circuitsDir}/${PKG[name]}`, "utf8")) as CompiledCircuit,
  });

export { createBbjsEngine } from "./proving/bbjs.js";
export type { CircuitName, CompiledCircuit, BbjsEngineOptions } from "./proving/bbjs.js";
