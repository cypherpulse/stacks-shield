// =============================================================================
// STX Shield SDK -- root client (tree synchronization + retries)
// =============================================================================
// Reads the current Merkle root from the registry and keeps the local
// MerkleTree in sync by replaying commitment-registered events. Because the
// pool advances the root on every shield/transfer/split/merge, concurrent
// users race on `current-root`; tree-extending submissions declare the root
// they built against and the chain rejects a stale one (ERR-STALE-ROOT / u252).
// `retryRootUpdates` resyncs and rebuilds against the fresh root on that error.

import { fromHex, bytesEqual } from "../utilities/crypto.js";
import { MerkleTree } from "./merkle-tree.js";
import { type Bytes32, type ShieldConfig, ShieldError } from "../types.js";

interface ReadOnlyCaller {
  callReadOnly(contract: string, fn: string, args: unknown[]): Promise<unknown>;
}

/** Stale-root error code from the pool / split-merge-manager. */
export const STALE_ROOT_CODES = new Set([252]);

export class RootClient {
  constructor(
    private readonly config: ShieldConfig,
    private readonly caller: ReadOnlyCaller,
    private readonly tree: MerkleTree = new MerkleTree(config.treeDepth),
  ) {}

  get localTree(): MerkleTree {
    return this.tree;
  }

  /** Fetch the live current root (hex → bytes) from the registry. */
  async getCurrentRoot(): Promise<Bytes32> {
    const res = (await this.caller.callReadOnly(
      this.config.contracts.registry,
      "get-current-root",
      [],
    )) as { root: string };
    return fromHex(res.root);
  }

  /** True when the local tree root matches the on-chain current root. */
  async isSynced(): Promise<boolean> {
    return bytesEqual(this.tree.root(), await this.getCurrentRoot());
  }

  /**
   * Run a tree-extending submission with automatic stale-root recovery:
   * (1) build against the current root, (2) submit, (3) on a stale-root
   * failure, resync and rebuild, up to `maxRetries` times.
   */
  async retryRootUpdates<T>(
    build: (currentRoot: Bytes32) => Promise<{ submit: () => Promise<T>; errorCode?: number }>,
    maxRetries = 5,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const currentRoot = await this.getCurrentRoot();
      const { submit } = await build(currentRoot);
      try {
        return await submit();
      } catch (e) {
        lastErr = e;
        const code = (e as { code?: number }).code;
        if (code !== undefined && STALE_ROOT_CODES.has(code)) {
          // another operation advanced the tree; back off and retry
          await delay(250 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    throw new ShieldError("ROOT_RETRY_EXHAUSTED", `stale-root retries exhausted: ${String(lastErr)}`);
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
