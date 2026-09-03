/*
  Attestation crypto helpers for STX Shield tests.

  Reproduces, byte for byte, the two hash constructions the contracts use:

  1. public-inputs-hash (privacy-pool):
       sha256( to-consensus-buff?({ ...operation parameters }) )
     -> replicated with sha256(serializeCVBytes(Cl.tuple({ ... })))

  2. attestation message (zk-verifier):
       sha256( to-consensus-buff?({ domain, proof-type, circuit-version,
                                    vkey-hash, public-inputs-hash, proof-hash }) )

  Attestors sign the attestation message with secp256k1 (compact 64-byte
  signatures, verified on-chain by secp256k1-verify).
*/

import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Cl, serializeCVBytes, type ClarityValue } from "@stacks/transactions";

export const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(data).digest());

/** sha256 over the consensus serialization of a Clarity value —
 *  the TS mirror of (sha256 (unwrap-panic (to-consensus-buff? v))). */
export const hashCV = (cv: ClarityValue): Uint8Array =>
  sha256(serializeCVBytes(cv));

export const ATTESTATION_DOMAIN = "stx-shield-attestation-v1";

/** Deterministic 32-byte value: one prefix byte + 32-bit counter. */
export const bytes32 = (n: number, prefix = 0x3c): Uint8Array => {
  const b = new Uint8Array(32);
  b[0] = prefix;
  b[28] = (n >>> 24) & 0xff;
  b[29] = (n >>> 16) & 0xff;
  b[30] = (n >>> 8) & 0xff;
  b[31] = n & 0xff;
  return b;
};

/** Deterministic pseudo-proof of exactly `length` bytes. */
export const proofBytes = (n: number, length: number): Uint8Array => {
  const b = new Uint8Array(length);
  for (let i = 0; i < length; i++) b[i] = (n + i * 7) & 0xff;
  return b;
};

/** A deterministic attestation-committee member. */
export class Attestor {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array; // 33-byte compressed

  constructor(seedByte: number) {
    if (seedByte < 1 || seedByte > 255) throw new Error("seedByte must be 1..255");
    const priv = new Uint8Array(32);
    priv.fill(seedByte);
    this.privateKey = priv;
    this.publicKey = secp256k1.getPublicKey(priv, true) as Uint8Array;
  }

  /** Compact 64-byte (r || s) signature over a 32-byte message hash.
   *
   *  `prehash: false` is REQUIRED: noble v2's sign() otherwise re-hashes the
   *  input (signing sha256(messageHash)), but Clarity's secp256k1-verify
   *  checks the signature against the 32-byte message directly. Without this
   *  flag every on-chain verification fails. */
  sign(messageHash: Uint8Array): Uint8Array {
    const sig: unknown = secp256k1.sign(messageHash, this.privateKey, {
      prehash: false,
    });
    if (sig instanceof Uint8Array) return sig;
    return (sig as { toCompactRawBytes(): Uint8Array }).toCompactRawBytes();
  }

  /** Clarity attestation tuple { signature, signer } for verify-proof. */
  attest(messageHash: Uint8Array) {
    return Cl.tuple({
      signature: Cl.buffer(this.sign(messageHash)),
      signer: Cl.buffer(this.publicKey),
    });
  }
}

/** The zk-verifier attestation message hash (= the on-chain proof-id). */
export const attestationMessage = (opts: {
  proofType: number;
  circuitVersion: number;
  vkeyHash: Uint8Array;
  publicInputsHash: Uint8Array;
  proof: Uint8Array;
}): Uint8Array =>
  hashCV(
    Cl.tuple({
      domain: Cl.stringAscii(ATTESTATION_DOMAIN),
      "proof-type": Cl.uint(opts.proofType),
      "circuit-version": Cl.uint(opts.circuitVersion),
      "vkey-hash": Cl.buffer(opts.vkeyHash),
      "public-inputs-hash": Cl.buffer(opts.publicInputsHash),
      "proof-hash": Cl.buffer(sha256(opts.proof)),
    })
  );

