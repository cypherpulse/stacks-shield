// =============================================================================
// Shared protocol test harness
// =============================================================================
// Drives the REAL 6-contract stack (registry, note-manager, fees, verifier,
// pool, split-merge-manager) through every user operation with genuine
// secp256k1 attestations, exactly as mainnet will. Used by the Phase 5
// production-readiness suites (integration / attacks / e2e / fuzz) so each
// suite stays concise and every operation exercises the same real path.
//
// A `Note` handle tracks the on-chain note id (== its commitment), its
// nullifier, tree leaf index, and its LOGICAL amount (hidden on chain; the
// harness tracks it to drive withdrawals and assert conservation).

import { Cl } from "@stacks/transactions";
import {
  bytes32,
  proofBytes,
  shieldInputsHash,
  transferInputsHash,
  withdrawInputsHash,
  splitInputsHash,
  mergeInputsHash,
} from "./attestation.js";
import { Aggregator, bindingFor, statementLeaf, TEST_CONTEXT, type Inclusion } from "./aggregation.js";

export const ONE_STX = 1_000_000;
export const PROOF_LEN = 448;
export const GENESIS_ROOT = bytes32(1, 0x47);
export const VKEY = {
  1: bytes32(1, 0x5a),
  2: bytes32(2, 0x5a),
  3: bytes32(3, 0x5a),
  4: bytes32(4, 0x5a),
  5: bytes32(5, 0x5a),
} as const;

export const REGISTRY = "privacy-registry";
export const NOTES = "note-manager";
export const VERIFIER = "zk-verifier";
export const FEES = "protocol-fees";
export const POOL = "privacy-pool";
export const MANAGER = "split-merge-manager";

export interface Note {
  commitment: Uint8Array;
  nullifier: Uint8Array;
  ownerCommitment: Uint8Array;
  metadata: Uint8Array;
  leafIndex: number;
  amount: number; // logical micro-STX, harness bookkeeping only
  spent: boolean;
}

export class Protocol {
  readonly deployer: string;
  /** Stands in for zkVerify: verifies statements and batches them into
   *  aggregations whose roots are published on chain. */
  readonly aggregator: Aggregator;
  private root: Uint8Array = GENESIS_ROOT;
  private rootCounter = 1;
  private noteSeq = 0;
  private opSeq = 0;

  /** Registered vkey hashes keyed by `${proofType}:${circuitVersion}`, kept in
   *  lockstep with the on-chain zk-verifier so statement leaves bind the
   *  circuit version the pool will verify against (survives upgrades). */
  private readonly vkeys = new Map<string, Uint8Array>();

  constructor(deployerAddr: string, aggregator = new Aggregator()) {
    this.deployer = deployerAddr;
    this.aggregator = aggregator;
  }

  get currentRoot(): Uint8Array {
    return this.root;
  }

  // ---- setup -----------------------------------------------------------
  /** Authorize the protocol callers, bootstrap the tree, register all five
   *  vkeys. Mirrors the deployment runbook (scripts/deployment/wire.ts).
   *  No committee is seated — none exists. */
  wire(): void {
    for (const c of [POOL, NOTES, MANAGER]) {
      this.regCall("add-authorized-caller", [Cl.contractPrincipal(this.deployer, c)]);
    }
    this.regCall("update-root", [Cl.buffer(GENESIS_ROOT), Cl.uint(1)]);
    // Register vkeys + bindings at the registry's live circuit version (v2), which
    // is what the pool passes to verify-proof.
    const cv = this.liveCircuitVersion();
    for (const t of [1, 2, 3, 4, 5] as const) {
      this.registerVkey(t, cv, VKEY[t]);
    }
    this.configureBindings([1, 2, 3, 4, 5], cv);
  }

