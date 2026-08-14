// =============================================================================
// @stx-shield/sdk -- Phase 5: asset-aware scanner (discoverNotes)
// =============================================================================
// A discovered note is tagged with its asset (from the payload), the asset-bound
// commitment is confirmed, and both native STX and SIP-10 notes are found with
// no duplicate scanning. Unknown assets are skipped.

import { describe, it, expect } from "vitest";
import { discoverNotes } from "../src/notes/index.js";
import { commitmentOf, assetFieldOf } from "../src/crypto/commitments.js";
import { toHex32, hexToBytes } from "../src/crypto/field.js";
import { generateViewingKeyPair, encryptNote, encodeEncryptedNote, toHex } from "../src/crypto/encryption.js";
import type { AssetInfo } from "../src/types/asset.js";
import type { EncryptedNoteRecord } from "../src/providers/api.js";

const STX: AssetInfo = { id: 0, symbol: "STX", token: null, decimals: 6, active: true, native: true, pool: "D.privacy-pool", verifier: "D.zk-verifier", splitMerge: "D.split-merge-manager", protocolFees: "D.protocol-fees" };
const SBTC: AssetInfo = { id: 1, symbol: "sBTC", token: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.sbtc-token", decimals: 8, active: true, native: false, pool: "D.sip10-pool", verifier: "D.sip10-zk-verifier", splitMerge: "D.sip10-pool", protocolFees: "D.sip10-protocol-fees" };

const owner = { sk: 5n, pkX: 111n, pkY: 222n };
const viewing = generateViewingKeyPair();

/** Build an encrypted on-chain record for a note the `owner` owns. */
const record = (amount: bigint, blinding: bigint, assetId?: number): EncryptedNoteRecord => {
  const assetField = assetId ? assetFieldOf(SBTC.token as string) : undefined;
  const commitment = commitmentOf({ amount, ownerPkX: owner.pkX, ownerPkY: owner.pkY, blinding, assetField });
  const cHex = toHex32(commitment);
  const enc = encryptNote(
    { version: 1, amount, blinding, ownerSk: owner.sk, nonce: 1n, commitment: hexToBytes(cHex), treePosition: 0, assetId },
    viewing.publicKey,
  );
  return { commitment: cHex, ciphertext: "0x" + toHex(encodeEncryptedNote(enc)), root: "0x", txid: "0x" };
};

describe("asset-aware discovery", () => {
  it("tags a native STX note as native and a SIP-10 note with its asset", () => {
    const recs = [record(1000n, 333n /* STX */), record(2000n, 444n, SBTC.id /* sBTC */)];
    const found = discoverNotes(recs, viewing, owner, [STX, SBTC]);
    expect(found).toHaveLength(2);

    const stx = found.find((n) => n.amount === 1000n)!;
    expect(stx.asset).toBeUndefined(); // native
    expect(stx.secret.assetField).toBeUndefined();

    const sbtc = found.find((n) => n.amount === 2000n)!;
    expect(sbtc.asset?.symbol).toBe("sBTC");
    expect(sbtc.secret.assetId).toBe(1);
    expect(sbtc.secret.assetField).toBe(assetFieldOf(SBTC.token as string));
  });

  it("skips a note whose asset id is unknown to us", () => {
    // A record encrypted with assetId 99 (not in our asset list) is unspendable.
    const rec = record(500n, 555n, 99);
    expect(discoverNotes([rec], viewing, owner, [STX, SBTC])).toHaveLength(0);
  });

  it("skips notes addressed to a different viewing key (no false positives)", () => {
    const other = generateViewingKeyPair();
    expect(discoverNotes([record(1000n, 333n)], other, owner, [STX, SBTC])).toHaveLength(0);
  });

  it("is backward compatible: STX-only discovery with no asset list", () => {
    const found = discoverNotes([record(1000n, 333n)], viewing, owner);
    expect(found).toHaveLength(1);
    expect(found[0]!.asset).toBeUndefined();
  });
});
