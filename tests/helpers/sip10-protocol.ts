// =============================================================================
// Shared SIP-10 protocol test harness
// =============================================================================
// Drives the REAL SIP-10 stack (asset-registry, sip10-protocol-fees,
// sip10-zk-verifier, sip10-pool) plus the shared frozen registry + note-manager
// and two mock SIP-010 tokens, through every user operation with genuine
// aggregation inclusion proofs -- exactly as production will. Mirrors the STX
// `Protocol` harness so the two suites read the same way.
//
// Proofs: the SIP-10 pool computes an asset-aware inputs-hash; this harness
// reproduces it (sdk/public-inputs/sip10), builds a real keccak Merkle tree over
// the statement leaf, publishes the root to `sip10-zk-verifier`, and submits the
// inclusion path -- so on-chain verification is genuinely exercised, and
// cross-asset isolation is testable (a proof aggregated for asset A's inputs-hash
// simply is not present when the pool recomputes the hash for asset B).

import { Cl } from "@stacks/transactions";
import { bytes32 } from "./attestation.js";
import { Aggregator, bindingFor, statementLeaf, TEST_CONTEXT, type Inclusion } from "./aggregation.js";
import {
  shieldPublicInputsSip10,
  transferPublicInputsSip10,
  withdrawPublicInputsSip10,
  splitPublicInputsSip10,
  mergePublicInputsSip10,
} from "../../sdk/public-inputs/sip10.js";

export const REGISTRY = "privacy-registry";
export const NOTES = "note-manager";
export const ASSET_REGISTRY = "asset-registry";
export const FEES = "sip10-protocol-fees";
export const VERIFIER = "sip10-zk-verifier";
export const POOL = "sip10-pool";

export const GENESIS_ROOT = bytes32(1, 0x47);
export const PROOF_LEN = 448;
export const CIRCUIT_VERSION = 2;
export const VKEY = { 1: bytes32(1, 0x6a), 2: bytes32(2, 0x6a), 3: bytes32(3, 0x6a), 4: bytes32(4, 0x6a), 5: bytes32(5, 0x6a) } as const;

/** A registered test asset. */
export interface Asset {
  name: string;        // contract name, e.g. "mock-sbtc"
  uid: number;         // asset-registry uid
  decimals: number;
}

/** On-chain note handle (commitment/nullifier are opaque test bytes; the pool
 *  and verifier never check well-formedness -- the circuits do, and those are
 *  nargo-tested). `amount`/`asset` are harness bookkeeping for conservation. */
export interface Note {
  commitment: Uint8Array;
  nullifier: Uint8Array;
  ownerCommitment: Uint8Array;
  metadata: Uint8Array;
  leafIndex: number;
  amount: number;
  asset: string;
  spent: boolean;
}

export class Sip10Protocol {
  readonly deployer: string;
  readonly aggregator: Aggregator;
  readonly feeRecipient: string;
  private root: Uint8Array = GENESIS_ROOT;
  private rootCounter = 1;
  private noteSeq = 0;
  private leafCount = 0;
  readonly assets = new Map<string, Asset>();

  constructor(deployer: string, feeRecipient: string, aggregator = new Aggregator(7)) {
    this.deployer = deployer;
    this.feeRecipient = feeRecipient;
    this.aggregator = aggregator;
  }

  get currentRoot(): Uint8Array { return this.root; }
  tokenPrincipal(name: string): string { return `${this.deployer}.${name}`; }
  assetUid(name: string): number {
    const a = this.assets.get(name);
    if (!a) throw new Error(`asset ${name} not registered`);
    return a.uid;
  }

  // ---- setup ----------------------------------------------------------------

