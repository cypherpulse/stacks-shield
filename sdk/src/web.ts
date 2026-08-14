// =============================================================================
// @stacks-shield/sdk/web -- browser convenience entry
// =============================================================================
// Fetches circuit artifacts over HTTP and builds the (validated) bb.js engine.
//   import { createWebEngine } from "@stacks-shield/sdk/web";
//   const shield = new STXShield({ network: "testnet", signer,
//     proofEngine: createWebEngine({ artifactsBaseUrl: "/circuits" }),
//     zkVerify: { endpointUrl: "https://submit.stxshield.io" } });
//
// Browser proving uses WASM threads, which require cross-origin isolation
// (COOP: same-origin, COEP: require-corp). Without those headers set
// `threads: 1` (slower, single-threaded).

import { createBbjsEngine, type CircuitName, type CompiledCircuit } from "./proving/bbjs.js";
import type { ProofEngine } from "./proving/engine.js";

const FILE: Record<CircuitName, string> = {
  shield: "shield.json", transfer: "transfer.json", split: "split.json",
  merge: "merge.json", withdraw: "withdraw.json", keygen: "keygen.json",
  // SIP-10 circuit family.
  "sip10-shield": "sip10-shield.json", "sip10-transfer": "sip10-transfer.json", "sip10-split": "sip10-split.json",
  "sip10-merge": "sip10-merge.json", "sip10-withdraw": "sip10-withdraw.json",
};

export interface WebEngineOptions {
  /** Base URL hosting the compiled circuit JSON files (one per circuit). */
  artifactsBaseUrl: string;
  /** WASM threads. Use 1 without cross-origin isolation. Default 4. */
  threads?: number;
}

/** Build the bb.js proof engine, fetching artifacts from `artifactsBaseUrl`. */
export const createWebEngine = (opts: WebEngineOptions): ProofEngine =>
  createBbjsEngine({
    threads: opts.threads,
    loadArtifact: async (name: CircuitName): Promise<CompiledCircuit> => {
      const res = await fetch(`${opts.artifactsBaseUrl.replace(/\/$/, "")}/${FILE[name]}`);
      if (!res.ok) throw new Error(`failed to load circuit ${name}: ${res.status}`);
      return (await res.json()) as CompiledCircuit;
    },
  });

export { createBbjsEngine } from "./proving/bbjs.js";
export type { CircuitName, CompiledCircuit, BbjsEngineOptions } from "./proving/bbjs.js";