/*
  Public-input hashing now delegates to the SDK's canonical encoding, so the
  tests, the SDK, and the contracts cannot drift apart. The extra fields these
  helpers still accept (metadata, newRoot) are deliberately IGNORED: the
  circuits do not take them, so binding them would be exactly the mismatch the
  canonical encoding exists to prevent.
*/
import {
  shieldPublicInputs,
  transferPublicInputs,
  withdrawPublicInputs,
  splitPublicInputs,
  mergePublicInputs,
} from "../../sdk/public-inputs/index.js";

export const shieldInputsHash = (o: {
  commitment: Uint8Array;
  ownerCommitment: Uint8Array;
  metadata?: Uint8Array;
  amount: number | bigint;
  currentRoot: Uint8Array;
  newRoot: Uint8Array;
  leafIndex: number | bigint;
  circuitVersion?: number;
}): Uint8Array =>
  shieldPublicInputs({
    commitment: o.commitment,
    ownerCommitment: o.ownerCommitment,
    amount: BigInt(o.amount),
    oldRoot: o.currentRoot,
    newRoot: o.newRoot,
    leafIndex: o.leafIndex,
    circuitVersion: o.circuitVersion ?? 2,
  });

export const transferInputsHash = (o: {
  nullifier: Uint8Array;
  newCommitment: Uint8Array;
  newOwnerCommitment: Uint8Array;
  newMetadata?: Uint8Array;
  currentRoot: Uint8Array;
  newRoot: Uint8Array;
  leafIndex: number | bigint;
  circuitVersion?: number;
}): Uint8Array =>
  transferPublicInputs({
    nullifier: o.nullifier,
    newCommitment: o.newCommitment,
    newOwnerCommitment: o.newOwnerCommitment,
    merkleRoot: o.currentRoot,
    newRoot: o.newRoot,
    leafIndex: o.leafIndex,
    circuitVersion: o.circuitVersion ?? 2,
  });

export const withdrawInputsHash = (o: {
  nullifier: Uint8Array;
  amount: number | bigint;
  recipient: string;
  root: Uint8Array;
  circuitVersion?: number;
}): Uint8Array =>
  withdrawPublicInputs({
    nullifier: o.nullifier,
    amount: BigInt(o.amount),
    recipient: o.recipient,
    merkleRoot: o.root,
    circuitVersion: o.circuitVersion ?? 2,
  });

export const splitInputsHash = (o: {
  nullifier: Uint8Array;
  commitment1: Uint8Array;
  ownerCommitment1: Uint8Array;
  metadata1?: Uint8Array;
  commitment2: Uint8Array;
  ownerCommitment2: Uint8Array;
  metadata2?: Uint8Array;
  currentRoot: Uint8Array;
  newRoot: Uint8Array;
  leafIndex: number | bigint;
  circuitVersion?: number;
}): Uint8Array =>
  splitPublicInputs({
    nullifier: o.nullifier,
    commitment1: o.commitment1,
    ownerCommitment1: o.ownerCommitment1,
    commitment2: o.commitment2,
    ownerCommitment2: o.ownerCommitment2,
    merkleRoot: o.currentRoot,
    newRoot: o.newRoot,
    leafIndex: o.leafIndex,
    circuitVersion: o.circuitVersion ?? 2,
  });

export const mergeInputsHash = (o: {
  nullifier1: Uint8Array;
  nullifier2: Uint8Array;
  commitment: Uint8Array;
  ownerCommitment: Uint8Array;
  metadata?: Uint8Array;
  currentRoot: Uint8Array;
  newRoot: Uint8Array;
  leafIndex: number | bigint;
  circuitVersion?: number;
}): Uint8Array =>
  mergePublicInputs({
    nullifier1: o.nullifier1,
    nullifier2: o.nullifier2,
    commitment: o.commitment,
    ownerCommitment: o.ownerCommitment,
    merkleRoot: o.currentRoot,
    newRoot: o.newRoot,
    leafIndex: o.leafIndex,
    circuitVersion: o.circuitVersion ?? 2,
  });
