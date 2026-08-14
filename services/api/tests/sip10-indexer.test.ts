// =============================================================================
// STX Shield API -- SIP-10 indexer routing tests
// =============================================================================
// Verifies the note indexer handles the SIP-10 pool events (asset-tagged, same
// shapes as native) and that the shared registry's commitment-registered event
// feeds the single Merkle tree. The store is mocked, so this asserts the routing
// + asset extraction without a database (and without the config import chain).

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../src/indexers/store.js", () => ({
  insertNote: vi.fn(async () => {}),
  recordTransaction: vi.fn(async () => true),
  upsertRoot: vi.fn(async () => {}),
  upsertCommitmentLeaf: vi.fn(async () => {}),
}));

import { Cl, serializeCV } from "@stacks/transactions";
import * as store from "../src/indexers/store.js";
import { decodeEvent } from "../src/indexers/decode.js";
import { handleNoteEvent, handleCommitmentEvent, NOTE_EVENTS } from "../src/indexers/note-indexer.js";

const SBTC = "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.sbtc-token";
const [SBTC_ADDR, SBTC_NAME] = SBTC.split(".") as [string, string];
const buf = (b: string) => Cl.bufferFromHex(b.repeat(32));

const decode = (fields: Record<string, ReturnType<typeof Cl.uint>>) =>
  decodeEvent(serializeCV(Cl.tuple(fields)))!;

beforeEach(() => vi.clearAllMocks());

describe("SIP-10 note indexing", () => {
  it("indexes sip10-shielded with its asset and commitment", async () => {
    const ev = decode({
      event: Cl.stringAscii("sip10-shielded"),
      "asset-id": Cl.uint(1),
      token: Cl.contractPrincipal(SBTC_ADDR, SBTC_NAME),
      commitment: buf("aa"),
      "leaf-index": Cl.uint(5),
      amount: Cl.uint(10_000_000),
      fee: Cl.uint(0),
      "new-root": buf("bb"),
      height: Cl.uint(100),
    });
    expect(await handleNoteEvent(ev, "0xtx1")).toBe(true);
    expect(store.insertNote).toHaveBeenCalledWith(
      expect.objectContaining({ commitment: "0x" + "aa".repeat(32), leafIndex: 5, type: "shield", assetId: 1 }),
    );
    expect(store.recordTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ txid: "0xtx1", type: "shield", assetId: 1 }),
    );
  });

  it("indexes sip10-transferred / sip10-merged output commitments with the asset", async () => {
    await handleNoteEvent(decode({
      event: Cl.stringAscii("sip10-transferred"), "asset-id": Cl.uint(2),
      "new-commitment": buf("cc"), "leaf-index": Cl.uint(6), fee: Cl.uint(0), "new-root": buf("bb"), height: Cl.uint(101),
    }), "0xtx2");
    expect(store.insertNote).toHaveBeenCalledWith(expect.objectContaining({ type: "transfer", assetId: 2, leafIndex: 6 }));

    await handleNoteEvent(decode({
      event: Cl.stringAscii("sip10-merged"), "asset-id": Cl.uint(1),
      "nullifier-1": buf("11"), "nullifier-2": buf("12"), commitment: buf("dd"), "leaf-index": Cl.uint(7),
      fee: Cl.uint(0), "new-root": buf("bb"), height: Cl.uint(102),
    }), "0xtx3");
    expect(store.insertNote).toHaveBeenCalledWith(expect.objectContaining({ type: "merge", assetId: 1, leafIndex: 7 }));
  });

  it("records sip10-split as a tx but NOT its commitments (those come from the registry)", async () => {
    const ev = decode({
      event: Cl.stringAscii("sip10-split"), "asset-id": Cl.uint(1), nullifier: buf("11"),
      "leaf-1": Cl.uint(8), "leaf-2": Cl.uint(9), fee: Cl.uint(0), "new-root": buf("bb"), height: Cl.uint(103),
    });
    expect(await handleNoteEvent(ev, "0xtx4")).toBe(true);
    expect(store.recordTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: "split", assetId: 1 }));
    expect(store.insertNote).not.toHaveBeenCalled(); // commitments not in the event
  });

  it("records sip10-withdrawn as a tx with its asset", async () => {
    const ev = decode({
      event: Cl.stringAscii("sip10-withdrawn"), "asset-id": Cl.uint(2), nullifier: buf("11"),
      amount: Cl.uint(5_000_000), fee: Cl.uint(0), recipient: Cl.standardPrincipal("ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG"), height: Cl.uint(104),
    });
    expect(await handleNoteEvent(ev, "0xtx5")).toBe(true);
    expect(store.recordTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: "withdraw", assetId: 2 }));
    expect(store.insertNote).not.toHaveBeenCalled();
  });

  it("feeds the shared tree from the registry commitment-registered event", async () => {
    const ev = decode({
      event: Cl.stringAscii("commitment-registered"), commitment: buf("ee"), index: Cl.uint(9), version: Cl.uint(1), height: Cl.uint(105),
    });
    expect(await handleCommitmentEvent(ev, "0xtx6")).toBe(true);
    expect(store.upsertCommitmentLeaf).toHaveBeenCalledWith({ commitment: "0x" + "ee".repeat(32), txid: "0xtx6", leafIndex: 9 });
  });
});

describe("native STX indexing is unchanged", () => {
  it("indexes a native shielded event with no asset id", async () => {
    const ev = decode({
      event: Cl.stringAscii("shielded"), commitment: buf("aa"), "leaf-index": Cl.uint(1),
      amount: Cl.uint(1_000_000), fee: Cl.uint(300), "new-root": buf("bb"), height: Cl.uint(1),
    });
    expect(await handleNoteEvent(ev, "0xtxn")).toBe(true);
    const call = (store.insertNote as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as { assetId?: number };
    expect(call.assetId).toBeUndefined(); // native path passes no assetId
    expect(store.recordTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: "shield", feeMicro: 300n }));
  });

  it("registers the SIP-10 events in NOTE_EVENTS", () => {
    for (const e of ["sip10-shielded", "sip10-transferred", "sip10-split", "sip10-merged", "sip10-withdrawn"]) {
      expect(NOTE_EVENTS.has(e)).toBe(true);
    }
  });
});
