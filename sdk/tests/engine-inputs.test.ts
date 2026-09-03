// =============================================================================
// @stx-shield/sdk -- Phases 4-9: engine circuit routing + asset_id binding
// =============================================================================
// The engine picks the SIP-10 circuit and binds asset_id iff the witness carries
// `assetField`; otherwise it uses the native circuits, unchanged.

import { describe, it, expect } from "vitest";
import {
  shieldInputs, transferInputs, splitInputs, mergeInputs, withdrawInputs,
} from "../src/proving/bbjs.js";

const note = { amount: 100n, ownerPkX: 1n, ownerPkY: 2n, blinding: 7n };
const membership = { indexBits: [false, true], siblings: [3n, 4n], merkleRoot: 5n };
const insertion = { leafIndex: 6, indexBits: [false, true], siblings: [3n, 4n], oldRoot: 5n, newRoot: 12n };
const insertion2 = { leafIndex: 7, indexBits: [true, true], siblings: [3n, 4n], oldRoot: 12n, newRoot: 13n };
const AF = 777n; // asset_id
const hexAF = "0x" + AF.toString(16);

const shieldW = (assetField?: bigint) => ({ note, commitment: 10n, ownerCommitment: 11n, insertion, assetField });
const transferW = (assetField?: bigint) => ({ nullifier: 1n, newCommitment: 2n, newOwnerCommitment: 3n, input: note, ownerSk: 9n, output: note, membership, insertion, assetField });
const splitW = (assetField?: bigint) => ({ nullifier: 1n, commitment1: 2n, ownerCommitment1: 3n, commitment2: 4n, ownerCommitment2: 5n, input: note, ownerSk: 9n, out1: note, out2: note, membership, insertion1: insertion, insertion2, assetField });
const mergeW = (assetField?: bigint) => ({ nullifier1: 1n, nullifier2: 2n, commitment: 3n, ownerCommitment: 4n, input1: note, ownerSk1: 9n, membership1: membership, input2: note, ownerSk2: 9n, membership2: membership, output: note, insertion, assetField });
const withdrawW = (assetField?: bigint) => ({ nullifier: 1n, amount: 100n, recipientHash: 8n, input: note, ownerSk: 9n, membership, assetField });

const cases = [
  { name: "shield", native: "shield", sip10: "sip10-shield", build: shieldInputs, w: shieldW },
  { name: "transfer", native: "transfer", sip10: "sip10-transfer", build: transferInputs, w: transferW },
  { name: "split", native: "split", sip10: "sip10-split", build: splitInputs, w: splitW },
  { name: "merge", native: "merge", sip10: "sip10-merge", build: mergeInputs, w: mergeW },
  { name: "withdraw", native: "withdraw", sip10: "sip10-withdraw", build: withdrawInputs, w: withdrawW },
] as const;

describe("engine circuit routing", () => {
  for (const c of cases) {
    const expectInsertion = (inputs: Record<string, unknown>) => {
      // both families are v2 and bind the tree insertion identically.
      expect(inputs["circuit_version"]).toBe("2");
      // every leaf-adding op carries new_root + leaf_index; withdraw adds none.
      if (c.name === "withdraw") {
        expect("new_root" in inputs).toBe(false);
        expect("leaf_index" in inputs).toBe(false);
      } else {
        expect("new_root" in inputs).toBe(true);
        expect("leaf_index" in inputs).toBe(true);
      }
    };
    it(`${c.name}: native path — STX circuit, no asset_id, v2`, () => {
      const { circuit, inputs } = (c.build as (w: unknown) => { circuit: string; inputs: Record<string, unknown> })(c.w(undefined));
      expect(circuit).toBe(c.native);
      expect("asset_id" in inputs).toBe(false);
      expectInsertion(inputs);
    });
    it(`${c.name}: SIP-10 path — sip10 circuit, asset_id bound, v2`, () => {
      const { circuit, inputs } = (c.build as (w: unknown) => { circuit: string; inputs: Record<string, unknown> })(c.w(AF));
      expect(circuit).toBe(c.sip10);
      expect(inputs["asset_id"]).toBe(hexAF);
      expectInsertion(inputs);
    });
  }
});
