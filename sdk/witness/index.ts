// =============================================================================
// STX Shield SDK -- witness generation
// =============================================================================
// Assembles the private + public witness maps consumed by each Noir circuit
// (via Nargo's TOML / the Noir JS ABI). Field elements are emitted as
// 0x-hex strings, matching the circuits' `Field` inputs. Amounts and secrets
// appear ONLY in the private witness and never leave the prover.

import { bytes32ToField } from "../utilities/crypto.js";
import {
  ProofType,
  type MerklePath,
  type Note,
  TREE_DEPTH,
} from "../types.js";

type FieldHex = string;
const f = (v: bigint): FieldHex => "0x" + v.toString(16);
const leafField = (n: Note) => bytes32ToField(n.commitment);

const pathFields = (p: MerklePath) => ({
  index: p.indexBits.map((b) => b.toString()),
  siblings: p.siblings.map((s) => f(bytes32ToField(s))),
});

/** Split witness (1 -> 2). */
export function splitWitness(args: {
  input: Note;
  path: MerklePath;
  out1: Note;
  out2: Note;
  circuitVersion: number;
}): Record<string, unknown> {
  const { input, path, out1, out2, circuitVersion } = args;
  const p = pathFields(path);
  return {
    op: f(BigInt(ProofType.Split)),
    old_note: f(leafField(input)),
    nullifier: f(bytes32ToField(input.commitment)), // placeholder; overwritten by caller
    commitment_1: f(leafField(out1)),
    owner_commitment_1: f(bytes32ToField(out1.ownerCommitment)),
    commitment_2: f(leafField(out2)),
    owner_commitment_2: f(bytes32ToField(out2.ownerCommitment)),
    merkle_root: f(bytes32ToField(path.root)),
    circuit_version: f(BigInt(circuitVersion)),
    input: noteWitness(input),
    owner_sk: f(input.ownerSk),
    merkle_index: p.index,
    merkle_siblings: p.siblings,
    out_1: noteWitness(out1),
    out_2: noteWitness(out2),
  };
}

/** Merge witness (2 -> 1). */
export function mergeWitness(args: {
  input1: Note;
  path1: MerklePath;
  input2: Note;
  path2: MerklePath;
  output: Note;
  circuitVersion: number;
}): Record<string, unknown> {
  const { input1, path1, input2, path2, output, circuitVersion } = args;
  const p1 = pathFields(path1);
  const p2 = pathFields(path2);
  return {
    op: f(BigInt(ProofType.Merge)),
    old_note_1: f(leafField(input1)),
    old_note_2: f(leafField(input2)),
    commitment: f(leafField(output)),
    owner_commitment: f(bytes32ToField(output.ownerCommitment)),
    merkle_root: f(bytes32ToField(path1.root)),
    circuit_version: f(BigInt(circuitVersion)),
    input_1: noteWitness(input1),
    owner_sk_1: f(input1.ownerSk),
    merkle_index_1: p1.index,
    merkle_siblings_1: p1.siblings,
    input_2: noteWitness(input2),
    owner_sk_2: f(input2.ownerSk),
    merkle_index_2: p2.index,
    merkle_siblings_2: p2.siblings,
    output: noteWitness(output),
  };
}

function noteWitness(n: Note) {
  return {
    amount: f(n.amount),
    owner_pk_x: f(n.ownerPkX),
    owner_pk_y: f(n.ownerPkY),
    blinding: f(n.blinding),
  };
}

export const treeDepth = TREE_DEPTH;
