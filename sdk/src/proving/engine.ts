// =============================================================================
// @stacks-shield/sdk -- proof engine interface
// =============================================================================
// The ONLY place zero-knowledge lives. Everything the developer would need to
// know about Noir, UltraHonk, Grumpkin keys, witnesses and zkVerify is hidden
// behind this interface. Two implementations ship:
//
//   * NodeCliEngine  -- uses the local Noir/Barretenberg toolchain. This is the
//                       flow proven end-to-end on testnet.
//   * (browser WASM) -- a bb.js-based engine is the roadmap; until its proofs
//                       are validated against zkVerify it is not enabled.
//
// An engine takes a fully-specified witness and returns the on-chain inclusion
// proof the contracts need. It submits the proof to zkVerify and waits for
// aggregation internally -- callers never see any of it.

export interface OwnerKey {
  /** Grumpkin spending secret. */
  sk: bigint;
  /** Grumpkin public point. */
  pkX: bigint;
  pkY: bigint;
}

/** The zkVerify inclusion proof the contracts re-check. */
export interface Inclusion {
  domainId: number;
  aggregationId: number;
  /** Aggregation Merkle root (published on chain by the relayer network). */
  root: string;
  leafCount: number;
  /** Merkle path proving the statement is inside the aggregation. */
  merklePath: string[];
  leafIndex: number;
}

export interface ProvedOperation {
  inclusion: Inclusion;
}

/**
 * The raw UltraHonk proof an engine produces before zkVerify submission.
 * Validated byte-compatible between `@aztec/bb.js` (verifierTarget "evm") and
 * the canonical `bb -t evm` CLI: identical vk, identical public inputs,
 * identical statement leaf, verifies. All fields are 0x-hex.
 */
export interface RawProof {
  proof: string;
  publicInputs: string[];
  vk: string;
}

// ---- witnesses (all field values are bigint / hex, prepared by the SDK) ----

export interface NoteWitness {
  amount: bigint;
  ownerPkX: bigint;
  ownerPkY: bigint;
  blinding: bigint;
}
/** Present ⇒ prove against the SIP-10 circuit family, binding this asset_id
 *  (= fePrincipal(token)) as a public input. Absent/0 ⇒ native STX circuits. */
export interface AssetBound {
  assetField?: bigint;
}
export interface ShieldWitness extends AssetBound {
  note: NoteWitness;
  commitment: bigint;
  ownerCommitment: bigint;
}
export interface MembershipWitness {
  /** Boolean path (little-endian) + sibling hashes for the input note. */
  indexBits: boolean[];
  siblings: bigint[];
  merkleRoot: bigint;
}
export interface TransferWitness extends AssetBound {
  nullifier: bigint;
  newCommitment: bigint;
  newOwnerCommitment: bigint;
  input: NoteWitness;
  ownerSk: bigint;
  output: NoteWitness;
  membership: MembershipWitness;
}
export interface SplitWitness extends AssetBound {
  nullifier: bigint;
  commitment1: bigint;
  ownerCommitment1: bigint;
  commitment2: bigint;
  ownerCommitment2: bigint;
  input: NoteWitness;
  ownerSk: bigint;
  out1: NoteWitness;
  out2: NoteWitness;
  membership: MembershipWitness;
}
export interface MergeWitness extends AssetBound {
  nullifier1: bigint;
  nullifier2: bigint;
  commitment: bigint;
  ownerCommitment: bigint;
  input1: NoteWitness;
  ownerSk1: bigint;
  membership1: MembershipWitness;
  input2: NoteWitness;
  ownerSk2: bigint;
  membership2: MembershipWitness;
  output: NoteWitness;
}
export interface WithdrawWitness extends AssetBound {
  nullifier: bigint;
  amount: bigint;
  recipientHash: bigint;
  input: NoteWitness;
  ownerSk: bigint;
  membership: MembershipWitness;
}

export interface ProofEngine {
  /** Human-readable engine name, e.g. "bbjs". */
  readonly name: string;
  /** Derive a Grumpkin owner key from a 32-byte secret (matches assert_owner). */
  deriveOwnerKey(secret: Uint8Array): Promise<OwnerKey>;
  proveShield(w: ShieldWitness): Promise<RawProof>;
  proveTransfer(w: TransferWitness): Promise<RawProof>;
  proveSplit(w: SplitWitness): Promise<RawProof>;
  proveMerge(w: MergeWitness): Promise<RawProof>;
  proveWithdraw(w: WithdrawWitness): Promise<RawProof>;
}

/** Submits a RawProof to zkVerify and returns the on-chain inclusion proof. */
export interface ProofSubmitter {
  submit(proof: RawProof): Promise<Inclusion>;
}
