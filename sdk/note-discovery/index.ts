// =============================================================================
// STX Shield SDK -- note discovery
// =============================================================================
// How a receiver finds notes addressed to them, without revealing that they
// are the receiver.
//
//   for each published (commitment, encryptedPayload):
//       try to decrypt with my viewing secret
//       if it decrypts -> the note is mine; record it with its tree position
//       if it does not  -> ignore, silently
//
// This is trial decryption. It is deliberately "dumb": the scanner asks the
// chain for ALL payloads and filters locally. Any scheme where the client asks
// for *its own* notes would tell the server who it is — the leak we are
// removing. Scanning cost is linear in pool activity, which is the price of
// receiver privacy and is why the viewing key is separate and cheap to give to
// a scanning service you do not otherwise trust with spending.

import {
  decodeEncryptedNote,
  tryDecryptNote,
  type NotePayload,
  type ViewingKeyPair,
} from "../encryption/index.js";
import { CommitmentTree } from "../merkle-tree/index.js";
import type { Bytes, Bytes32 } from "../types.js";

/** One published note as seen on chain. */
export interface PublishedNote {
  /** Tree leaf. */
  commitment: Bytes32;
  /** Leaf index, in insertion order. */
  leafIndex: number;
  /** The opaque encrypted payload. */
  payload: Bytes;
}

/** A note the scanner proved is ours. */
export interface OwnedNote extends NotePayload {
  leafIndex: number;
  /** Set once the note's nullifier is observed on chain. */
  spent: boolean;
}

export interface ChainSource {
  /** Published notes from `fromIndex` onward, in tree order. */
  fetchNotes(fromIndex: number): Promise<PublishedNote[]>;
  /** All nullifiers seen so far — used to mark our notes spent. */
  fetchNullifiers(): Promise<Bytes32[]>;
}

const hex = (b: Bytes) => Buffer.from(b).toString("hex");

/**
 * Scans the pool for notes belonging to one viewing key, and maintains the
 * commitment tree needed to build spend proofs.
 *
 * The tree is rebuilt from every commitment (not just ours) because a
 * membership proof is against the whole tree — that is exactly what hides
 * which leaf we are spending.
 */
export class NoteScanner {
  readonly tree: CommitmentTree;
  private readonly owned = new Map<string, OwnedNote>();
  private nextIndex = 0;

  constructor(
    private readonly viewing: ViewingKeyPair,
    private readonly source: ChainSource,
    tree?: CommitmentTree,
  ) {
    this.tree = tree ?? new CommitmentTree();
  }

  /** Incremental sync. Safe to call repeatedly; resumes where it left off. */
  async sync(): Promise<{ scanned: number; found: number }> {
    const notes = await this.source.fetchNotes(this.nextIndex);
    let found = 0;

    for (const note of notes) {
      // Every commitment enters the tree, ours or not.
      this.tree.insert(note.commitment);
      this.nextIndex = note.leafIndex + 1;

      const payload = this.decrypt(note);
      if (!payload) continue;

      // Trust the tree position we observed, not the one in the payload: the
      // sender could have written anything, and a wrong index yields an
      // invalid membership proof.
      this.owned.set(hex(note.commitment), {
        ...payload,
        leafIndex: note.leafIndex,
        spent: false,
      });
      found++;
    }

    await this.refreshSpent();
    return { scanned: notes.length, found };
  }

  private decrypt(note: PublishedNote): NotePayload | null {
    try {
      return tryDecryptNote(decodeEncryptedNote(note.payload), this.viewing.secretKey);
    } catch {
      // malformed payload from an unrelated sender — not ours
      return null;
    }
  }

  /** Mark our notes spent by matching their nullifiers against the chain.
   *  We can compute our own nullifiers because we hold the spending secrets;
   *  nobody else can make that link. */
  private async refreshSpent(): Promise<void> {
    const onChain = new Set((await this.source.fetchNullifiers()).map(hex));
    for (const note of this.owned.values()) {
      if (note.spent) continue;
      const nullifier = this.nullifierFor(note);
      if (nullifier && onChain.has(hex(nullifier))) note.spent = true;
    }
  }

  /** Overridable so callers can supply the protocol's nullifier derivation
   *  without this module depending on the whole crypto stack. */
  nullifierFor: (note: OwnedNote) => Bytes32 | null = () => null;

  /** Unspent notes, newest last. */
  notes(): OwnedNote[] {
    return [...this.owned.values()].filter((n) => !n.spent);
  }

  balance(): bigint {
    return this.notes().reduce((sum, n) => sum + n.amount, 0n);
  }

  /** Membership proof for one of our notes, ready for the circuit. */
  proofFor(commitment: Bytes32) {
    const note = this.owned.get(hex(commitment));
    if (!note) throw new Error("note is not owned by this viewing key");
    return this.tree.proof(note.leafIndex);
  }

  /** Pick notes covering `amount`, largest first to minimise inputs. */
  select(amount: bigint): OwnedNote[] {
    const available = this.notes().sort((a, b) => (b.amount > a.amount ? 1 : -1));
    const chosen: OwnedNote[] = [];
    let total = 0n;
    for (const note of available) {
      if (total >= amount) break;
      chosen.push(note);
      total += note.amount;
    }
    if (total < amount) {
      throw new Error(`insufficient shielded balance: have ${total}, need ${amount}`);
    }
    return chosen;
  }
}
