// =============================================================================
// @stx-shield/sdk -- the STXShield client
// =============================================================================
// The whole SDK in one class. A developer writes:
//
//   const shield = new STXShield({ network: "testnet", signer });
//   await shield.shield(100);
//   await shield.transfer(50, bobAddress);
//   const [a, b] = await shield.split(note, [25, 25]);
//   const merged = await shield.merge([a, b]);
//   await shield.withdraw(merged);
//
// ...and never sees Noir, UltraHonk, zkVerify, Merkle trees, nullifiers,
// commitments, roots or relayers.

import { CommitmentTree } from "../../merkle-tree/index.js";
import type { SDKConfig, ResolvedConfig } from "../types/config.js";
import type { ShieldNote, Recipient } from "../types/note.js";
import type {
  ShieldResponse, TransferResponse, SplitResponse, MergeResponse, WithdrawResponse, Stats, HistoryEntry,
} from "../types/response.js";
import { NETWORKS, MIN_SHIELD, MIN_WITHDRAWAL } from "../constants/networks.js";
import { ApiProvider } from "../providers/api.js";
import { RelayerProvider } from "../providers/relayer.js";
import { ZkVerifySubmitter } from "../providers/zkverify.js";
import { requireEngine, type OwnerKey, type Inclusion, type MembershipWitness, type ProofSubmitter } from "../proving/index.js";
import { commitmentOf, ownerCommitmentOf, nullifierOf, randomBlinding } from "../crypto/commitments.js";
import { toHex32, fePrincipal, bytesToHex, hexToBytes, bytesToBig } from "../crypto/field.js";
import { encryptNote, encodeEncryptedNote, toHex } from "../crypto/encryption.js";
import {
  NoteStore, discoverNotes, viewingKeyFromSecret, encodeAddress, decodeAddress, type ShieldAddress,
} from "../notes/index.js";
import { createLogger, silentLogger, type Logger } from "../utils/logger.js";
import { ConfigError, InvalidNoteError } from "../errors/index.js";
import type { ViewingKeyPair } from "../crypto/encryption.js";

const STX = 1_000_000n;
const toMicro = (stx: number | bigint): bigint => (typeof stx === "bigint" ? stx : BigInt(Math.round(stx * 1e6)));

export class STXShield {
  private readonly cfg: ResolvedConfig;
  private readonly api: ApiProvider;
  private readonly relayer: RelayerProvider;
  private readonly submitter: ProofSubmitter;
  private readonly log: Logger;
  private readonly tree = new CommitmentTree();
  private readonly store = new NoteStore();

  // Derived lazily from the wallet's shield secret.
  private owner?: OwnerKey;
  private viewing?: ViewingKeyPair;
  private walletAddress?: string;

  constructor(config: SDKConfig) {
    const net = NETWORKS[config.network];
    if (!net) throw new ConfigError(`unknown network: ${config.network}`);
    if (config.network === "mainnet" && !net.deployer && !config.deployer) {
      throw new ConfigError("mainnet is not deployed yet; pass an explicit `deployer`");
    }
    this.log = config.logger ?? (config.network === "mainnet" ? silentLogger : createLogger("warn"));
    this.cfg = {
      network: config.network,
      apiUrl: (config.apiUrl ?? net.apiUrl).replace(/\/$/, ""),
      relayerUrls: config.relayerUrls ?? (config.relayerUrl ? [config.relayerUrl] : net.relayerUrls),
      deployer: config.deployer ?? net.deployer,
      signer: config.signer,
      proofEngine: config.proofEngine,
      logger: this.log,
      timeoutMs: config.timeoutMs ?? 30_000,
      zkVerify: {
        endpointUrl: config.zkVerify?.endpointUrl,
        seed: config.zkVerify?.seed,
        domainId: config.zkVerify?.domainId ?? net.zkVerifyDomainId,
      },
    };
    this.api = new ApiProvider({ baseUrl: this.cfg.apiUrl, timeoutMs: this.cfg.timeoutMs, logger: this.log });
    this.relayer = new RelayerProvider({ urls: this.cfg.relayerUrls, timeoutMs: this.cfg.timeoutMs, logger: this.log });
    this.submitter = new ZkVerifySubmitter({ ...this.cfg.zkVerify, logger: this.log });
  }

