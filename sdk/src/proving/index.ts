// =============================================================================
// @stacks-shield/sdk -- proof engine resolution
// =============================================================================

import { ProofGenerationError } from "../errors/index.js";
import type { ProofEngine } from "./engine.js";

export * from "./engine.js";

/**
 * Returns the configured engine, or throws a clear, actionable error. Proving
 * is intentionally pluggable: browser apps inject a WASM engine, Node/server
 * apps use the toolchain engine. The SDK never bundles a heavy prover into your
 * app unless you opt in.
 */
export const requireEngine = (engine: ProofEngine | undefined): ProofEngine => {
  if (!engine) {
    throw new ProofGenerationError(
      "No proof engine configured. Provide `proofEngine` in the SDK config. " +
        "Node/server: `@stacks-shield/sdk/node` (Noir+Barretenberg toolchain, proven on testnet). " +
        "Browser: a WASM engine (experimental). Read/stats/auth/discovery work without one.",
    );
  }
  return engine;
};
