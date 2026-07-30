// =============================================================================
// @stx-shield/sdk -- bb.js proof engine (Node + browser)
// =============================================================================
// The validated prover. Uses @noir-lang/noir_js to build witnesses and
// @aztec/bb.js UltraHonkBackend { verifierTarget: "evm" } to prove — the exact
// flavor proven byte-compatible with the canonical `bb -t evm` CLI and accepted
// by zkVerify V3_0 for all five circuits (see BBJS-VALIDATION.md).
//
// bb.js is isomorphic, so this one engine serves Node and the browser. Circuit
// artifacts are provided via `loadArtifact` (read from disk in Node; fetch in
// the browser). @aztec/bb.js and @noir-lang/noir_js are imported lazily so they
// are never bundled unless proving is used.
//
// Browser note: WASM-thread proving requires cross-origin isolation
// (COOP: same-origin, COEP: require-corp). Set `threads: 1` to run
// single-threaded without those headers (slower).

import { ProofGenerationError } from "../errors/index.js";
import type {
  ProofEngine, OwnerKey, RawProof,
  ShieldWitness, TransferWitness, SplitWitness, MergeWitness, WithdrawWitness,
  NoteWitness, MembershipWitness,
} from "./engine.js";

export type CircuitName = "shield" | "transfer" | "split" | "merge" | "withdraw" | "keygen";

/** A compiled Noir circuit (the `target/<name>.json` produced by nargo). */
export interface CompiledCircuit {
  bytecode: string;
  abi?: unknown;
}

export interface BbjsEngineOptions {
  /** Loads a compiled circuit by name. Node: read the file; browser: fetch it. */
  loadArtifact: (name: CircuitName) => Promise<CompiledCircuit>;
  /** WASM threads. Default 4; use 1 in browsers without cross-origin isolation. */
  threads?: number;
}

const f = (x: bigint): string => "0x" + x.toString(16);
const noteInput = (n: NoteWitness) => ({
  amount: f(n.amount), owner_pk_x: f(n.ownerPkX), owner_pk_y: f(n.ownerPkY), blinding: f(n.blinding),
});
const idx = (m: MembershipWitness) => m.indexBits;
const sib = (m: MembershipWitness) => m.siblings.map(f);