  // ---- identity / auth -------------------------------------------------
  private async keys(): Promise<{ owner: OwnerKey; viewing: ViewingKeyPair }> {
    if (this.owner && this.viewing) return { owner: this.owner, viewing: this.viewing };
    if (!this.cfg.signer) throw new ConfigError("a `signer` is required for note operations");
    const engine = requireEngine(this.cfg.proofEngine);
    const secret = await this.cfg.signer.getShieldSecret();
    this.owner = await engine.deriveOwnerKey(secret);
    this.viewing = viewingKeyFromSecret(secret);
    return { owner: this.owner, viewing: this.viewing };
  }

  /** Authenticate with the API using a wallet signature. Idempotent. */
  async connect(): Promise<string> {
    if (this.api.authenticated && this.walletAddress) return this.walletAddress;
    if (!this.cfg.signer) throw new ConfigError("a `signer` is required to connect");
    const wallet = await this.cfg.signer.getAddress(this.cfg.network);
    const { nonce, message } = await this.api.authNonce(wallet);
    void nonce;
    const { signature, publicKey } = await this.cfg.signer.signMessage(message);
    const { token } = await this.api.authVerify(wallet, publicKey, signature, message);
    this.api.setToken(token);
    this.walletAddress = wallet;
    this.log.info("connected", { wallet });
    return wallet;
  }

  async disconnect(): Promise<void> {
    await this.api.logout();
    this.walletAddress = undefined;
  }

  /** The user's shareable STX Shield address (owner + viewing public keys). */
  async getAddress(): Promise<string> {
    const { owner, viewing } = await this.keys();
    const addr: ShieldAddress = { ownerPkX: owner.pkX, ownerPkY: owner.pkY, viewingPk: viewing.publicKey };
    return encodeAddress(addr);
  }

  // ---- reads (no engine needed) ---------------------------------------
  getStats(): Promise<Stats> {
    return this.api.getStats();
  }

  async getHistory(): Promise<HistoryEntry[]> {
    await this.connect();
    return this.api.getMyHistory();
  }

  /** Discover the notes this wallet owns by trial-decrypting the API's feed. */
  async getNotes(): Promise<ShieldNote[]> {
    const { owner, viewing } = await this.keys();
    const records = this.api.authenticated ? await this.api.getMyNotes() : await this.api.getEncryptedNotes(500, 0);
    const found = discoverNotes(records, viewing, owner);
    for (const n of found) this.store.add(n);
    return this.store.unspent();
  }

  // ---- operations ------------------------------------------------------
  private membership(note: ShieldNote): MembershipWitness {
    if (note.secret.leafIndex == null) throw new InvalidNoteError("note has no known tree position");
    const p = this.tree.proof(note.secret.leafIndex);
    return { indexBits: p.indexBits, siblings: p.siblings.map((s) => bytesToBig(s)), merkleRoot: bytesToBig(this.tree.root) };
  }
  private currentRootHex(): string {
    return "0x" + bytesToHex(this.tree.root);
  }
  private newNote(amount: bigint, owner: OwnerKey): { note: ShieldNote; commitment: bigint; ownerCommitment: bigint } {
    const blinding = randomBlinding();
    const commitment = commitmentOf({ amount, ownerPkX: owner.pkX, ownerPkY: owner.pkY, blinding });
    const ownerCommitment = ownerCommitmentOf({ ownerPkX: owner.pkX, ownerPkY: owner.pkY });
    const note: ShieldNote = {
      commitment: toHex32(commitment), ciphertext: "", root: "", txid: "", amount, spent: false,
      secret: { ownerSk: owner.sk, ownerPkX: owner.pkX, ownerPkY: owner.pkY, blinding },
    };
    return { note, commitment, ownerCommitment };
  }
  private async storeCiphertext(note: ShieldNote, leafIndex: number): Promise<string> {
    const { viewing } = await this.keys();
    const enc = encryptNote(
      { version: 1, amount: note.amount, blinding: note.secret.blinding, ownerSk: note.secret.ownerSk, nonce: randomBlinding(), commitment: hexToBytes((note.commitment)), treePosition: leafIndex },
      viewing.publicKey,
    );
    const ciphertext = "0x" + toHex(encodeEncryptedNote(enc));
    if (this.api.authenticated) await this.api.registerNote(note.commitment, ciphertext).catch(() => {});
    return ciphertext;
  }