  /** Wire the SIP-10 stack: authorize the pool on the shared registry, bootstrap
   *  the tree, register vkeys + bindings on the SIP-10 verifier, bind the pool,
   *  seat a relayer. Mirrors the deployment runbook. */
  wire(): void {
    // sip10-pool must be a registry authorized caller (commitments/nullifiers/
    // roots) AND drives note-manager, which itself calls back into the registry
    // (record-note-created) -- so note-manager must ALSO be authorized. In the
    // real deployment the STX runbook already authorized note-manager; a fresh
    // SIP-10-only simnet must add both.
    this.regCall("add-authorized-caller", [Cl.contractPrincipal(this.deployer, POOL)]);
    this.regCall("add-authorized-caller", [Cl.contractPrincipal(this.deployer, NOTES)]);
    this.regCall("update-root", [Cl.buffer(GENESIS_ROOT), Cl.uint(1)]);
    // SIP-10 verifier: vkeys + bindings + pool authorization + relayer.
    for (const t of [1, 2, 3, 4, 5] as const) {
      simnet.callPublicFn(VERIFIER, "register-verification-key",
        [Cl.uint(t), Cl.uint(CIRCUIT_VERSION), Cl.buffer(VKEY[t]), Cl.uint(PROOF_LEN)], this.deployer);
    }
    this.configureBindings([1, 2, 3, 4, 5]);
    // The verifier's active circuit-version defaults to 1; advance it to match the
    // vkeys/bindings just registered (what the pool passes to verify-proof).
    simnet.callPublicFn(VERIFIER, "set-circuit-version", [Cl.uint(CIRCUIT_VERSION)], this.deployer);
    simnet.callPublicFn(VERIFIER, "add-relayer", [Cl.principal(this.deployer)], this.deployer);
    simnet.callPublicFn(VERIFIER, "set-authorized-pool", [Cl.contractPrincipal(this.deployer, POOL)], this.deployer);
  }

  configureBindings(proofTypes: number[]): void {
    simnet.callPublicFn(VERIFIER, "set-zkverify-context-hash", [Cl.buffer(TEST_CONTEXT)], this.deployer);
    for (const t of proofTypes) {
      const b = bindingFor(t);
      simnet.callPublicFn(VERIFIER, "set-zkverify-binding",
        [Cl.uint(t), Cl.uint(CIRCUIT_VERSION), Cl.buffer(b.zkvVkeyHash), Cl.buffer(b.versionHash)], this.deployer);
    }
  }

  /** Register a mock token as a supported asset with generous limits. */
  registerAsset(name: string, decimals: number, opts: { minShield?: number; maxShield?: number } = {}): number {
    const res = simnet.callPublicFn(ASSET_REGISTRY, "register-asset", [
      Cl.contractPrincipal(this.deployer, name),
      Cl.stringAscii(name),
      Cl.uint(decimals),
      Cl.uint(opts.minShield ?? 1),
      Cl.uint(opts.maxShield ?? 1_000_000_000_000_000),
      Cl.uint(1),                 // min-note
      Cl.uint(0),                 // max-note (0 = unlimited)
      Cl.principal(this.feeRecipient),
      Cl.uint(1),                 // version
    ], this.deployer);
    if (res.result.type !== "ok") throw new Error(`register-asset ${name} failed: ${JSON.stringify(res.result)}`);
    const uid = Number((res.result as unknown as { value: { value: bigint } }).value.value);
    this.assets.set(name, { name, uid, decimals });
    return uid;
  }

  /** Mint test tokens to a user. */
  mint(name: string, amount: number, recipient: string) {
    return simnet.callPublicFn(name, "mint", [Cl.uint(amount), Cl.principal(recipient)], this.deployer);
  }

  // ---- operations -----------------------------------------------------------

  shield(user: string, asset: string, amount: number) {
    const note = this.mkNote(amount, asset);
    const currentRoot = this.root;
    const newRoot = this.nextRoot();
    const leafIndex = this.leafCount;
    const inputsHash = shieldPublicInputsSip10({
      commitment: note.commitment, ownerCommitment: note.ownerCommitment,
      amount: BigInt(amount), oldRoot: currentRoot, newRoot, leafIndex,
      token: this.tokenPrincipal(asset), circuitVersion: CIRCUIT_VERSION,
    });
    const res = simnet.callPublicFn(POOL, "shield", [
      Cl.contractPrincipal(this.deployer, asset),
      Cl.uint(amount), Cl.buffer(note.commitment), Cl.buffer(note.ownerCommitment),
      Cl.buffer(note.metadata), Cl.buffer(currentRoot), Cl.buffer(newRoot), Cl.uint(leafIndex),
      ...this.proofArgs(1, inputsHash),
    ], user);
    if (res.result.type === "ok") { note.leafIndex = this.assignLeaf(); this.root = newRoot; }
    return { result: res.result, note };
  }

