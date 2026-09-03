// =============================================================================
// @stacks-shield/sdk -- the STXShield client
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

import { Cl, hexToCV, cvToJSON, cvToHex } from "@stacks/transactions";
import { CommitmentTree } from "../../merkle-tree/index.js";
import type { SDKConfig, ResolvedConfig } from "../types/config.js";
import type { ShieldNote, Recipient } from "../types/note.js";
import { resolveAsset, type AssetInfo, type AssetRef } from "../types/asset.js";
import type {
  ShieldResponse, TransferResponse, SplitResponse, MergeResponse, WithdrawResponse, Stats, HistoryEntry, OperationStatus,
} from "../types/response.js";
import { NETWORKS, MIN_SHIELD, MIN_WITHDRAWAL } from "../constants/networks.js";
import { ApiProvider, type EncryptedNoteRecord } from "../providers/api.js";
import { RelayerProvider } from "../providers/relayer.js";
import { ZkVerifySubmitter } from "../providers/zkverify.js";
import { requireEngine, type OwnerKey, type Inclusion, type MembershipWitness, type InsertionWitness, type ProofSubmitter } from "../proving/index.js";
import { commitmentOf, ownerCommitmentOf, nullifierOf, randomBlinding, assetFieldOf } from "../crypto/commitments.js";
import { toHex32, fePrincipal, bytesToHex, hexToBytes, bytesToBig } from "../crypto/field.js";
import { encryptNote, encodeEncryptedNote, toHex } from "../crypto/encryption.js";
import {
  NoteStore, discoverNotes, viewingKeyFromSecret, encodeAddress, decodeAddress, type ShieldAddress,
} from "../notes/index.js";
import { createLogger, silentLogger, type Logger } from "../utils/logger.js";
import { ConfigError, InvalidNoteError, RootNotFoundError, STXShieldError } from "../errors/index.js";
import type { ViewingKeyPair } from "../crypto/encryption.js";

const STX = 1_000_000n;
/** Convert a human amount to an asset's base units (bigint amounts pass through
 *  as already-base-units). STX decimals=6 reproduces toMicro. */
const toBaseUnits = (amount: number | bigint, decimals: number): bigint =>
  typeof amount === "bigint" ? amount : BigInt(Math.round(amount * 10 ** decimals));
/** The circuit asset_id field for an asset, or undefined for native STX. */
const assetFieldFor = (asset: AssetInfo): bigint | undefined =>
  asset.native ? undefined : assetFieldOf(asset.token as string);
const sameAsset = (a: AssetInfo | undefined, b: AssetInfo): boolean =>
  (a?.id ?? 0) === b.id;

export class STXShield {
  private readonly cfg: ResolvedConfig;
  private readonly api: ApiProvider;
  private readonly relayer: RelayerProvider;
  private readonly submitter: ProofSubmitter;
  private readonly log: Logger;
  // Commitment tree rebuilt from the chain (via the API) before every op, so
  // membership proofs and new-roots match the live on-chain root.
  private tree = new CommitmentTree();
  private commitmentIndex = new Map<string, number>();
  private readonly store = new NoteStore();

