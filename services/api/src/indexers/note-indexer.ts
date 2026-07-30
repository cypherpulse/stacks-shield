// =============================================================================
// STX Shield API -- note indexer
// =============================================================================
// Tracks shield / transfer / split / merge / withdraw print events and stores
// the resulting commitments, transactions and fees. It NEVER learns amounts
// for in-pool operations (transfer/split/merge carry no amount on chain) nor
// which wallet owns a commitment.

import type { DecodedEvent } from "./decode.js";
import { asHex, asInt, asBig } from "./decode.js";
import { insertNote, recordTransaction, upsertRoot } from "./store.js";

export const NOTE_EVENTS = new Set([
  "shielded",
  "transferred",
  "note-split",
  "note-merge",
  "withdrawn",
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
    default:
      return false;
  }
};