  /** Register a vkey on chain AND record it locally so attestations for that
   *  (proofType, circuitVersion) bind the correct key. Used at wire time and
   *  during upgrade rehearsals to stage new-circuit vkeys. */
  registerVkey(
    proofType: number,
    circuitVersion: number,
    vkeyHash: Uint8Array,
    proofLen = PROOF_LEN,
  ) {
    const res = simnet.callPublicFn(
      VERIFIER,
      "register-verification-key",
      [Cl.uint(proofType), Cl.uint(circuitVersion), Cl.buffer(vkeyHash), Cl.uint(proofLen)],
      this.deployer,
    );
    this.vkeys.set(`${proofType}:${circuitVersion}`, vkeyHash);
    return res;
  }

  /** The registry's live circuit version (what the pool passes to verify-proof). */
  liveCircuitVersion(): number {
    const cv = this.read(REGISTRY, "get-circuit-version");
    return Number((cv as { value: bigint }).value);
  }

  private vkeyFor(proofType: number, circuitVersion: number): Uint8Array {
    const vk = this.vkeys.get(`${proofType}:${circuitVersion}`);
    if (!vk) throw new Error(`no vkey registered for ${proofType}:${circuitVersion}`);
    return vk;
  }

  grantRole(account: string, role: number): void {
    this.regCall("grant-role", [Cl.principal(account), Cl.uint(role)]);
  }

  // ---- operations ------------------------------------------------------

  /** Genuine shield: creates one ACTIVE note backed by `amount` uSTX. */
  shield(user: string, amount: number) {
    const note = this.mkNote(amount);
    const currentRoot = this.root;
    const newRoot = this.nextRoot();
    const leafIndex = this.leafCount; // the slot the registry will assign next
    const inputsHash = shieldInputsHash({
      circuitVersion: this.liveCircuitVersion(),
      commitment: note.commitment,
      ownerCommitment: note.ownerCommitment,
      metadata: note.metadata,
      amount,
      currentRoot,
      newRoot,
      leafIndex,
    });
    const res = simnet.callPublicFn(
      POOL,
      "shield",
      [
        Cl.uint(amount),
        Cl.buffer(note.commitment),
        Cl.buffer(note.ownerCommitment),
        Cl.buffer(note.metadata),
        Cl.buffer(currentRoot),
        Cl.buffer(newRoot),
        Cl.uint(leafIndex),
        ...this.proofArgs(1, inputsHash),
      ],
      user,
    );
    if (res.result.type === "ok") {
      note.leafIndex = this.assignLeaf();
      this.root = newRoot;
    }
    return { result: res.result, note };
  }

  /** Private transfer: consumes `input`, creates one new note of equal value. */
  transfer(user: string, input: Note) {
    const out = this.mkNote(input.amount);
    const currentRoot = this.root;
    const newRoot = this.nextRoot();
    const leafIndex = this.leafCount; // the slot the registry will assign next
    const inputsHash = transferInputsHash({
      circuitVersion: this.liveCircuitVersion(),
      nullifier: input.nullifier,
      newCommitment: out.commitment,
      newOwnerCommitment: out.ownerCommitment,
      newMetadata: out.metadata,
      currentRoot,
      newRoot,
      leafIndex,
    });
    const res = simnet.callPublicFn(
      POOL,
      "transfer",
      [
        Cl.buffer(input.nullifier),
        Cl.buffer(out.commitment),
        Cl.buffer(out.ownerCommitment),
        Cl.buffer(out.metadata),
        Cl.buffer(currentRoot),
        Cl.buffer(newRoot),
        Cl.uint(leafIndex),
        ...this.proofArgs(2, inputsHash),
      ],
      user,
    );
    if (res.result.type === "ok") {
      input.spent = true;
      out.leafIndex = this.assignLeaf();
      this.root = newRoot;
    }
    return { result: res.result, note: out };
  }

