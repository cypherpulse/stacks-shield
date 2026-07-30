// =============================================================================
// STX Shield SDK -- zkVerify proof provider
// =============================================================================
// Generates an UltraHonk proof with Noir/Barretenberg, submits it to zkVerify
// for verification, waits for the statement to be aggregated, and returns the
// Merkle inclusion path the Stacks contracts accept.
//
//   witness -> Noir -> Barretenberg (UltraHonk) -> zkVerify -> aggregation
//           -> inclusion path -> Stacks transaction
//
// No signature, approval, or committee is involved anywhere in this flow.
//
// zkVerify constraints this provider must respect (per the UltraHonk verifier
// pallet): only the `zk` proof flavor is accepted, transcripts must use
// Keccak256, and recursion is unsupported. `PROVING_OPTIONS` below encodes
// these; they are the reason the Barretenberg config is pinned.

import { keccak256 } from "../utilities/crypto.js";
import type { ProofType } from "../types.js";
import type { InclusionProof, ProofProvider, ProveRequest } from "./index.js";

/** Barretenberg options required for zkVerify compatibility. */
export const PROVING_OPTIONS = {
  /** zkVerify accepts only the zero-knowledge flavor. */
  zk: true,
  /** zkVerify's UltraHonk pallet requires a Keccak256 transcript. */
  oracleHash: "keccak" as const,
  /** Recursion is not supported by the pallet. */
  recursive: false,
};

export interface ZkVerifyProviderConfig {
  /** zkVerify RPC/websocket endpoint. */
  endpoint: string;
  /** Seed phrase for the account submitting proofs to zkVerify. */
  seedPhrase: string;
  /** Aggregation domain to submit under. Must match the domain whose roots
   *  are relayed to the Stacks zk-verifier. */
  domainId: number;
  /** Per-circuit zkVerify verification key hashes, keyed
   *  `${proofType}:${circuitVersion}` — the same values registered on chain
   *  via `register-verification-key`. */
  vkeyHashes: ReadonlyMap<string, Uint8Array>;
  /** Compiled circuit artifacts, keyed the same way. */
  circuits: ReadonlyMap<string, CircuitArtifact>;
  /** How long to wait for a statement to be aggregated and its root relayed
   *  to Stacks. Aggregation is batched, so this is seconds-to-minutes. */
  aggregationTimeoutMs?: number;
  /** Optional hook: resolves once the aggregation root for `aggregationId`
   *  is visible on Stacks. Supplied by the transaction layer so `prove()`
   *  only resolves when the proof is actually usable. */
  awaitRootOnStacks?: (domainId: number, aggregationId: number) => Promise<void>;
}

export interface CircuitArtifact {
  /** Compiled Noir program (ACIR bytecode + ABI). */
  readonly bytecode: string;
  readonly abi: unknown;
}

/** Minimal surface of `zkverifyjs` that this provider depends on. Declared
 *  structurally so the dependency stays optional at type level and the
 *  package is loaded lazily at call time. */
interface ZkVerifySession {
  verify(): {
    ultrahonk(): {
      execute(args: {
        proofData: { proof: string; publicSignals: string[]; vk: string };
        domainId: number;
      }): Promise<{
        events: { on(name: string, cb: (data: unknown) => void): void };
        transactionResult: Promise<ZkVerifyTransactionResult>;
      }>;
    };
  };
  poe(
    jobId: string,
    aggregationId: number,
  ): Promise<{
    proof: string[];
    numberOfLeaves: number;
    leafIndex: number;
    leaf: string;
  }>;
  close(): Promise<void>;
}

interface ZkVerifyTransactionResult {
  aggregationId: number;
  statement: string;
  jobId: string;
}

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/**
 * zkVerify binding constants for one circuit. All three are OBSERVED from the
 * live network — none is derivable from anything held locally:
 *
 *   contextHash  keccak256(verifier_ctx) identifying the UltraHonk pallet
 *   zkvVkeyHash  the vk hash zkVerify assigns at registration, emitted in its
 *                VkRegistered event — NOT barretenberg's vk_hash
 *   versionHash  identifies the proof version
 *
 * These mirror `zkverify-context-hash` and `zkverify-bindings` in
 * zk-verifier.clar and must hold identical values, or the leaf the SDK
 * computes will differ from the one the contract derives and every operation
 * will be rejected.
 */
export interface ZkVerifyBinding {
  contextHash: Uint8Array;
  zkvVkeyHash: Uint8Array;
  versionHash: Uint8Array;
}

/**
 * The aggregation leaf, computed exactly as `statement-leaf` in
 * zk-verifier.clar and exactly as zkVerify computes it:
 *
 *   keccak256( contextHash ‖ zkvVkeyHash ‖ versionHash ‖ publicInputsHash )
 *
 * The ONE place this encoding appears on the client. Guessing any component
 * is how the previous construction went wrong, so all three are supplied as
 * configuration rather than derived.
 */
export const statementLeaf = (
  binding: ZkVerifyBinding,
  publicInputsHash: Uint8Array,
): Uint8Array =>
  keccak256(
    concat(
      concat(binding.contextHash, binding.zkvVkeyHash),
      concat(binding.versionHash, publicInputsHash),
    ),
  );

