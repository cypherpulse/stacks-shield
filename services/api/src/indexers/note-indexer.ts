// =============================================================================
// STX Shield API -- note indexer
// =============================================================================
// Tracks shield / transfer / split / merge / withdraw print events and stores
// the resulting commitments, transactions and fees. It NEVER learns amounts
// for in-pool operations (transfer/split/merge carry no amount on chain) nor
// which wallet owns a commitment.

import type { DecodedEvent } from "./decode.js";
import { asHex, asInt, asBig } from "./decode.js";
import { insertNote, recordTransaction, upsertRoot, upsertCommitmentLeaf } from "./store.js";

export const NOTE_EVENTS = new Set([
  // native STX (privacy-pool / split-merge-manager)
  "shielded",
  "transferred",
  "note-split",
  "note-merge",
  "withdrawn",
  // SIP-10 multi-asset (sip10-pool) — same shapes, asset-tagged
  "sip10-shielded",
  "sip10-transferred",
  "sip10-split",
  "sip10-merged",
  "sip10-withdrawn",
]);

/** Handle a single note-related event. Returns true if it was one. */
export const handleNoteEvent = async (ev: DecodedEvent, txid: string): Promise<boolean> => {
  const f = ev.fields;
  const height = asInt(f["height"]);
  const fee = asBig(f["fee"]);
  const newRoot = asHex(f["new-root"]);

  switch (ev.event) {
    case "shielded": {
      const commitment = asHex(f["commitment"]);
      if (commitment && newRoot) {
        await upsertRoot(newRoot, { height, txid });
        await insertNote({ commitment, root: newRoot, txid, leafIndex: asInt(f["leaf-index"]), type: "shield" });
      }
      await recordTransaction({ txid, type: "shield", height, feeMicro: fee });
      return true;
    }
    case "transferred": {
      const commitment = asHex(f["new-commitment"]);
      if (commitment && newRoot) {
        await upsertRoot(newRoot, { height, txid });
        await insertNote({ commitment, root: newRoot, txid, leafIndex: asInt(f["leaf-index"]), type: "transfer" });
      }
      await recordTransaction({ txid, type: "transfer", height, feeMicro: fee });
      return true;
    }
    case "note-split": {
      const c1 = asHex(f["commitment-1"]);
      const c2 = asHex(f["commitment-2"]);
      if (newRoot) await upsertRoot(newRoot, { height, txid });
      if (c1 && newRoot) await insertNote({ commitment: c1, root: newRoot, txid, leafIndex: asInt(f["leaf-1"]), type: "split" });
      if (c2 && newRoot) await insertNote({ commitment: c2, root: newRoot, txid, leafIndex: asInt(f["leaf-2"]), type: "split" });
      await recordTransaction({ txid, type: "split", height, feeMicro: fee });
      return true;
    }
    case "note-merge": {
      const commitment = asHex(f["commitment"]);
      if (commitment && newRoot) {
        await upsertRoot(newRoot, { height, txid });
        await insertNote({ commitment, root: newRoot, txid, leafIndex: asInt(f["leaf-index"]), type: "merge" });
      }
      await recordTransaction({ txid, type: "merge", height, feeMicro: fee });
      return true;
    }
    case "withdrawn": {
      // No new commitment; withdraw releases transparent STX. amount + recipient
      // are already public on chain, so recording the tx type is all we do.
      await recordTransaction({ txid, type: "withdraw", height, feeMicro: fee });
      return true;
    }

    // ---- SIP-10 (sip10-pool) --------------------------------------------
    // Same lifecycle as native, tagged with the asset uid. NOTE: the SIP-10 fee
    // is denominated in the TOKEN's base units, not micro-STX, so it is NOT
    // added to the STX fee total here (that stays a native-STX aggregate).
    case "sip10-shielded": {
      const assetId = asInt(f["asset-id"]);
      const commitment = asHex(f["commitment"]);
      if (commitment && newRoot) {
        await upsertRoot(newRoot, { height, txid });
        await insertNote({ commitment, root: newRoot, txid, leafIndex: asInt(f["leaf-index"]), type: "shield", assetId });
      }
      await recordTransaction({ txid, type: "shield", height, assetId });
      return true;
    }
    case "sip10-transferred": {
      const assetId = asInt(f["asset-id"]);
      const commitment = asHex(f["new-commitment"]);
      if (commitment && newRoot) {
        await upsertRoot(newRoot, { height, txid });
        await insertNote({ commitment, root: newRoot, txid, leafIndex: asInt(f["leaf-index"]), type: "transfer", assetId });
      }
      await recordTransaction({ txid, type: "transfer", height, assetId });
      return true;
    }
    case "sip10-split": {
      // The pool event carries only leaf indices; the two output commitments are
      // indexed from the shared registry's commitment-registered event (below).
      const assetId = asInt(f["asset-id"]);
      if (newRoot) await upsertRoot(newRoot, { height, txid });
      await recordTransaction({ txid, type: "split", height, assetId });
      return true;
    }
    case "sip10-merged": {
      const assetId = asInt(f["asset-id"]);
      const commitment = asHex(f["commitment"]);
      if (commitment && newRoot) {
        await upsertRoot(newRoot, { height, txid });
        await insertNote({ commitment, root: newRoot, txid, leafIndex: asInt(f["leaf-index"]), type: "merge", assetId });
      }
      await recordTransaction({ txid, type: "merge", height, assetId });
      return true;
    }
    case "sip10-withdrawn": {
      const assetId = asInt(f["asset-id"]);
      await recordTransaction({ txid, type: "withdraw", height, assetId });
      return true;
    }

    default:
      return false;
  }
};

/**
 * The shared privacy-registry's `commitment-registered` event: the authoritative,
 * asset-agnostic source for the SINGLE Merkle tree (every commitment + its leaf
 * index, native and SIP-10 alike, including SIP-10 split outputs whose pool event
 * omits the commitments). Idempotent and non-clobbering — it only fills the leaf
 * index, leaving type/asset/wallet/ciphertext to the pool event / owner. Returns
 * true if it handled the event.
 */
export const handleCommitmentEvent = async (ev: DecodedEvent, txid: string): Promise<boolean> => {
  if (ev.event !== "commitment-registered") return false;
  const commitment = asHex(ev.fields["commitment"]);
  if (commitment) {
    await upsertCommitmentLeaf({ commitment, txid, leafIndex: asInt(ev.fields["index"]) });
  }
  return true;
};