  /** Shield transparent STX into a private note (user-signed). */
  async shield(amount: number | bigint): Promise<ShieldResponse> {
    const micro = toMicro(amount);
    if (micro < MIN_SHIELD) throw new InvalidNoteError(`minimum shield is ${MIN_SHIELD / STX} STX`);
    if (!this.cfg.signer) throw new ConfigError("a `signer` is required to shield");
    const engine = requireEngine(this.cfg.proofEngine);
    const { owner } = await this.keys();
    await this.connect();

    const { note, commitment, ownerCommitment } = this.newNote(micro, owner);
    const proved = await engine.proveShield({ note: { amount: micro, ownerPkX: owner.pkX, ownerPkY: owner.pkY, blinding: note.secret.blinding }, commitment, ownerCommitment });

    const currentRoot = this.currentRootHex();
    const leafIndex = this.tree.insert(hexToBytes((note.commitment)));
    const newRoot = this.currentRootHex();
    const ciphertext = await this.storeCiphertext(note, leafIndex);

    const txid = await this.submitShield(micro, note.commitment, toHex32(ownerCommitment), currentRoot, newRoot, (await this.submitter.submit(proved)));
    const stored: ShieldNote = { ...note, ciphertext, root: newRoot, txid, secret: { ...note.secret, leafIndex } };
    this.store.add(stored);
    return { txid, status: "confirmed", timestamp: Date.now(), note: stored };
  }

  /** Privately transfer `amount` STX to a recipient's shield address. */
  async transfer(amount: number | bigint, recipient: Recipient): Promise<TransferResponse> {
    const micro = toMicro(amount);
    const input = this.pickNote(micro);
    const to = decodeAddress(recipient);
    const out = this.recipientNote(micro, to);
    const engine = requireEngine(this.cfg.proofEngine);
    const nf = nullifierOf(BigInt(input.commitment), input.secret.ownerSk);
    const proved = await engine.proveTransfer({
      nullifier: nf, newCommitment: BigInt(out.commitment), newOwnerCommitment: out.ownerCommitment,
      input: this.witnessNote(input), ownerSk: input.secret.ownerSk, output: this.witnessNote(out.note), membership: this.membership(input),
    });
    const currentRoot = this.currentRootHex();
    this.tree.insert(hexToBytes((out.commitment)));
    const newRoot = this.currentRootHex();
    const txid = await this.relayer.submit("transfer", {
      nullifier: toHex32(nf), newCommitment: out.commitment, newOwnerCommitment: toHex32(out.ownerCommitment),
      newMetadata: toHex32(0n), currentRoot, newRoot,
    }, (await this.submitter.submit(proved)));
    this.consume(input);
    return { txid, status: "confirmed", timestamp: Date.now() };
  }