  /** Withdraw the note's full logical amount to `recipient`. Pass
   *  `rootOverride` to prove against a HISTORICAL root (still valid for
   *  withdrawals as long as the root has not been kill-switched). */
  withdraw(
    user: string,
    input: Note,
    recipient: string,
    amount = input.amount,
    rootOverride?: Uint8Array,
  ) {
    const root = rootOverride ?? this.root;
    const inputsHash = withdrawInputsHash({
      circuitVersion: this.liveCircuitVersion(),
      nullifier: input.nullifier,
      amount,
      recipient,
      root,
    });
    const res = simnet.callPublicFn(
      POOL,
      "withdraw",
      [
        Cl.buffer(input.nullifier),
        Cl.uint(amount),
        Cl.principal(recipient),
        Cl.buffer(root),
        ...this.proofArgs(3, inputsHash),
      ],
      user,
    );
    if (res.result.type === "ok") input.spent = true;
    return { result: res.result };
  }

  /** Split `input` into two notes of amounts `a` and `b` (a + b == input). */
  split(user: string, input: Note, a: number, b: number) {
    const out1 = this.mkNote(a);
    const out2 = this.mkNote(b);
    const currentRoot = this.root;
    const newRoot = this.nextRoot();
    const leafIndex = this.leafCount; // first output's slot; second is +1
    const inputsHash = splitInputsHash({
      circuitVersion: this.liveCircuitVersion(),
      nullifier: input.nullifier,
      commitment1: out1.commitment,
      ownerCommitment1: out1.ownerCommitment,
      metadata1: out1.metadata,
      commitment2: out2.commitment,
      ownerCommitment2: out2.ownerCommitment,
      metadata2: out2.metadata,
      currentRoot,
      newRoot,
      leafIndex,
    });
    const res = simnet.callPublicFn(
      MANAGER,
      "split-note",
      [
        Cl.buffer(input.nullifier),
        Cl.buffer(out1.commitment),
        Cl.buffer(out1.ownerCommitment),
        Cl.buffer(out1.metadata),
        Cl.buffer(out2.commitment),
        Cl.buffer(out2.ownerCommitment),
        Cl.buffer(out2.metadata),
        Cl.buffer(currentRoot),
        Cl.buffer(newRoot),
        Cl.uint(leafIndex),
        ...this.proofArgs(4, inputsHash),
      ],
      user,
    );
    if (res.result.type === "ok") {
      input.spent = true;
      out1.leafIndex = this.assignLeaf();
      out2.leafIndex = this.assignLeaf();
      this.root = newRoot;
    }
    return { result: res.result, notes: [out1, out2] as [Note, Note] };
  }

  /** Merge two notes into one of the summed value. */
  merge(user: string, in1: Note, in2: Note) {
    const out = this.mkNote(in1.amount + in2.amount);
    const currentRoot = this.root;
    const newRoot = this.nextRoot();
    const leafIndex = this.leafCount; // the slot the registry will assign next
    const inputsHash = mergeInputsHash({
      circuitVersion: this.liveCircuitVersion(),
      nullifier1: in1.nullifier,
      nullifier2: in2.nullifier,
      commitment: out.commitment,
      ownerCommitment: out.ownerCommitment,
      metadata: out.metadata,
      currentRoot,
      newRoot,
      leafIndex,
    });
    const res = simnet.callPublicFn(
      MANAGER,
      "merge-notes",
      [
        Cl.buffer(in1.nullifier),
        Cl.buffer(in2.nullifier),
        Cl.buffer(out.commitment),
        Cl.buffer(out.ownerCommitment),
        Cl.buffer(out.metadata),
        Cl.buffer(currentRoot),
        Cl.buffer(newRoot),
        Cl.uint(leafIndex),
        ...this.proofArgs(5, inputsHash),
      ],
      user,
    );
    if (res.result.type === "ok") {
      in1.spent = true;
      in2.spent = true;
      out.leafIndex = this.assignLeaf();
      this.root = newRoot;
    }
    return { result: res.result, note: out };
  }

  // ---- low-level building blocks (exposed for attack tests) ------------

