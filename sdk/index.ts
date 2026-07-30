// =============================================================================
// STX Shield SDK -- public API
// =============================================================================
// The one entry point applications use. Ties together commitments, nullifiers,
// the Merkle tree, witness + proof generation, attestation collection, fee
// calculation, and transaction building into the five user operations, plus
// tree synchronization, confirmation waiting, and stale-root retries.
//
// Design: pure orchestration. Every cryptographic and protocol rule is enforced
// on chain by the frozen contracts; the SDK is a correct, ergonomic client.

export * from "./types.js";
export * as crypto from "./utilities/crypto.js";
export * from "./commitments/index.js";
export * from "./nullifiers/index.js";
export { MerkleTree } from "./roots/merkle-tree.js";
export { RootClient } from "./roots/client.js";
export * as publicInputs from "./proofs/public-inputs.js";
export { UltraHonkProver, loadArtifact } from "../zk/barretenberg/proving/prover.js";
export * as witness from "./witness/index.js";
export { AttestationClient, attestationMessage, verifyAttestation } from "./attestations/index.js";
export { calculateFee, withdrawalNet, type FeeConfig } from "./fees/index.js";
export { TransactionBuilder, type ContractCall } from "./transactions/index.js";

import { createNote, ownerKeyFromSecret, type OwnerKey } from "./commitments/index.js";
import { computeNullifier } from "./nullifiers/index.js";
import { MerkleTree } from "./roots/merkle-tree.js";
import { RootClient } from "./roots/client.js";
import { TransactionBuilder, type ContractCall } from "./transactions/index.js";
import { AttestationClient, attestationMessage } from "./attestations/index.js";
import { UltraHonkProver } from "../zk/barretenberg/proving/prover.js";
import { splitWitness, mergeWitness } from "./witness/index.js";
import * as PI from "./proofs/public-inputs.js";
import { calculateFee, type FeeConfig } from "./fees/index.js";
import { randomField, fieldToBytes32, toHex } from "./utilities/crypto.js";
import {
  ProofType,
  type Bytes32,
  type Note,
  type ShieldConfig,
  ShieldError,
} from "./types.js";

/** Everything a submitter needs: the built contract call and the local notes
 *  the operation produced (to persist in the wallet). */
export interface OperationResult {
  readonly call: ContractCall;
  readonly proofId: Bytes32;
  readonly newNotes: readonly Note[];
  readonly newRoot: Bytes32;
}

export interface ShieldClientDeps {
  readonly config: ShieldConfig;
  readonly rootClient: RootClient;
  readonly attestations: AttestationClient;
  /** proof type -> prover (compiled circuit + backend). */
  readonly provers: ReadonlyMap<ProofType, UltraHonkProver>;
  /** current on-chain circuit version. */
  readonly circuitVersion: number;
  /** live fee configs by type + the registry ceiling. */
  readonly feeConfigs: ReadonlyMap<number, FeeConfig>;
  readonly maxFeeBps: bigint;
}

export class ShieldClient {
  private readonly tx: TransactionBuilder;
  private readonly tree: MerkleTree;

  constructor(private readonly deps: ShieldClientDeps) {
    this.tx = new TransactionBuilder(deps.config);
    this.tree = deps.rootClient.localTree;
  }

  /** Current on-chain Merkle root. */
  getCurrentRoot(): Promise<Bytes32> {
    return this.deps.rootClient.getCurrentRoot();
  }

  /** Derive an owner key from a wallet-provided 32-byte secret. */
  static ownerKey(secret: Bytes32): OwnerKey {
    return ownerKeyFromSecret(secret);
  }