export class ZkVerifyProvider implements ProofProvider {
  readonly name = "zkverify";
  private readonly config: ZkVerifyProviderConfig;
  private session: ZkVerifySession | null = null;

  constructor(config: ZkVerifyProviderConfig) {
    this.config = config;
  }

  private key(proofType: ProofType, circuitVersion: number): string {
    return `${proofType}:${circuitVersion}`;
  }

  private vkeyHash(proofType: ProofType, circuitVersion: number): Uint8Array {
    const k = this.key(proofType, circuitVersion);
    const vk = this.config.vkeyHashes.get(k);
    if (!vk) throw new Error(`no zkVerify vkey hash registered for ${k}`);
    return vk;
  }

  private circuit(proofType: ProofType, circuitVersion: number): CircuitArtifact {
    const k = this.key(proofType, circuitVersion);
    const c = this.config.circuits.get(k);
    if (!c) throw new Error(`no compiled circuit for ${k}`);
    return c;
  }

  /** Lazily open the zkVerify session so importing the SDK does not require
   *  the dependency unless proofs are actually generated. */
  private async connect(): Promise<ZkVerifySession> {
    if (this.session) return this.session;
    const mod = (await import("zkverifyjs")) as unknown as {
      zkVerifySession: {
        start(): {
          Custom(endpoint: string): {
            withAccount(seed: string): Promise<ZkVerifySession>;
          };
        };
      };
    };
    this.session = await mod.zkVerifySession
      .start()
      .Custom(this.config.endpoint)
      .withAccount(this.config.seedPhrase);
    return this.session;
  }

  /** Generate an UltraHonk proof for the request's witness. */
  private async generateProof(
    request: ProveRequest,
  ): Promise<{ proof: string; publicSignals: string[]; vk: string }> {
    const artifact = this.circuit(request.proofType, request.circuitVersion);
    const [{ Noir }, { UltraHonkBackend }] = await Promise.all([
      import("@noir-lang/noir_js") as Promise<{ Noir: new (c: unknown) => NoirLike }>,
      import("@aztec/bb.js") as Promise<{
        UltraHonkBackend: new (b: string) => BackendLike;
      }>,
    ]);

    const noir = new Noir({ bytecode: artifact.bytecode, abi: artifact.abi });
    const { witness } = await noir.execute(request.witness);

    const backend = new UltraHonkBackend(artifact.bytecode);
    try {
      const proof = await backend.generateProof(witness, PROVING_OPTIONS);
      const vk = await backend.getVerificationKey(PROVING_OPTIONS);
      return {
        proof: toHexString(proof.proof),
        publicSignals: proof.publicInputs,
        vk: toHexString(vk),
      };
    } finally {
      await backend.destroy?.();
    }
  }

  async prove(request: ProveRequest): Promise<InclusionProof> {
    const vkeyHash = this.vkeyHash(request.proofType, request.circuitVersion);
    const expectedLeaf = statementLeaf(vkeyHash, request.publicInputsHash);

    const proofData = await this.generateProof(request);
    const session = await this.connect();

    // Submit to zkVerify. It verifies the UltraHonk proof in its own
    // consensus and schedules the statement for aggregation.
    const { transactionResult } = await session
      .verify()
      .ultrahonk()
      .execute({ proofData, domainId: this.config.domainId });

    const result = await transactionResult;

    // Wait for the statement to be aggregated, then fetch its inclusion path.
    const poe = await session.poe(result.jobId, result.aggregationId);

    const leaf = hexToBytes(poe.leaf);
    if (!bytesEqual(leaf, expectedLeaf)) {
      // The statement zkVerify aggregated does not commit to the operation we
      // are about to submit. Submitting anyway would fail on chain; failing
      // here gives a usable error and is the tripwire for a leaf-encoding
      // mismatch between the SDK, the contract, and zkVerify.
      throw new Error(
        "zkVerify statement leaf does not match the operation binding — " +
          "check the statement-leaf encoding pin in zk-verifier.clar",
      );
    }

    // Only resolve once the aggregation root is actually usable on Stacks.
    if (this.config.awaitRootOnStacks) {
      await this.config.awaitRootOnStacks(this.config.domainId, result.aggregationId);
    }

    return {
      domainId: this.config.domainId,
      aggregationId: result.aggregationId,
      merklePath: poe.proof.map(hexToBytes),
      leafIndex: poe.leafIndex,
      leaf,
    };
  }

  async close(): Promise<void> {
    await this.session?.close();
    this.session = null;
  }
}

interface NoirLike {
  execute(inputs: Record<string, unknown>): Promise<{ witness: Uint8Array }>;
}
interface BackendLike {
  generateProof(
    witness: Uint8Array,
    opts: typeof PROVING_OPTIONS,
  ): Promise<{ proof: Uint8Array; publicInputs: string[] }>;
  getVerificationKey(opts: typeof PROVING_OPTIONS): Promise<Uint8Array>;
  destroy?(): Promise<void>;
}

const toHexString = (b: Uint8Array): string =>
  "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);