  /** Build a fresh note handle (not yet on chain). */
  mkNote(amount: number): Note {
    const n = ++this.noteSeq;
    return {
      commitment: bytes32(n, 0x3c),
      nullifier: bytes32(n, 0x4e),
      ownerCommitment: bytes32(n, 0x4f),
      metadata: bytes32(n, 0x4d),
      leafIndex: -1,
      amount,
      spent: false,
    };
  }

  /** Deterministic, unique proof bytes per operation. */
  mkProof(): Uint8Array {
    return proofBytes(1_000_000 + ++this.opSeq, PROOF_LEN);
  }

  /** The zkVerify statement leaf for an operation, bound to the LIVE circuit
   *  version and its registered vkey — so it stays correct across circuit
   *  upgrades exactly as a real client would compute it. */
  leafFor(proofType: number, publicInputsHash: Uint8Array): Uint8Array {
    return statementLeaf(bindingFor(proofType), publicInputsHash);
  }

  /** Write the zkVerify binding on chain so `verify-proof` derives the same
   *  leaf this harness computes. Without it every operation fails closed with
   *  u320, which is the intended behaviour for an unconfigured circuit. */
  configureBindings(proofTypes: number[], circuitVersion = 1): void {
    simnet.callPublicFn(
      VERIFIER,
      "set-zkverify-context-hash",
      [Cl.buffer(TEST_CONTEXT)],
      this.deployer,
    );
    for (const t of proofTypes) {
      const b = bindingFor(t);
      simnet.callPublicFn(
        VERIFIER,
        "set-zkverify-binding",
        [
          Cl.uint(t),
          Cl.uint(circuitVersion),
          Cl.buffer(b.zkvVkeyHash),
          Cl.buffer(b.versionHash),
        ],
        this.deployer,
      );
    }
  }

  /** Full round trip for one operation: zkVerify verifies the statement and
   *  aggregates it, the root is published on chain, and the caller receives
   *  the inclusion proof to submit. No signatures anywhere. */
  aggregate(proofType: number, publicInputsHash: Uint8Array): Inclusion {
    const inc = this.aggregator.aggregate(this.leafFor(proofType, publicInputsHash));
    this.publish(inc);
    return inc;
  }

  /** Publish an aggregation root on chain (idempotent — a root already
   *  published is left alone, mirroring append-only semantics). */
  publish(inc: Inclusion) {
    return simnet.callPublicFn(
      VERIFIER,
      "submit-aggregation",
      [
        Cl.uint(inc.domainId),
        Cl.uint(inc.aggregationId),
        Cl.buffer(inc.root),
        Cl.uint(inc.leafCount),
      ],
      this.deployer,
    );
  }

  /** The four inclusion arguments every operation passes to the contracts. */
  inclusionArgs(inc: Inclusion) {
    return [
      Cl.uint(inc.domainId),
      Cl.uint(inc.aggregationId),
      Cl.list(inc.path.map((p) => Cl.buffer(p))),
      Cl.uint(inc.leafIndex),
    ];
  }

  /** Convenience: aggregate + publish + return call arguments. */
  proofArgs(proofType: number, publicInputsHash: Uint8Array) {
    return this.inclusionArgs(this.aggregate(proofType, publicInputsHash));
  }

  nextRoot(): Uint8Array {
    return bytes32(++this.rootCounter, 0x52);
  }

  private leafCount = 0;
  private assignLeaf(): number {
    return this.leafCount++;
  }

  // ---- reads -----------------------------------------------------------
  regCall(fn: string, args: unknown[]) {
    return simnet.callPublicFn(REGISTRY, fn, args as never, this.deployer);
  }
  read(contract: string, fn: string, args: unknown[] = []) {
    return simnet.callReadOnlyFn(contract, fn, args as never, this.deployer).result;
  }
  poolBalance(): bigint {
    const cv = simnet.callReadOnlyFn(POOL, "get-pool-balance", [], this.deployer).result;
    return BigInt((cv as { value: bigint }).value);
  }
  totalShielded(): bigint {
    const cv = this.read(REGISTRY, "get-total-shielded-stx");
    return BigInt((cv as { value: bigint }).value);
  }
}