  // ---- SPLIT (1 -> 2) ----------------------------------------------------
  async split(args: {
    inputNote: Note;
    inputLeafIndex: number;
    owner: OwnerKey;
    amount1: bigint;
    amount2: bigint;
    recipient1: OwnerKey;
    recipient2: OwnerKey;
  }): Promise<OperationResult> {
    if (args.amount1 + args.amount2 !== args.inputNote.amount)
      throw new ShieldError("VALUE_MISMATCH", "split amounts must sum to the input");

    return this.deps.rootClient.retryRootUpdates(async (currentRoot) => {
      const out1 = createNote(args.amount1, args.recipient1);
      const out2 = createNote(args.amount2, args.recipient2);
      const nullifier = computeNullifier(args.inputNote);
      const path = this.tree.proof(args.inputLeafIndex);

      // locally project the new root after inserting both leaves
      const projected = this.projectRoot([out1.commitment, out2.commitment]);

      const wit = splitWitness({
        input: args.inputNote,
        path,
        out1,
        out2,
        circuitVersion: this.deps.circuitVersion,
      });
      // fill the nullifier the circuit expects
      (wit as Record<string, unknown>).nullifier = toHex(nullifier);

      const prover = this.prover(ProofType.Split);
      const { proof, vkeyHash } = await prover.prove(wit);

      const meta1 = randomMetadata();
      const meta2 = randomMetadata();
      const publicInputsHash = PI.splitInputsHash({
        oldNote: args.inputNote.commitment,
        nullifier,
        commitment1: out1.commitment,
        ownerCommitment1: out1.ownerCommitment,
        metadata1: meta1,
        commitment2: out2.commitment,
        ownerCommitment2: out2.ownerCommitment,
        metadata2: meta2,
        currentRoot,
        newRoot: projected,
      });
      const attestations = await this.deps.attestations.collect({
        proofType: ProofType.Split,
        circuitVersion: this.deps.circuitVersion,
        vkeyHash,
        publicInputsHash,
        proof,
      });
      const proofId = attestationMessage({
        proofType: ProofType.Split,
        circuitVersion: this.deps.circuitVersion,
        vkeyHash,
        publicInputsHash,
        proof,
      });

      const call = this.tx.split({
        oldNote: args.inputNote.commitment,
        nullifier,
        commitment1: out1.commitment,
        ownerCommitment1: out1.ownerCommitment,
        metadata1: meta1,
        commitment2: out2.commitment,
        ownerCommitment2: out2.ownerCommitment,
        metadata2: meta2,
        currentRoot,
        newRoot: projected,
        proof,
        attestations,
      });
      return {
        submit: async () => ({ call, proofId, newNotes: [out1, out2], newRoot: projected }),
      };
    });
  }

  // ---- MERGE (2 -> 1) ----------------------------------------------------
  async merge(args: {
    inputNote1: Note;
    inputLeafIndex1: number;
    inputNote2: Note;
    inputLeafIndex2: number;
    recipient: OwnerKey;
  }): Promise<OperationResult> {
    return this.deps.rootClient.retryRootUpdates(async (currentRoot) => {
      const output = createNote(
        args.inputNote1.amount + args.inputNote2.amount,
        args.recipient,
      );
      const nullifier1 = computeNullifier(args.inputNote1);
      const nullifier2 = computeNullifier(args.inputNote2);
      const path1 = this.tree.proof(args.inputLeafIndex1);
      const path2 = this.tree.proof(args.inputLeafIndex2);
      const projected = this.projectRoot([output.commitment]);

      const wit = mergeWitness({
        input1: args.inputNote1,
        path1,
        input2: args.inputNote2,
        path2,
        output,
        circuitVersion: this.deps.circuitVersion,
      });
      (wit as Record<string, unknown>).nullifier_1 = toHex(nullifier1);
      (wit as Record<string, unknown>).nullifier_2 = toHex(nullifier2);

      const prover = this.prover(ProofType.Merge);
      const { proof, vkeyHash } = await prover.prove(wit);

      const meta = randomMetadata();
      const publicInputsHash = PI.mergeInputsHash({
        oldNote1: args.inputNote1.commitment,
        nullifier1,
        oldNote2: args.inputNote2.commitment,
        nullifier2,
        commitment: output.commitment,
        ownerCommitment: output.ownerCommitment,
        metadata: meta,
        currentRoot,
        newRoot: projected,
      });
      const attestations = await this.deps.attestations.collect({
        proofType: ProofType.Merge,
        circuitVersion: this.deps.circuitVersion,
        vkeyHash,
        publicInputsHash,
        proof,
      });
      const proofId = attestationMessage({
        proofType: ProofType.Merge,
        circuitVersion: this.deps.circuitVersion,
        vkeyHash,
        publicInputsHash,
        proof,
      });

      const call = this.tx.merge({
        oldNote1: args.inputNote1.commitment,
        nullifier1,
        oldNote2: args.inputNote2.commitment,
        nullifier2,
        commitment: output.commitment,
        ownerCommitment: output.ownerCommitment,
        metadata: meta,
        currentRoot,
        newRoot: projected,
        proof,
        attestations,
      });
      return { submit: async () => ({ call, proofId, newNotes: [output], newRoot: projected }) };
    });
  }

  /** Fee quote for an operation amount and type. */
  quoteFee(feeType: number, amount: bigint): bigint {
    const cfg = this.deps.feeConfigs.get(feeType);
    if (!cfg) return 0n;
    return calculateFee(cfg, amount, this.deps.maxFeeBps);
  }

  private prover(t: ProofType): UltraHonkProver {
    const p = this.deps.provers.get(t);
    if (!p) throw new ShieldError("NO_PROVER", `no prover registered for proof type ${t}`);
    return p;
  }

  /** Project the next root after appending `leaves`, without mutating the
   *  canonical tree — the wallet commits leaves only after on-chain
   *  confirmation, keeping local and chain state consistent under retries. */
  private projectRoot(leaves: readonly Bytes32[]): Bytes32 {
    return this.tree.projectRoot(leaves);
  }
}

const randomMetadata = (): Bytes32 => fieldToBytes32(randomField());
