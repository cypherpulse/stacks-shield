// =============================================================================
// STX Shield SDK -- shared types
// =============================================================================
// Strict, production types shared across every SDK module. All 32-byte
// protocol values (commitments, nullifiers, roots, note ids) are `Bytes32`.

export type Bytes = Uint8Array;
export type Bytes32 = Uint8Array; // exactly 32 bytes (validated at boundaries)
export type Bytes33 = Uint8Array; // compressed secp256k1 public key
export type Hex = string; // 0x-prefixed lowercase hex

/** The five protocol operations, matching zk-verifier proof-type ids. */
export enum ProofType {
  Shield = 1,
  Transfer = 2,
  Withdrawal = 3,
  Split = 4,
  Merge = 5,
}

/** Fee types, matching protocol-fees fee-type ids. */
export enum FeeType {
  Shield = 1,
  Transfer = 2,
  Withdrawal = 3,
  Relayer = 4,
}

/** A shielded note as known to its owner (secrets included — never serialized
 *  to chain). Amounts are micro-STX. */
export interface Note {
  readonly amount: bigint;
  readonly ownerPkX: bigint;
  readonly ownerPkY: bigint;
  readonly ownerSk: bigint;
  readonly blinding: bigint;
  /** Poseidon note commitment == on-chain note id / tree leaf. */
  readonly commitment: Bytes32;
  /** Opaque owner commitment stored on chain (never a principal). */
  readonly ownerCommitment: Bytes32;
}

/** A single committee attestation over a proof. */
export interface Attestation {
  readonly signature: Bytes; // 64-byte compact secp256k1 (r||s)
  readonly signer: Bytes33; // compressed public key
}

/** A generated proof plus everything needed to submit and verify it. */
export interface GeneratedProof {
  readonly proofType: ProofType;
  readonly circuitVersion: number;
  readonly proof: Bytes; // serialized UltraHonk proof bytes
  readonly publicInputs: readonly Hex[]; // field elements, hex
  readonly publicInputsHash: Bytes32; // sha256(to-consensus-buff? {...})
  readonly vkeyHash: Bytes32;
  /** The attestation-message hash == on-chain proof-id. */
  readonly proofId: Bytes32;
}

/** Merkle authentication path for a leaf. */
export interface MerklePath {
  readonly leaf: Bytes32;
  readonly index: number;
  readonly indexBits: readonly (0 | 1)[]; // length TREE_DEPTH
  readonly siblings: readonly Bytes32[]; // length TREE_DEPTH
  readonly root: Bytes32;
}

/** Network + contract configuration. */
export interface ShieldConfig {
  readonly network: "mainnet" | "testnet" | "devnet";
  readonly coreApiUrl: string;
  readonly deployerAddress: string; // contract deployer principal
  readonly contracts: {
    readonly registry: string;
    readonly notes: string;
    readonly fees: string;
    readonly verifier: string;
    readonly pool: string;
    readonly splitMerge: string;
  };
  /** How many attestor signatures to gather (the on-chain threshold). */
  readonly attestationThreshold: number;
  readonly treeDepth: number; // 20
}

export const TREE_DEPTH = 20;
export const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const ATTESTATION_DOMAIN = "stx-shield-attestation-v1";

/** Fatal SDK errors carry a machine-readable code for callers to branch on. */
export class ShieldError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ShieldError";
  }
}