export const createBbjsEngine = (opts: BbjsEngineOptions): ProofEngine => {
  const threads = opts.threads ?? 4;
  let apiP: Promise<any> | undefined;
  const noirCache = new Map<CircuitName, any>();
  const backendCache = new Map<CircuitName, any>();

  const api = async () => {
    if (!apiP) {
      apiP = (async () => {
        const { Barretenberg } = await import("@aztec/bb.js");
        return Barretenberg.new({ threads });
      })();
    }
    return apiP;
  };

  const noir = async (name: CircuitName): Promise<any> => {
    let n = noirCache.get(name);
    if (!n) {
      const { Noir } = await import("@noir-lang/noir_js");
      // The compiled circuit carries extra debug fields we don't require here.
      n = new Noir((await opts.loadArtifact(name)) as never);
      noirCache.set(name, n);
    }
    return n;
  };

  const backend = async (name: CircuitName): Promise<any> => {
    let b = backendCache.get(name);
    if (!b) {
      const { UltraHonkBackend } = await import("@aztec/bb.js");
      const artifact = await opts.loadArtifact(name);
      b = new UltraHonkBackend(artifact.bytecode, await api());
      backendCache.set(name, b);
    }
    return b;
  };

  const proveCircuit = async (name: CircuitName, inputs: Record<string, unknown>): Promise<RawProof> => {
    try {
      const n = await noir(name);
      const { witness } = await n.execute(inputs);
      const b = await backend(name);
      const opt = { verifierTarget: "evm" as const };
      const { proof, publicInputs } = await b.generateProof(witness, opt);
      const vk = await b.getVerificationKey(opt);
      // Browser- and Node-safe hex (no Node `Buffer`).
      const hex = (u: Uint8Array) => "0x" + Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");
      return {
        proof: hex(proof instanceof Uint8Array ? proof : new Uint8Array(proof)),
        publicInputs: publicInputs.map((p: string) => (p.startsWith("0x") ? p : "0x" + p)),
        vk: hex(vk),
      };
    } catch (e) {
      throw new ProofGenerationError(`${name} proof generation failed`, e);
    }
  };

  return {
    name: "bbjs",

    async deriveOwnerKey(secret: Uint8Array): Promise<OwnerKey> {
      // Reduce the 32-byte secret to a Grumpkin scalar, then run the keygen
      // circuit (owner_sk * G) so the key matches the circuits' assert_owner.
      let sk = 0n;
      for (const byte of secret) sk = (sk << 8n) | BigInt(byte);
      sk = (sk % (1n << 240n)) + 1n;
      try {
        const n = await noir("keygen");
        const { returnValue } = await n.execute({ owner_sk: f(sk) });
        const [pkX, pkY] = (returnValue as string[]).map((v) => BigInt(v));
        return { sk, pkX: pkX!, pkY: pkY! };
      } catch (e) {
        throw new ProofGenerationError("owner key derivation failed", e);
      }
    },

    proveShield(w: ShieldWitness): Promise<RawProof> {
      return proveCircuit("shield", {
        op: "1", commitment: f(w.commitment), owner_commitment: f(w.ownerCommitment),
        amount: f(w.note.amount), circuit_version: "1", note: noteInput(w.note),
      });
    },

    proveTransfer(w: TransferWitness): Promise<RawProof> {
      return proveCircuit("transfer", {
        op: "2", nullifier: f(w.nullifier), new_commitment: f(w.newCommitment),
        new_owner_commitment: f(w.newOwnerCommitment), merkle_root: f(w.membership.merkleRoot), circuit_version: "1",
        owner_sk: f(w.ownerSk), merkle_index: idx(w.membership), merkle_siblings: sib(w.membership),
        input: noteInput(w.input), output: noteInput(w.output),
      });
    },

    proveSplit(w: SplitWitness): Promise<RawProof> {
      return proveCircuit("split", {
        op: "4", nullifier: f(w.nullifier), commitment_1: f(w.commitment1), owner_commitment_1: f(w.ownerCommitment1),
        commitment_2: f(w.commitment2), owner_commitment_2: f(w.ownerCommitment2), merkle_root: f(w.membership.merkleRoot),
        circuit_version: "1", owner_sk: f(w.ownerSk), merkle_index: idx(w.membership), merkle_siblings: sib(w.membership),
        input: noteInput(w.input), out_1: noteInput(w.out1), out_2: noteInput(w.out2),
      });
    },

    proveMerge(w: MergeWitness): Promise<RawProof> {
      return proveCircuit("merge", {
        op: "5", nullifier_1: f(w.nullifier1), nullifier_2: f(w.nullifier2), commitment: f(w.commitment),
        owner_commitment: f(w.ownerCommitment), merkle_root: f(w.membership1.merkleRoot), circuit_version: "1",
        owner_sk_1: f(w.ownerSk1), merkle_index_1: idx(w.membership1), merkle_siblings_1: sib(w.membership1),
        owner_sk_2: f(w.ownerSk2), merkle_index_2: idx(w.membership2), merkle_siblings_2: sib(w.membership2),
        input_1: noteInput(w.input1), input_2: noteInput(w.input2), output: noteInput(w.output),
      });
    },

    proveWithdraw(w: WithdrawWitness): Promise<RawProof> {
      return proveCircuit("withdraw", {
        op: "3", nullifier: f(w.nullifier), amount: f(w.amount), recipient_hash: f(w.recipientHash),
        merkle_root: f(w.membership.merkleRoot), circuit_version: "1", owner_sk: f(w.ownerSk),
        merkle_index: idx(w.membership), merkle_siblings: sib(w.membership), input: noteInput(w.input),
      });
    },
  };
};
