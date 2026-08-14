// =============================================================================
// @stacks-shield/sdk -- local note vault
// =============================================================================
// Durable, LOCAL persistence for a wallet's own notes, so a failed API write (or
// a page refresh) can never lose a note — the note's blinding lives only in its
// encrypted payload, so if that payload is neither stored on the API nor kept
// locally, the funds become unspendable.
//
// SAFETY: what is persisted is the note's CIPHERTEXT (already encrypted to the
// owner's viewing key) plus public locators (commitment/root/txid/leafIndex).
// The viewing SECRET that decrypts it is derived from the wallet each session and
// is NEVER persisted — so a vault at rest reveals nothing, exactly like the API's
// stored ciphertext. Inject one via `new STXShield({ noteVault })`.

/** A locally-persisted note: encrypted payload + public locators. */
export interface PersistedNote {
  commitment: string;
  /** Encrypted-to-viewing-key payload (safe at rest). */
  ciphertext: string;
  root: string;
  txid: string;
  leafIndex?: number;
  /** SIP-10 asset uid; undefined = native STX. */
  assetId?: number;
  spent: boolean;
}

/** Pluggable local store. Methods may be sync or async. */
export interface NoteVault {
  /** Upsert a note by commitment. */
  put(note: PersistedNote): Promise<void> | void;
  /** All persisted notes for this wallet. */
  all(): Promise<PersistedNote[]> | PersistedNote[];
  /** Flag a note spent (kept for audit; discovery filters it out). */
  setSpent(commitment: string): Promise<void> | void;
  /** Forget a note entirely — for rolling back a note whose creating tx
   *  reverted, so a phantom deposit can never appear as spendable funds. */
  remove(commitment: string): Promise<void> | void;
}

/** Browser vault backed by localStorage. Use in web apps:
 *  `new STXShield({ ..., noteVault: localStorageVault() })`. */
export const localStorageVault = (storageKey = "stxshield.notes"): NoteVault => {
  const store = (): Storage | undefined => (globalThis as { localStorage?: Storage }).localStorage;
  const read = (): PersistedNote[] => {
    try {
      return JSON.parse(store()?.getItem(storageKey) ?? "[]") as PersistedNote[];
    } catch {
      return [];
    }
  };
  const write = (notes: PersistedNote[]): void => {
    try {
      store()?.setItem(storageKey, JSON.stringify(notes));
    } catch {
      /* storage full / unavailable — nothing else we can safely do */
    }
  };
  return {
    put(note) {
      write([...read().filter((n) => n.commitment !== note.commitment), note]);
    },
    all() {
      return read();
    },
    setSpent(commitment) {
      write(read().map((n) => (n.commitment === commitment ? { ...n, spent: true } : n)));
    },
    remove(commitment) {
      write(read().filter((n) => n.commitment !== commitment));
    },
  };
};

/** In-memory vault (tests / non-persistent Node). */
export const memoryVault = (): NoteVault => {
  const map = new Map<string, PersistedNote>();
  return {
    put(note) {
      map.set(note.commitment, note);
    },
    all() {
      return [...map.values()];
    },
    setSpent(commitment) {
      const n = map.get(commitment);
      if (n) map.set(commitment, { ...n, spent: true });
    },
    remove(commitment) {
      map.delete(commitment);
    },
  };
};
