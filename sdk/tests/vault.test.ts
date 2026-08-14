// =============================================================================
// @stx-shield/sdk -- local note vault + durability
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { localStorageVault, memoryVault, type PersistedNote } from "../src/vault.js";
import { discoverNotes } from "../src/notes/index.js";
import { commitmentOf } from "../src/crypto/commitments.js";
import { toHex32, hexToBytes } from "../src/crypto/field.js";
import { generateViewingKeyPair, encryptNote, encodeEncryptedNote, toHex } from "../src/crypto/encryption.js";

const fakeLocalStorage = (): Storage => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as Storage;
};

afterEach(() => vi.unstubAllGlobals());

const note: PersistedNote = { commitment: "0xaa", ciphertext: "0xcc", root: "0xrr", txid: "0xtt", leafIndex: 3, assetId: 1, spent: false };

describe("note vaults (CRUD)", () => {
  it("localStorageVault: upsert by commitment + setSpent, persisted across instances", async () => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    const v = localStorageVault();
    await v.put(note);
    await v.put({ ...note, leafIndex: 5 }); // upsert (same commitment)
    expect(await localStorageVault().all()).toHaveLength(1); // a fresh instance reads the same store
    expect((await v.all())[0]!.leafIndex).toBe(5);
    await v.setSpent("0xaa");
    expect((await v.all())[0]!.spent).toBe(true);
  });

  it("memoryVault: upsert + setSpent", async () => {
    const v = memoryVault();
    await v.put(note);
    await v.put({ ...note, leafIndex: 9 });
    expect(await v.all()).toHaveLength(1);
    await v.setSpent("0xaa");
    expect((await v.all())[0]!.spent).toBe(true);
  });

  it("localStorageVault degrades gracefully with no localStorage", async () => {
    vi.stubGlobal("localStorage", undefined);
    const v = localStorageVault();
    await v.put(note); // must not throw
    expect(await v.all()).toEqual([]);
  });
});

describe("vault durability", () => {
  it("a vaulted note is re-discoverable even when the API feed is empty (refresh / lost API write)", () => {
    const owner = { sk: 5n, pkX: 111n, pkY: 222n };
    const viewing = generateViewingKeyPair();
    const amount = 1000n, blinding = 42n;
    const cHex = toHex32(commitmentOf({ amount, ownerPkX: owner.pkX, ownerPkY: owner.pkY, blinding }));
    const enc = encryptNote({ version: 1, amount, blinding, ownerSk: owner.sk, nonce: 1n, commitment: hexToBytes(cHex), treePosition: 0 }, viewing.publicKey);
    const ciphertext = "0x" + toHex(encodeEncryptedNote(enc));

    // The vault holds the note as a discovery record; the API feed is empty.
    const found = discoverNotes([{ commitment: cHex, ciphertext, root: "0x", txid: "0x", spent: false }], viewing, owner, []);
    expect(found).toHaveLength(1);
    expect(found[0]!.amount).toBe(1000n); // amount recovered locally — funds not lost
  });
});