  // Derived lazily from the wallet's shield secret.
  private owner?: OwnerKey;
  private viewing?: ViewingKeyPair;
  private walletAddress?: string;
  // In-flight guards so concurrent callers share ONE wallet signature prompt.
  private connecting?: Promise<string>;
  private keysP?: Promise<{ owner: OwnerKey; viewing: ViewingKeyPair }>;

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
      noteVault: config.noteVault,
    };
    this.api = new ApiProvider({ baseUrl: this.cfg.apiUrl, timeoutMs: this.cfg.timeoutMs, logger: this.log });
    this.relayer = new RelayerProvider({ urls: this.cfg.relayerUrls, timeoutMs: this.cfg.timeoutMs, logger: this.log });
    this.submitter = new ZkVerifySubmitter({ ...this.cfg.zkVerify, logger: this.log });
  }

  // ---- identity / auth -------------------------------------------------
  private async keys(): Promise<{ owner: OwnerKey; viewing: ViewingKeyPair }> {
    if (this.owner && this.viewing) return { owner: this.owner, viewing: this.viewing };
    if (this.keysP) return this.keysP;
    if (!this.cfg.signer) throw new ConfigError("a `signer` is required for note operations");
    const engine = requireEngine(this.cfg.proofEngine);
    const signer = this.cfg.signer;
    // Coalesce concurrent callers so getShieldSecret() prompts to sign only once.
    this.keysP = (async () => {
      const secret = await signer.getShieldSecret();
      this.owner = await engine.deriveOwnerKey(secret);
      this.viewing = viewingKeyFromSecret(secret);
      return { owner: this.owner, viewing: this.viewing };
    })().finally(() => { this.keysP = undefined; });
    return this.keysP;
  }

  /** Authenticate with the API using a wallet signature. Idempotent, and safe
   *  under concurrency: parallel callers share ONE in-flight auth so the wallet
   *  prompts to sign only once (not once per query firing on page load). */
  async connect(): Promise<string> {
    if (this.api.authenticated && this.walletAddress) return this.walletAddress;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async doConnect(): Promise<string> {
    if (!this.cfg.signer) throw new ConfigError("a `signer` is required to connect");
    const wallet = await this.cfg.signer.getAddress(this.cfg.network);
    const { message } = await this.api.authNonce(wallet);
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

  // ---- asset discovery (no engine/auth needed) ------------------------
  /** The native STX asset, synthesized from the configured deployer. Always
   *  available even if the API predates /assets. */
  private nativeAsset(): AssetInfo {
    const d = this.cfg.deployer;
    const c = (name: string) => (d ? `${d}.${name}` : name);
    return {
      id: 0, symbol: "STX", token: null, decimals: 6, active: true, native: true,
      pool: c("privacy-pool"), verifier: c("zk-verifier"), splitMerge: c("split-merge-manager"), protocolFees: c("protocol-fees"),
    };
  }

  /** Discover every supported asset: native STX + registered SIP-10 tokens.
   *  Native STX is guaranteed present (synthesized if the API omits it), so STX
   *  flows never depend on asset discovery succeeding. */
  async getAssets(): Promise<AssetInfo[]> {
    const assets = await this.api.getAssets();
    return assets.some((a) => a.native) ? assets : [this.nativeAsset(), ...assets];
  }

  /** Resolve an asset reference (symbol, token principal, AssetInfo, or STX/
   *  undefined for native) against the discovered list. */
  async getAsset(ref?: AssetRef): Promise<AssetInfo> {
    return resolveAsset(ref, await this.getAssets());
  }

  // ---- reads (no engine needed) ---------------------------------------
  getStats(): Promise<Stats> {
    return this.api.getStats();
  }

  async getHistory(): Promise<HistoryEntry[]> {
    await this.connect();
    return this.api.getMyHistory();
  }

  /** Discover the notes this wallet owns by trial-decrypting the API's feed.
   *  Scans the FULL encrypted feed (not just notes registered under our wallet)
   *  so incoming transfers — encrypted to us by a sender — are discovered too.
   *  Multi-asset: each note is tagged with its asset (resolved from the payload);
   *  pass `assetRef` to return only that asset's notes. */
  async getNotes(assetRef?: AssetRef): Promise<ShieldNote[]> {
    const { owner, viewing } = await this.keys();
    const [records, assets, vaultRecords] = await Promise.all([
      this.api.getEncryptedNotes(1000, 0).catch(() => [] as EncryptedNoteRecord[]),
      this.getAssets(),
      this.loadVaultRecords(),
    ]);
    // Discover from the API feed AND the local vault, so a note survives a refresh
    // or a failed API registration. discoverNotes verifies each against its
    // on-chain commitment; the store dedups by commitment.
    const found = discoverNotes([...records, ...vaultRecords], viewing, owner, assets);
    for (const n of found) this.store.add(n);
    // Newest first: higher leaf index == appended later. Not-yet-indexed
    // (pending) notes have no leaf index, so they sort to the very top.
    const newest = (n: ShieldNote) => n.secret.leafIndex ?? Number.MAX_SAFE_INTEGER;
    let notes = this.store.unspent().sort((a, b) => newest(b) - newest(a));
    if (assetRef !== undefined) {
      const asset = resolveAsset(assetRef, assets.some((a) => a.native) ? assets : [this.nativeAsset(), ...assets]);
      notes = notes.filter((n) => sameAsset(n.asset, asset));
    }
    return notes;
  }

  // ---- operations ------------------------------------------------------
  /** Rebuild the commitment tree from the chain (all commitments, leaf order).
   *  Must run before any op so membership proofs and roots match the live root. */
  private async syncTree(): Promise<void> {
    const commits = await this.api.getCommitments();
    const tree = new CommitmentTree();
    const index = new Map<string, number>();
    for (const c of commits) {
      const norm = (c.commitment.startsWith("0x") ? c.commitment : "0x" + c.commitment).toLowerCase();
      const idx = tree.insert(hexToBytes(norm));
      index.set(norm, idx);
    }
    this.tree = tree;
    this.commitmentIndex = index;
  }

  private membership(note: ShieldNote): MembershipWitness {
    // The note's real leaf position comes from the on-chain tree, not the
    // locally-remembered index (which need not match the chain).
    const leafIndex = this.commitmentIndex.get(note.commitment.toLowerCase());
    if (leafIndex == null) {
      throw new InvalidNoteError("note commitment is not on chain yet (wait for confirmation)");
    }
    const p = this.tree.proof(leafIndex);
    return { indexBits: p.indexBits, siblings: p.siblings.map((s) => bytesToBig(s)), merkleRoot: bytesToBig(this.tree.root) };
  }
  private currentRootHex(): string {
    return "0x" + bytesToHex(this.tree.root);
  }
  /** Witness proving the append of `commitmentHex` at the next free slot: the
   *  slot is empty under the current root and inserting the commitment yields a
   *  known new-root. The SIP-10 circuits bind this so a forged new-root cannot
   *  verify. Non-mutating — call `tree.insert` afterwards to advance the tree. */
  private insertionFor(commitmentHex: string): InsertionWitness {
    const w = this.tree.insertionWitness(hexToBytes(commitmentHex));
    return {
      leafIndex: w.index,
      indexBits: w.indexBits,
      siblings: w.siblings.map((s) => bytesToBig(s)),
      oldRoot: bytesToBig(w.oldRoot),
      newRoot: bytesToBig(w.newRoot),
    };
  }
  /** Read the LIVE commitment-tree root from privacy-registry (Hiro read-only).
   *  Shield must declare this exact value as current-root or the tx reverts
   *  with ERR-STALE-ROOT (u252). */
  private async fetchCurrentRoot(): Promise<string> {
    const hiro = NETWORKS[this.cfg.network].hiroApiUrl;
    const res = await fetch(
      `${hiro}/v2/contracts/call-read/${this.cfg.deployer}/privacy-registry/get-current-root`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: this.cfg.deployer, arguments: [] }),
      },
    );
    const j = (await res.json()) as { okay?: boolean; result?: string };
    if (!j.result) throw new RootNotFoundError("could not read the live current root");
    const cv = cvToJSON(hexToCV(j.result)) as { value?: { root?: { value?: string } } };
    const root = cv.value?.root?.value;
    if (!root) throw new RootNotFoundError("unexpected get-current-root response shape");
    return root;
  }
  private newNote(amount: bigint, owner: OwnerKey, asset: AssetInfo): { note: ShieldNote; commitment: bigint; ownerCommitment: bigint; assetField?: bigint } {
    const blinding = randomBlinding();
    const assetField = assetFieldFor(asset);
    const commitment = commitmentOf({ amount, ownerPkX: owner.pkX, ownerPkY: owner.pkY, blinding, assetField });
    const ownerCommitment = ownerCommitmentOf({ ownerPkX: owner.pkX, ownerPkY: owner.pkY });
    const note: ShieldNote = {
      commitment: toHex32(commitment), ciphertext: "", root: "", txid: "", amount, asset, spent: false,
      secret: { ownerSk: owner.sk, ownerPkX: owner.pkX, ownerPkY: owner.pkY, blinding, assetId: asset.native ? undefined : asset.id, assetField },
    };
    return { note, commitment, ownerCommitment, assetField };
  }
  private async storeCiphertext(
    note: ShieldNote,
    leafIndex: number,
    viewingPubKey?: Uint8Array,
  ): Promise<string> {
    // Default: encrypt to self. For a transfer, encrypt to the RECIPIENT's
    // viewing key so only they can discover and read the note.
    const vpk = viewingPubKey ?? (await this.keys()).viewing.publicKey;
    const enc = encryptNote(
      // Carry the asset uid so the recipient rebuilds the asset-bound commitment.
      { version: 1, amount: note.amount, blinding: note.secret.blinding, ownerSk: note.secret.ownerSk, nonce: randomBlinding(), commitment: hexToBytes((note.commitment)), treePosition: leafIndex, assetId: note.secret.assetId },
      vpk,
    );
    const ciphertext = "0x" + toHex(encodeEncryptedNote(enc));
    // Register on the API for cross-device discovery. Do NOT swallow a failure —
    // a lost registration used to leave a note undiscoverable (its blinding lives
    // only in this ciphertext). We surface it; the local vault (below) keeps the
    // note durable regardless, so the funds are never lost.
    if (this.api.authenticated) {
      try {
        await this.api.registerNote(note.commitment, ciphertext);
      } catch (e) {
        this.log.warn("failed to register encrypted note on the API — kept locally (add a noteVault for durability)", { commitment: note.commitment, e });
      }
    }
    return ciphertext;
  }

  /** Persist a self-owned note to the local vault (durable across refresh + API
   *  write failures). No-op if no vault was configured. */
  private persist(note: ShieldNote): void {
    if (!this.cfg.noteVault) return;
    try {
      void Promise.resolve(
        this.cfg.noteVault.put({
          commitment: note.commitment, ciphertext: note.ciphertext, root: note.root, txid: note.txid,
          leafIndex: note.secret.leafIndex, assetId: note.secret.assetId, spent: note.spent,
        }),
      );
    } catch (e) {
      this.log.warn("failed to persist note to the local vault", { commitment: note.commitment, e });
    }
  }
  /** Locally-persisted notes as discovery records (survive refresh / API loss). */
  private async loadVaultRecords(): Promise<EncryptedNoteRecord[]> {
    if (!this.cfg.noteVault) return [];
    try {
      const all = await Promise.resolve(this.cfg.noteVault.all());
      return all.map((v) => ({ commitment: v.commitment, ciphertext: v.ciphertext, root: v.root, txid: v.txid, spent: v.spent }));
    } catch {
      return [];
    }
  }

  /** Shield transparent tokens into a private note (user-signed). Defaults to
   *  native STX; pass an asset (symbol / token principal / AssetInfo) to shield
   *  a SIP-10 token instead. `amount` is a human amount (scaled by the asset's
   *  decimals) or a bigint of base units. */
  async shield(amount: number | bigint, assetRef?: AssetRef): Promise<ShieldResponse> {
    const asset = await this.getAsset(assetRef);
    const base = toBaseUnits(amount, asset.decimals);
    if (asset.native && base < MIN_SHIELD) throw new InvalidNoteError(`minimum shield is ${MIN_SHIELD / STX} STX`);
    if (!asset.active) throw new InvalidNoteError(`asset ${asset.symbol} is not shieldable`);
    if (!this.cfg.signer) throw new ConfigError("a `signer` is required to shield");
    const engine = requireEngine(this.cfg.proofEngine);
    const { owner } = await this.keys();
    await this.connect();
    await this.syncTree();

    const { note, commitment, ownerCommitment, assetField } = this.newNote(base, owner, asset);

    // current-root must equal the LIVE on-chain root (ERR-STALE-ROOT/u252). Append
    // the commitment to the chain-synced tree and publish the resulting REAL root
    // as new-root, so later spends can prove membership against a known root. The
    // insertion witness (computed before the append) binds that transition into
    // the proof so the published new-root cannot be forged.
    const currentRoot = await this.fetchCurrentRoot();
    const insertion = this.insertionFor(note.commitment);
    const proved = await engine.proveShield({ note: { amount: base, ownerPkX: owner.pkX, ownerPkY: owner.pkY, blinding: note.secret.blinding }, commitment, ownerCommitment, assetField, insertion });
    const leafIndex = this.tree.insert(hexToBytes((note.commitment)));
    const newRoot = this.currentRootHex();
    const ciphertext = await this.storeCiphertext(note, leafIndex);

    const txid = await this.submitShield(asset, base, note.commitment, toHex32(ownerCommitment), currentRoot, newRoot, insertion.leafIndex, (await this.submitter.submit(proved)));
    // Optimistic note: pending until the indexer observes it on chain. The API
    // flips it to confirmed once the commitment lands, and getNotes self-heals.
    const stored: ShieldNote = { ...note, ciphertext, root: newRoot, txid, status: "pending", secret: { ...note.secret, leafIndex } };
    this.store.add(stored);
    this.persist(stored);

    // Verify the deposit actually landed. A shield moves the caller's own tokens,
    // so it can revert on chain (e.g. the SIP-10 transfer fails, u459) — we must
    // NOT report success for a reverted deposit. On revert, roll the optimistic
    // note back so a phantom deposit can never masquerade as spendable funds.
    let status: OperationStatus;
    try {
      status = await this.waitForTx(txid);
    } catch (e) {
      this.store.remove(stored.commitment);
      if (this.cfg.noteVault) {
        try { await Promise.resolve(this.cfg.noteVault.remove(stored.commitment)); } catch { /* best-effort */ }
      }
      throw e;
    }
    if (status === "confirmed") { stored.status = "confirmed"; this.persist(stored); }
    return { txid, status, timestamp: Date.now(), note: stored };
  }

  /** Privately transfer `amount` of an asset to a recipient's shield address.
   *  Defaults to native STX; pass an asset for a SIP-10 transfer. The RELAYER
   *  submits it, so the chain never sees the sender. */
  async transfer(amount: number | bigint, recipient: Recipient, assetRef?: AssetRef): Promise<TransferResponse> {
    const asset = await this.getAsset(assetRef);
    const base = toBaseUnits(amount, asset.decimals);
    const input = this.pickNote(base, asset);
    const to = decodeAddress(recipient);
    const out = this.recipientNote(base, to, asset);
    const engine = requireEngine(this.cfg.proofEngine);
    await this.syncTree();
    const nf = nullifierOf(BigInt(input.commitment), input.secret.ownerSk);
    const insertion = this.insertionFor(out.commitment);
    const proved = await engine.proveTransfer({
      nullifier: nf, newCommitment: BigInt(out.commitment), newOwnerCommitment: out.ownerCommitment,
      input: this.witnessNote(input), ownerSk: input.secret.ownerSk, output: this.witnessNote(out.note), membership: this.membership(input),
      insertion, assetField: assetFieldFor(asset),
    });
    const currentRoot = this.currentRootHex();
    const outLeaf = this.tree.insert(hexToBytes((out.commitment)));
    const newRoot = this.currentRootHex();
    const txid = await this.relayer.submit("transfer", {
      nullifier: toHex32(nf), newCommitment: out.commitment, newOwnerCommitment: toHex32(out.ownerCommitment),
      newMetadata: toHex32(0n), currentRoot, newRoot, ...this.leafIndexParam(asset, insertion.leafIndex), ...this.tokenParam(asset),
    }, (await this.submitter.submit(proved)));
    await this.consume(input);
    // Publish the output encrypted to the RECIPIENT's viewing key so they (and
    // only they) can discover and spend the received note.
    await this.storeCiphertext(out.note, outLeaf, to.viewingPk);
    return { txid, status: "confirmed", timestamp: Date.now() };
  }

  /** Split a note into two smaller notes owned by you. Same asset throughout. */
  async split(note: ShieldNote, amounts: (number | bigint)[]): Promise<SplitResponse> {
    if (amounts.length !== 2) throw new InvalidNoteError("split produces exactly two notes; split the results again for more");
    const { owner } = await this.keys();
    const asset = await this.assetOfNote(note);
    const a1 = toBaseUnits(amounts[0]!, asset.decimals), a2 = toBaseUnits(amounts[1]!, asset.decimals);
    if (a1 + a2 !== note.amount) throw new InvalidNoteError("split amounts must sum to the note amount");
    const engine = requireEngine(this.cfg.proofEngine);
    await this.syncTree();
    const o1 = this.newNote(a1, owner, asset), o2 = this.newNote(a2, owner, asset);
    const nf = nullifierOf(BigInt(note.commitment), note.secret.ownerSk);
    // Membership + both append witnesses are captured BEFORE mutating the tree:
    // insertion1 appends output 1 at leaf_index over the current root, then
    // insertion2 appends output 2 at leaf_index+1 over the intermediate root.
    const membership = this.membership(note);
    const currentRoot = this.currentRootHex();
    const insertion1 = this.insertionFor(o1.note.commitment);
    const l1 = this.tree.insert(hexToBytes((o1.note.commitment)));
    const insertion2 = this.insertionFor(o2.note.commitment);
    const l2 = this.tree.insert(hexToBytes((o2.note.commitment)));
    const newRoot = this.currentRootHex();
    const proved = await engine.proveSplit({
      nullifier: nf, commitment1: o1.commitment, ownerCommitment1: o1.ownerCommitment, commitment2: o2.commitment, ownerCommitment2: o2.ownerCommitment,
      input: this.witnessNote(note), ownerSk: note.secret.ownerSk, out1: this.witnessNote(o1.note), out2: this.witnessNote(o2.note), membership,
      insertion1, insertion2, assetField: assetFieldFor(asset),
    });
    const txid = await this.relayer.submit("split", {
      nullifier: toHex32(nf), commitment1: o1.note.commitment, ownerCommitment1: toHex32(o1.ownerCommitment), metadata1: toHex32(0n),
      commitment2: o2.note.commitment, ownerCommitment2: toHex32(o2.ownerCommitment), metadata2: toHex32(0n), currentRoot, newRoot, ...this.leafIndexParam(asset, insertion1.leafIndex), ...this.tokenParam(asset),
    }, (await this.submitter.submit(proved)));
    await this.consume(note);
    // Register the new notes so they persist + are discoverable after reload.
    const ct1 = await this.storeCiphertext(o1.note, l1);
    const ct2 = await this.storeCiphertext(o2.note, l2);
    const n1: ShieldNote = { ...o1.note, ciphertext: ct1, root: newRoot, txid, status: "pending", secret: { ...o1.note.secret, leafIndex: l1 } };
    const n2: ShieldNote = { ...o2.note, ciphertext: ct2, root: newRoot, txid, status: "pending", secret: { ...o2.note.secret, leafIndex: l2 } };
    this.store.add(n1); this.store.add(n2);
    this.persist(n1); this.persist(n2);
    return { txid, status: "confirmed", timestamp: Date.now(), notes: [n1, n2] };
  }

  /** Merge two notes into one. Both notes must be the same asset. */
  async merge(notes: ShieldNote[]): Promise<MergeResponse> {
    if (notes.length !== 2) throw new InvalidNoteError("merge takes exactly two notes");
    const [i1, i2] = notes as [ShieldNote, ShieldNote];
    const { owner } = await this.keys();
    const asset = await this.assetOfNote(i1);
    if (!sameAsset(i2.asset, asset)) throw new InvalidNoteError("cannot merge notes of different assets");
    const out = this.newNote(i1.amount + i2.amount, owner, asset);
    const engine = requireEngine(this.cfg.proofEngine);
    await this.syncTree();
    const nf1 = nullifierOf(BigInt(i1.commitment), i1.secret.ownerSk), nf2 = nullifierOf(BigInt(i2.commitment), i2.secret.ownerSk);
    const insertion = this.insertionFor(out.note.commitment);
    const proved = await engine.proveMerge({
      nullifier1: nf1, nullifier2: nf2, commitment: out.commitment, ownerCommitment: out.ownerCommitment,
      input1: this.witnessNote(i1), ownerSk1: i1.secret.ownerSk, membership1: this.membership(i1),
      input2: this.witnessNote(i2), ownerSk2: i2.secret.ownerSk, membership2: this.membership(i2), output: this.witnessNote(out.note),
      insertion, assetField: assetFieldFor(asset),
    });
    const currentRoot = this.currentRootHex();
    const leaf = this.tree.insert(hexToBytes((out.note.commitment)));
    const newRoot = this.currentRootHex();
    const txid = await this.relayer.submit("merge", {
      nullifier1: toHex32(nf1), nullifier2: toHex32(nf2), commitment: out.note.commitment, ownerCommitment: toHex32(out.ownerCommitment), metadata: toHex32(0n), currentRoot, newRoot, ...this.leafIndexParam(asset, insertion.leafIndex), ...this.tokenParam(asset),
    }, (await this.submitter.submit(proved)));
    await this.consume(i1);
    await this.consume(i2);
    const ct = await this.storeCiphertext(out.note, leaf);
    const merged: ShieldNote = { ...out.note, ciphertext: ct, root: newRoot, txid, status: "pending", secret: { ...out.note.secret, leafIndex: leaf } };
    this.store.add(merged);
    this.persist(merged);
    return { txid, status: "confirmed", timestamp: Date.now(), note: merged };
  }

  /** Withdraw a note back to transparent tokens at `recipient` (a Stacks
   *  address). Works for native STX and any SIP-10 asset — including a DISABLED
   *  asset (the pool always lets you withdraw a known asset). Relayer-submitted. */
  async withdraw(note: ShieldNote, recipient?: string): Promise<WithdrawResponse> {
    const asset = await this.assetOfNote(note);
    if (asset.native && note.amount < MIN_WITHDRAWAL) throw new InvalidNoteError(`minimum withdrawal is ${MIN_WITHDRAWAL / STX} STX`);
    const to = recipient ?? (this.cfg.signer ? await this.cfg.signer.getAddress(this.cfg.network) : undefined);
    if (!to) throw new ConfigError("a recipient address (or signer) is required to withdraw");
    const engine = requireEngine(this.cfg.proofEngine);
    await this.syncTree();
    const nf = nullifierOf(BigInt(note.commitment), note.secret.ownerSk);
    const root = this.currentRootHex();
    const proved = await engine.proveWithdraw({
      nullifier: nf, amount: note.amount, recipientHash: bytesToBig(fePrincipal(to)),
      input: this.witnessNote(note), ownerSk: note.secret.ownerSk, membership: this.membership(note),
      assetField: assetFieldFor(asset),
    });
    const txid = await this.relayer.submit("withdraw", { nullifier: toHex32(nf), amount: note.amount.toString(), recipient: to, root, ...this.tokenParam(asset) }, (await this.submitter.submit(proved)));
    await this.consume(note);
    // ~0.3% native STX protocol withdraw fee; SIP-10 fees are per-asset (0 until
    // configured), so report the amount net of the applicable fee.
    const feeBps = asset.native ? 30n : 0n;
    const amountReceived = note.amount - (note.amount * feeBps) / 10_000n;
    return { txid, status: "confirmed", timestamp: Date.now(), recipient: to, amountReceived };
  }

  // ---- helpers ---------------------------------------------------------
  /** The asset a note holds (its `asset`, or native STX for legacy/STX notes). */
  private async assetOfNote(note: ShieldNote): Promise<AssetInfo> {
    if (note.asset) return note.asset;
    return this.nativeAsset();
  }
  /** Relayer request params selecting the SIP-10 asset (empty for native STX). */
  private tokenParam(asset: AssetInfo): Record<string, string> {
    return asset.native ? {} : { token: asset.token as string };
  }
  /** The proof-bound leaf index the pool asserts against the registry slot.
   *  Both native STX and SIP-10 pools are v2 and take it. */
  private leafIndexParam(_asset: AssetInfo, leafIndex: number): Record<string, number> {
    return { leafIndex };
  }
  private pickNote(base: bigint, asset: AssetInfo): ShieldNote {
    const exact = this.store.unspent().find((n) => n.amount === base && sameAsset(n.asset, asset));
    if (!exact) throw new InvalidNoteError(`no unspent ${asset.symbol} note of exactly ${base} base units; split first`);
    return exact;
  }
  private recipientNote(amount: bigint, to: ShieldAddress, asset: AssetInfo): { note: ShieldNote; commitment: string; ownerCommitment: bigint } {
    const blinding = randomBlinding();
    const assetField = assetFieldFor(asset);
    const commitment = commitmentOf({ amount, ownerPkX: to.ownerPkX, ownerPkY: to.ownerPkY, blinding, assetField });
    const ownerCommitment = ownerCommitmentOf({ ownerPkX: to.ownerPkX, ownerPkY: to.ownerPkY });
    const note: ShieldNote = { commitment: toHex32(commitment), ciphertext: "", root: "", txid: "", amount, asset, spent: false, secret: { ownerSk: 0n, ownerPkX: to.ownerPkX, ownerPkY: to.ownerPkY, blinding, assetId: asset.native ? undefined : asset.id, assetField } };
    return { note, commitment: toHex32(commitment), ownerCommitment };
  }
  private witnessNote(n: ShieldNote | { note: ShieldNote }): { amount: bigint; ownerPkX: bigint; ownerPkY: bigint; blinding: bigint } {
    const note = "note" in n ? n.note : n;
    return { amount: note.amount, ownerPkX: note.secret.ownerPkX, ownerPkY: note.secret.ownerPkY, blinding: note.secret.blinding };
  }
  /** Mark a note spent locally AND on the API, awaited so the spend persists
   *  before the operation returns (otherwise a refetch resurrects the note). */
  private async consume(note: ShieldNote): Promise<void> {
    this.store.markSpent(note.commitment);
    if (this.cfg.noteVault) {
      try { await Promise.resolve(this.cfg.noteVault.setSpent(note.commitment)); } catch { /* best-effort */ }
    }
    if (!this.api.authenticated) return;
    try {
      // A received note's row is owned by the SENDER's wallet, so a wallet-scoped
      // mark-spent would miss it and the note would look spendable forever (and
      // fail on chain as "already spent" on reuse). Claim the row under THIS
      // wallet first, then mark it spent.
      if (note.ciphertext) await this.api.registerNote(note.commitment, note.ciphertext);
      await this.api.markSpent(note.commitment);
    } catch (e) {
      this.log.warn("failed to mark note spent on the API", { commitment: note.commitment, e });
    }
  }

  private async submitShield(asset: AssetInfo, amount: bigint, commitment: string, ownerCommitment: string, currentRoot: string, newRoot: string, leafIndex: number, inc: Inclusion): Promise<string> {
    if (!this.cfg.signer) throw new ConfigError("a signer is required to shield");
    // The relayer network publishes the aggregation root; wait until it is on
    // chain — on THIS ASSET'S verifier (native STX vs sip10-zk-verifier) —
    // before the (user-signed) shield references it, else verify-proof reverts
    // with ERR-AGGREGATION-NOT-FOUND.
    await this.waitForRoot(inc, this.splitPrincipal(asset.verifier)[1]);
    const buf = (h: string) => Cl.bufferFromHex(h.replace(/^0x/, ""));
    const incArgs = [Cl.uint(inc.domainId), Cl.uint(inc.aggregationId), Cl.list(inc.merklePath.map((p) => buf(p))), Cl.uint(inc.leafIndex)];
    // Both pools (v2) bind the leaf-index between new-root and the inclusion args.
    const core = [buf(commitment), buf(ownerCommitment), buf(toHex32(0n)), buf(currentRoot), buf(newRoot), Cl.uint(leafIndex), ...incArgs];
    // Route to the asset's pool. Shield is necessarily user-signed (it moves the
    // caller's own tokens). SIP-10 leads with the token trait; native STX does not.
    const [addr, name] = this.poolOf(asset);
    const functionArgs = asset.native
      ? [Cl.uint(amount), ...core] // privacy-pool.shield
      : [Cl.contractPrincipal(...this.tokenOf(asset)), Cl.uint(amount), ...core]; // sip10-pool.shield(token, ...)
    return this.cfg.signer.signAndBroadcast({
      contractAddress: addr, contractName: name, functionName: "shield", functionArgs,
    }, this.cfg.network);
  }

  /** Split a contract principal ("ADDR.name") into [addr, name]. */
  private splitPrincipal(p: string): [string, string] {
    const [addr, name] = p.split(".");
    if (!addr || !name) throw new ConfigError(`malformed contract principal: ${p}`);
    return [addr, name];
  }
  private poolOf(asset: AssetInfo): [string, string] {
    return this.splitPrincipal(asset.pool);
  }
  private tokenOf(asset: AssetInfo): [string, string] {
    return this.splitPrincipal(asset.token as string);
  }
  /** Wait until the aggregation root is posted on the given verifier contract
   *  (native `zk-verifier` or `sip10-zk-verifier`), read live from chain — the
   *  relayer publishes to both, but a shield must not broadcast until ITS
   *  verifier has the root. */
  private async waitForRoot(inc: Inclusion, verifierContract: string, tries = 45): Promise<void> {
    for (let i = 0; i < tries; i++) {
      if (await this.aggregationPosted(verifierContract, inc.domainId, inc.aggregationId)) return;
      await new Promise((r) => setTimeout(r, 8000));
    }
    this.log.warn("aggregation root not observed on verifier; submitting anyway", { verifierContract });
  }
  private async aggregationPosted(verifierContract: string, domainId: number, aggregationId: number): Promise<boolean> {
    try {
      const hiro = NETWORKS[this.cfg.network].hiroApiUrl;
      const res = await fetch(
        `${hiro}/v2/contracts/call-read/${this.cfg.deployer}/${verifierContract}/get-aggregation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender: this.cfg.deployer, arguments: [cvToHex(Cl.uint(domainId)), cvToHex(Cl.uint(aggregationId))] }),
        },
      );
      const j = (await res.json()) as { okay?: boolean; result?: string };
      if (!j.result) return false;
      const cv = cvToJSON(hexToCV(j.result)) as { value?: unknown };
      return cv.value != null; // (some {...}) vs (none)
    } catch {
      return false;
    }
  }

  /** Poll a broadcast transaction until it settles. Returns "confirmed" on
   *  success; THROWS if it reverted (abort_by_response / abort_by_post_condition,
   *  e.g. a SIP-10 shield whose token transfer failed with u459) or was dropped;
   *  returns "pending" if it is still unconfirmed after the timeout (so the note
   *  is kept as pending — honest — rather than falsely reported as complete). */
  private async waitForTx(txid: string, tries = 60): Promise<OperationStatus> {
    const hiro = NETWORKS[this.cfg.network].hiroApiUrl;
    const id = txid.startsWith("0x") ? txid : `0x${txid}`;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(`${hiro}/extended/v1/tx/${id}`);
        if (res.ok) {
          const j = (await res.json()) as { tx_status?: string; tx_result?: { repr?: string } };
          const s = j.tx_status;
          if (s === "success") return "confirmed";
          if (s && (s.startsWith("abort") || s.startsWith("dropped"))) {
            const repr = j.tx_result?.repr ? ` ${j.tx_result.repr}` : "";
            throw new STXShieldError("SHIELD_REVERTED", `shield transaction reverted on chain (${s}${repr})`);
          }
          // pending / not-yet-broadcast (404 handled below): keep polling.
        }
      } catch (e) {
        if (e instanceof STXShieldError) throw e; // terminal revert — propagate
        // transient network / not-yet-indexed: keep polling
      }
      await new Promise((r) => setTimeout(r, 8000));
    }
    this.log.warn("shield tx not confirmed before timeout; leaving note pending", { txid });
    return "pending";
  }
}