  transfer(user: string, input: Note, assetOverride?: string) {
    const asset = assetOverride ?? input.asset;
    const out = this.mkNote(input.amount, asset);
    const currentRoot = this.root;
    const newRoot = this.nextRoot();
    const leafIndex = this.leafCount;
    const inputsHash = transferPublicInputsSip10({
      nullifier: input.nullifier, newCommitment: out.commitment, newOwnerCommitment: out.ownerCommitment,
      merkleRoot: currentRoot, newRoot, leafIndex, token: this.tokenPrincipal(asset), circuitVersion: CIRCUIT_VERSION,
    });
    const res = simnet.callPublicFn(POOL, "transfer", [
      Cl.contractPrincipal(this.deployer, asset),
      Cl.buffer(input.nullifier), Cl.buffer(out.commitment), Cl.buffer(out.ownerCommitment),
      Cl.buffer(out.metadata), Cl.buffer(currentRoot), Cl.buffer(newRoot), Cl.uint(leafIndex),
      ...this.proofArgs(2, inputsHash),
    ], user);
    if (res.result.type === "ok") { input.spent = true; out.leafIndex = this.assignLeaf(); this.root = newRoot; }
    return { result: res.result, note: out };
  }

  split(user: string, input: Note, a: number, b: number) {
    const asset = input.asset;
    const out1 = this.mkNote(a, asset);
    const out2 = this.mkNote(b, asset);
    const currentRoot = this.root;
    const newRoot = this.nextRoot();
    const leafIndex = this.leafCount;
    const inputsHash = splitPublicInputsSip10({
      nullifier: input.nullifier, commitment1: out1.commitment, ownerCommitment1: out1.ownerCommitment,
      commitment2: out2.commitment, ownerCommitment2: out2.ownerCommitment,
      merkleRoot: currentRoot, newRoot, leafIndex, token: this.tokenPrincipal(asset), circuitVersion: CIRCUIT_VERSION,
    });
    const res = simnet.callPublicFn(POOL, "split", [
      Cl.contractPrincipal(this.deployer, asset),
      Cl.buffer(input.nullifier),
      Cl.buffer(out1.commitment), Cl.buffer(out1.ownerCommitment), Cl.buffer(out1.metadata),
      Cl.buffer(out2.commitment), Cl.buffer(out2.ownerCommitment), Cl.buffer(out2.metadata),
      Cl.buffer(currentRoot), Cl.buffer(newRoot), Cl.uint(leafIndex),
      ...this.proofArgs(4, inputsHash),
    ], user);
    if (res.result.type === "ok") { input.spent = true; out1.leafIndex = this.assignLeaf(); out2.leafIndex = this.assignLeaf(); this.root = newRoot; }
    return { result: res.result, notes: [out1, out2] as [Note, Note] };
  }

  merge(user: string, in1: Note, in2: Note) {
    const asset = in1.asset;
    const out = this.mkNote(in1.amount + in2.amount, asset);
    const currentRoot = this.root;
    const newRoot = this.nextRoot();
    const leafIndex = this.leafCount;
    const inputsHash = mergePublicInputsSip10({
      nullifier1: in1.nullifier, nullifier2: in2.nullifier, commitment: out.commitment,
      ownerCommitment: out.ownerCommitment, merkleRoot: currentRoot, newRoot, leafIndex,
      token: this.tokenPrincipal(asset), circuitVersion: CIRCUIT_VERSION,
    });
    const res = simnet.callPublicFn(POOL, "merge-notes", [
      Cl.contractPrincipal(this.deployer, asset),
      Cl.buffer(in1.nullifier), Cl.buffer(in2.nullifier), Cl.buffer(out.commitment),
      Cl.buffer(out.ownerCommitment), Cl.buffer(out.metadata),
      Cl.buffer(currentRoot), Cl.buffer(newRoot), Cl.uint(leafIndex),
      ...this.proofArgs(5, inputsHash),
    ], user);
    if (res.result.type === "ok") { in1.spent = true; in2.spent = true; out.leafIndex = this.assignLeaf(); this.root = newRoot; }
    return { result: res.result, note: out };
  }