  /** Split a note into several smaller notes owned by you. */
  async split(note: ShieldNote, amounts: (number | bigint)[]): Promise<SplitResponse> {
    if (amounts.length !== 2) throw new InvalidNoteError("split produces exactly two notes; chain splits for more");
    const { owner } = await this.keys();
    const a1 = toMicro(amounts[0]!), a2 = toMicro(amounts[1]!);
    if (a1 + a2 !== note.amount) throw new InvalidNoteError("split amounts must sum to the note amount");
    const engine = requireEngine(this.cfg.proofEngine);
    const o1 = this.newNote(a1, owner), o2 = this.newNote(a2, owner);
    const nf = nullifierOf(BigInt(note.commitment), note.secret.ownerSk);
    const proved = await engine.proveSplit({
      nullifier: nf, commitment1: o1.commitment, ownerCommitment1: o1.ownerCommitment, commitment2: o2.commitment, ownerCommitment2: o2.ownerCommitment,
      input: this.witnessNote(note), ownerSk: note.secret.ownerSk, out1: this.witnessNote(o1.note), out2: this.witnessNote(o2.note), membership: this.membership(note),
    });
    const currentRoot = this.currentRootHex();
    const l1 = this.tree.insert(hexToBytes((o1.note.commitment)));
    const l2 = this.tree.insert(hexToBytes((o2.note.commitment)));
    const newRoot = this.currentRootHex();
    const txid = await this.relayer.submit("split", {
      nullifier: toHex32(nf), commitment1: o1.note.commitment, ownerCommitment1: toHex32(o1.ownerCommitment), metadata1: toHex32(0n),
      commitment2: o2.note.commitment, ownerCommitment2: toHex32(o2.ownerCommitment), metadata2: toHex32(0n), currentRoot, newRoot,
    }, (await this.submitter.submit(proved)));
    this.consume(note);
    const n1: ShieldNote = { ...o1.note, root: newRoot, txid, secret: { ...o1.note.secret, leafIndex: l1 } };
    const n2: ShieldNote = { ...o2.note, root: newRoot, txid, secret: { ...o2.note.secret, leafIndex: l2 } };
    this.store.add(n1); this.store.add(n2);
    return { txid, status: "confirmed", timestamp: Date.now(), notes: [n1, n2] };
  }

  /** Merge two notes into one. */
  async merge(notes: ShieldNote[]): Promise<MergeResponse> {
    if (notes.length !== 2) throw new InvalidNoteError("merge takes exactly two notes");
    const [i1, i2] = notes as [ShieldNote, ShieldNote];
    const { owner } = await this.keys();
    const out = this.newNote(i1.amount + i2.amount, owner);
    const engine = requireEngine(this.cfg.proofEngine);
    const nf1 = nullifierOf(BigInt(i1.commitment), i1.secret.ownerSk), nf2 = nullifierOf(BigInt(i2.commitment), i2.secret.ownerSk);
    const proved = await engine.proveMerge({
      nullifier1: nf1, nullifier2: nf2, commitment: out.commitment, ownerCommitment: out.ownerCommitment,
      input1: this.witnessNote(i1), ownerSk1: i1.secret.ownerSk, membership1: this.membership(i1),
      input2: this.witnessNote(i2), ownerSk2: i2.secret.ownerSk, membership2: this.membership(i2), output: this.witnessNote(out.note),
    });
    const currentRoot = this.currentRootHex();
    const leaf = this.tree.insert(hexToBytes((out.note.commitment)));
    const newRoot = this.currentRootHex();
    const txid = await this.relayer.submit("merge", {
      nullifier1: toHex32(nf1), nullifier2: toHex32(nf2), commitment: out.note.commitment, ownerCommitment: toHex32(out.ownerCommitment), metadata: toHex32(0n), currentRoot, newRoot,
    }, (await this.submitter.submit(proved)));
    this.consume(i1); this.consume(i2);
    const merged: ShieldNote = { ...out.note, root: newRoot, txid, secret: { ...out.note.secret, leafIndex: leaf } };
    this.store.add(merged);
    return { txid, status: "confirmed", timestamp: Date.now(), note: merged };
  }