  withdraw(user: string, input: Note, recipient: string, amount = input.amount, opts: { assetOverride?: string; rootOverride?: Uint8Array } = {}) {
    const asset = opts.assetOverride ?? input.asset;
    const root = opts.rootOverride ?? this.root;
    const inputsHash = withdrawPublicInputsSip10({
      nullifier: input.nullifier, amount: BigInt(amount), recipient, merkleRoot: root,
      token: this.tokenPrincipal(asset), circuitVersion: CIRCUIT_VERSION,
    });
    const res = simnet.callPublicFn(POOL, "withdraw", [
      Cl.contractPrincipal(this.deployer, asset),
      Cl.buffer(input.nullifier), Cl.uint(amount), Cl.principal(recipient), Cl.buffer(root),
      ...this.proofArgs(3, inputsHash),
    ], user);
    if (res.result.type === "ok") input.spent = true;
    return { result: res.result };
  }

  // ---- proof plumbing (SIP-10 verifier) -------------------------------------

  aggregate(proofType: number, publicInputsHash: Uint8Array): Inclusion {
    const inc = this.aggregator.aggregate(statementLeaf(bindingFor(proofType), publicInputsHash));
    simnet.callPublicFn(VERIFIER, "submit-aggregation",
      [Cl.uint(inc.domainId), Cl.uint(inc.aggregationId), Cl.buffer(inc.root), Cl.uint(inc.leafCount)], this.deployer);
    return inc;
  }
  proofArgs(proofType: number, publicInputsHash: Uint8Array) {
    const inc = this.aggregate(proofType, publicInputsHash);
    return [Cl.uint(inc.domainId), Cl.uint(inc.aggregationId), Cl.list(inc.path.map((p) => Cl.buffer(p))), Cl.uint(inc.leafIndex)];
  }

  // ---- building blocks ------------------------------------------------------

  mkNote(amount: number, asset: string): Note {
    const n = ++this.noteSeq;
    return {
      commitment: bytes32(n, 0x3c), nullifier: bytes32(n, 0x4e), ownerCommitment: bytes32(n, 0x4f),
      metadata: bytes32(n, 0x4d), leafIndex: -1, amount, asset, spent: false,
    };
  }
  nextRoot(): Uint8Array { return bytes32(++this.rootCounter, 0x52); }
  private assignLeaf(): number { return this.leafCount++; }

  // ---- reads / invariants ---------------------------------------------------

  regCall(fn: string, args: unknown[]) { return simnet.callPublicFn(REGISTRY, fn, args as never, this.deployer); }

  poolTokenBalance(asset: string): bigint {
    const cv = simnet.callReadOnlyFn(asset, "get-balance", [Cl.contractPrincipal(this.deployer, POOL)], this.deployer).result;
    return BigInt(((cv as { value: { value: bigint } }).value).value);
  }
  shieldedTotal(asset: string): bigint {
    const cv = simnet.callReadOnlyFn(POOL, "get-shielded-total", [Cl.uint(this.assetUid(asset))], this.deployer).result;
    return BigInt((cv as { value: bigint }).value);
  }
  feeTreasury(asset: string): bigint {
    const cv = simnet.callReadOnlyFn(FEES, "get-asset-treasury", [Cl.uint(this.assetUid(asset))], this.deployer).result;
    const tuple = (cv as { value: { balance: { value: bigint } } }).value;
    return BigInt(tuple.balance.value);
  }

  /** The core conservation invariant, per asset: pool token balance == shielded total. */
  assertConservation(asset: string): void {
    const bal = this.poolTokenBalance(asset);
    const shielded = this.shieldedTotal(asset);
    if (bal !== shielded) {
      throw new Error(`conservation violated for ${asset}: pool balance ${bal} != shielded total ${shielded}`);
    }
  }
}