  /** Withdraw a note back to transparent STX at `recipient` (a Stacks address). */
  async withdraw(note: ShieldNote, recipient?: string): Promise<WithdrawResponse> {
    if (note.amount < MIN_WITHDRAWAL) throw new InvalidNoteError(`minimum withdrawal is ${MIN_WITHDRAWAL / STX} STX`);
    const to = recipient ?? (this.cfg.signer ? await this.cfg.signer.getAddress(this.cfg.network) : undefined);
    if (!to) throw new ConfigError("a recipient address (or signer) is required to withdraw");
    const engine = requireEngine(this.cfg.proofEngine);
    const nf = nullifierOf(BigInt(note.commitment), note.secret.ownerSk);
    const root = this.currentRootHex();
    const proved = await engine.proveWithdraw({
      nullifier: nf, amount: note.amount, recipientHash: bytesToBig(fePrincipal(to)),
      input: this.witnessNote(note), ownerSk: note.secret.ownerSk, membership: this.membership(note),
    });
    const txid = await this.relayer.submit("withdraw", { nullifier: toHex32(nf), amount: note.amount.toString(), recipient: to, root }, (await this.submitter.submit(proved)));
    this.consume(note);
    // ~0.3% protocol withdraw fee.
    const amountReceived = note.amount - (note.amount * 30n) / 10_000n;
    return { txid, status: "confirmed", timestamp: Date.now(), recipient: to, amountReceived };
  }

  // ---- helpers ---------------------------------------------------------
  private pickNote(micro: bigint): ShieldNote {
    const exact = this.store.unspent().find((n) => n.amount === micro);
    if (!exact) throw new InvalidNoteError(`no unspent note of exactly ${micro} micro-STX; split first`);
    return exact;
  }
  private recipientNote(amount: bigint, to: ShieldAddress): { note: ShieldNote; commitment: string; ownerCommitment: bigint } {
    const blinding = randomBlinding();
    const commitment = commitmentOf({ amount, ownerPkX: to.ownerPkX, ownerPkY: to.ownerPkY, blinding });
    const ownerCommitment = ownerCommitmentOf({ ownerPkX: to.ownerPkX, ownerPkY: to.ownerPkY });
    const note: ShieldNote = { commitment: toHex32(commitment), ciphertext: "", root: "", txid: "", amount, spent: false, secret: { ownerSk: 0n, ownerPkX: to.ownerPkX, ownerPkY: to.ownerPkY, blinding } };
    return { note, commitment: toHex32(commitment), ownerCommitment };
  }
  private witnessNote(n: ShieldNote | { note: ShieldNote }): { amount: bigint; ownerPkX: bigint; ownerPkY: bigint; blinding: bigint } {
    const note = "note" in n ? n.note : n;
    return { amount: note.amount, ownerPkX: note.secret.ownerPkX, ownerPkY: note.secret.ownerPkY, blinding: note.secret.blinding };
  }
  private consume(note: ShieldNote): void {
    this.store.markSpent(note.commitment);
    if (this.api.authenticated) void this.api.markSpent(note.commitment);
  }

  private async submitShield(amount: bigint, commitment: string, ownerCommitment: string, currentRoot: string, newRoot: string, inc: Inclusion): Promise<string> {
    if (!this.cfg.signer) throw new ConfigError("a signer is required to shield");
    // The relayer network publishes the aggregation root; wait until it is on
    // chain before the (user-signed) shield references it.
    await this.waitForRoot(inc);
    return this.cfg.signer.signAndBroadcast({
      contractAddress: this.cfg.deployer, contractName: "privacy-pool", functionName: "shield",
      functionArgs: [amount, commitment, ownerCommitment, toHex32(0n), currentRoot, newRoot, inc.domainId, inc.aggregationId, inc.merklePath, inc.leafIndex],
    }, this.cfg.network);
  }
  private async waitForRoot(inc: Inclusion, tries = 30): Promise<void> {
    for (let i = 0; i < tries; i++) {
      if (await this.api.getAggregation(inc.domainId, inc.aggregationId)) return;
      await new Promise((r) => setTimeout(r, 8000));
    }
    this.log.warn("aggregation root not observed as published; submitting anyway", {});
  }
}
