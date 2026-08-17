// =============================================================================
// @stacks-shield/sdk -- Node CLI test harness
// =============================================================================
// A key-based CLI to exercise the full private lifecycle (shield, split, merge,
// withdraw, transfer) against testnet, and to LIST/VERIFY your notes directly
// FROM CHAIN (commitment registration + nullifier-spent) rather than the API.
//
// Notes are held locally in a JSON file (default: ./cli-notes.json) because the
// SDK's in-memory store does not persist. Amounts are decrypted locally and
// never leave this machine.
//
//   cd sdk
//   npx tsx --env-file=../.env.cli examples/cli.ts <command> [args]
//
// Commands:
//   address                       Print your Stacks + STX Shield addresses
//   shield <stx>                  Shield <stx> STX into a new private note
//   list                          List your notes, verified against chain
//   split <index> <a> <b>         Split note #index into a + b STX
//   merge <i> <j>                 Merge notes #i and #j into one
//   withdraw <index> [recipient]  Redeem note #index to a transparent address
//   transfer <index> <shieldAddr> Send note #index privately to a shield address
//
// See clitest.md for the full guide.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { poseidon2 } from "poseidon-lite";
import {
  Cl,
  cvToHex,
  cvToJSON,
  getAddressFromPrivateKey,
  hexToCV,
  makeContractCall,
  broadcastTransaction,
  PostConditionMode,
  privateKeyToPublic,
  signMessageHashRsv,
  type ClarityValue,
} from "@stacks/transactions";
import { hashMessage } from "@stacks/encryption";

import {
  STXShield,
  type ContractCall,
  type Network,
  type ShieldNote,
  type WalletSigner,
} from "@stacks-shield/sdk";
import { createNodeEngine } from "@stacks-shield/sdk/node";

// ---- config (env with sensible testnet defaults) ---------------------------

const PK = process.env["STX_PRIVATE_KEY"];
if (!PK) {
  console.error("STX_PRIVATE_KEY is not set. See clitest.md for setup.");
  process.exit(1);
}
const NETWORK = (process.env["STX_NETWORK"] ?? "testnet") as Network;
const API_URL = process.env["STX_API_URL"] ?? "https://stx-shield-api.onrender.com";
const RELAYER_URL = process.env["STX_RELAYER_URL"] ?? "http://localhost:8787";
const DEPLOYER = process.env["STX_DEPLOYER"] ?? "ST2HXRZ8A82JJAP14KD83JEXNRCF34J67088WJSJH";
const HIRO = process.env["STX_HIRO_URL"] ?? "https://api.testnet.hiro.so";
const CIRCUITS_DIR = process.env["STX_CIRCUITS_DIR"] ?? "../zk/circuits";
const NOTES_FILE = process.env["STX_NOTES_FILE"] ?? "./cli-notes.json";

const STX = 1_000_000n;
const toHex32 = (x: bigint): string => "0x" + x.toString(16).padStart(64, "0");
const fmt = (micro: bigint): string => (Number(micro) / 1e6).toLocaleString() + " STX";

// ---- local note persistence (bigints survive JSON round-trips) -------------

function loadNotes(): ShieldNote[] {
  if (!existsSync(NOTES_FILE)) return [];
  const raw = readFileSync(NOTES_FILE, "utf8");
  return JSON.parse(raw, (_k, v) =>
    v && typeof v === "object" && "__bigint" in v ? BigInt(v.__bigint) : v,
  ) as ShieldNote[];
}
function saveNotes(notes: ShieldNote[]): void {
  const raw = JSON.stringify(
    notes,
    (_k, v) => (typeof v === "bigint" ? { __bigint: v.toString() } : v),
    2,
  );
  writeFileSync(NOTES_FILE, raw);
}

// ---- a minimal key-based signer --------------------------------------------
// NOTE: getShieldSecret derives a STABLE CLI identity from your key. It is
// independent of your browser identity (the browser derives the secret from a
// wallet signature), so this CLI has its OWN shield address and sees only notes
// it created. That is exactly what you want for a self-contained lifecycle test.

function makeSigner(privateKey: string): WalletSigner {
  return {
    getAddress: (network) => getAddressFromPrivateKey(privateKey, network),
    signMessage: async (message) => {
      const hashed = hashMessage(message);
      const messageHash = typeof hashed === "string" ? hashed : bytesToHex(hashed);
      const sig = signMessageHashRsv({ messageHash, privateKey });
      const signature = typeof sig === "string" ? sig : (sig as { data: string }).data;
      const pub = privateKeyToPublic(privateKey);
      const publicKey = typeof pub === "string" ? pub : bytesToHex(pub);
      return { signature, publicKey };
    },
    signAndBroadcast: async (call: ContractCall, network) => {
      const tx = await makeContractCall({
        contractAddress: call.contractAddress,
        contractName: call.contractName,
        functionName: call.functionName,
        functionArgs: call.functionArgs as ClarityValue[],
        senderKey: privateKey,
        network,
        postConditionMode: PostConditionMode.Allow, // shield moves the user's own STX
      });
      const res = await broadcastTransaction({ transaction: tx, network });
      if ("error" in res && res.error) {
        throw new Error(`broadcast failed: ${res.reason ?? ""} ${res.error}`);
      }
      return res.txid;
    },
    getShieldSecret: () => sha256(new TextEncoder().encode("stx-shield-cli:v1:" + privateKey)),
  };
}

// ---- read-only chain queries (privacy-registry) ----------------------------

const buff = (hex: string): string => cvToHex(Cl.bufferFromHex(hex.replace(/^0x/, "")));

async function callRead(fn: string, args: string[]): Promise<unknown> {
  const res = await fetch(`${HIRO}/v2/contracts/call-read/${DEPLOYER}/privacy-registry/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: DEPLOYER, arguments: args }),
  });
  const j = (await res.json()) as { okay?: boolean; result?: string; cause?: string };
  if (!j.result) throw new Error(`call-read ${fn} failed: ${j.cause ?? JSON.stringify(j)}`);
  return cvToJSON(hexToCV(j.result));
}
// Coerce a Clarity bool/response into a JS boolean.
function asBool(cv: unknown): boolean {
  const v = cv as { value?: unknown };
  if (typeof v.value === "boolean") return v.value;
  if (v.value && typeof v.value === "object") return asBool(v.value);
  return false;
}

/** Verify a note against chain: is its commitment registered, is it spent. */
async function verifyOnChain(note: ShieldNote): Promise<{ registered: boolean; spent: boolean }> {
  const nullifier = toHex32(poseidon2([BigInt(note.commitment), note.secret.ownerSk]));
  const [registered, spent] = await Promise.all([
    callRead("is-commitment-registered", [buff(note.commitment)]).then(asBool),
    callRead("is-nullifier-spent", [buff(nullifier)]).then(asBool),
  ]);
  return { registered, spent };
}

// ---- client ----------------------------------------------------------------

function makeClient(): STXShield {
  return new STXShield({
    network: NETWORK,
    apiUrl: API_URL,
    relayerUrl: RELAYER_URL,
    deployer: DEPLOYER,
    signer: makeSigner(PK!),
    proofEngine: createNodeEngine({ circuitsDir: CIRCUITS_DIR }),
    // Proofs are submitted through the relayer's hosted /submit endpoint.
    zkVerify: { endpointUrl: RELAYER_URL },
  });
}

// ---- commands --------------------------------------------------------------

async function cmdAddress(shield: STXShield): Promise<void> {
  const stxAddr = await makeSigner(PK!).getAddress(NETWORK);
  console.log("Stacks address:      ", stxAddr);
  console.log("Stacks Shield address:  ", await shield.getAddress());
}

async function cmdShield(shield: STXShield, stx: number): Promise<void> {
  console.log(`Shielding ${stx} STX ...`);
  const { note, txid } = await shield.shield(stx);
  const notes = loadNotes();
  notes.push(note);
  saveNotes(notes);
  console.log(`OK  note ${note.commitment} = ${fmt(note.amount)}  (tx ${txid})`);
}

async function cmdList(): Promise<void> {
  const notes = loadNotes();
  if (notes.length === 0) return void console.log("No local notes. Shield some STX first.");
  console.log(`Verifying ${notes.length} note(s) against chain (${DEPLOYER}) ...\n`);
  let balance = 0n;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]!;
    const { registered, spent } = await verifyOnChain(n);
    const state = spent ? "SPENT" : registered ? "unspent" : "pending";
    if (registered && !spent) balance += n.amount;
    console.log(
      `#${i}  ${fmt(n.amount).padEnd(16)}  ${n.commitment.slice(0, 14)}…  [${state}]`,
    );
  }
  console.log(`\nSpendable balance (on-chain, unspent): ${fmt(balance)}`);
}

async function cmdSplit(shield: STXShield, index: number, a: number, b: number): Promise<void> {
  const notes = loadNotes();
  const input = notes[index];
  if (!input) throw new Error(`no note at index ${index} (run 'list')`);
  console.log(`Splitting #${index} (${fmt(input.amount)}) into ${a} + ${b} STX ...`);
  const { notes: outputs, txid } = await shield.split(input, [a, b]);
  const next = notes.filter((_, i) => i !== index).concat(outputs);
  saveNotes(next);
  console.log(`OK  ${outputs.map((o) => fmt(o.amount)).join(" + ")}  (tx ${txid})`);
}

async function cmdMerge(shield: STXShield, i: number, j: number): Promise<void> {
  const notes = loadNotes();
  const a = notes[i], b = notes[j];
  if (!a || !b) throw new Error(`need two valid indices (run 'list')`);
  console.log(`Merging #${i} (${fmt(a.amount)}) + #${j} (${fmt(b.amount)}) ...`);
  const { note, txid } = await shield.merge([a, b]);
  const next = notes.filter((_, k) => k !== i && k !== j).concat(note);
  saveNotes(next);
  console.log(`OK  merged into ${fmt(note.amount)}  (tx ${txid})`);
}

async function cmdWithdraw(shield: STXShield, index: number, recipient?: string): Promise<void> {
  const notes = loadNotes();
  const input = notes[index];
  if (!input) throw new Error(`no note at index ${index} (run 'list')`);
  console.log(`Withdrawing #${index} (${fmt(input.amount)}) ...`);
  const res = await shield.withdraw(input, recipient);
  saveNotes(notes.filter((_, i) => i !== index));
  console.log(`OK  sent to ${res.recipient}  (tx ${res.txid})`);
}

async function cmdTransfer(shield: STXShield, index: number, to: string): Promise<void> {
  const notes = loadNotes();
  const input = notes[index];
  if (!input) throw new Error(`no note at index ${index} (run 'list')`);
  console.log(`Transferring #${index} (${fmt(input.amount)}) to ${to.slice(0, 16)}… ...`);
  const res = await shield.transfer(Number(input.amount) / 1e6, to);
  saveNotes(notes.filter((_, i) => i !== index));
  console.log(`OK  sent privately  (tx ${res.txid})`);
}

// ---- entry -----------------------------------------------------------------

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "list") return void (await cmdList());

  const shield = makeClient();
  // Authenticate best-effort so ciphertexts register (needed for transfer /
  // browser discovery). Reading notes from chain does not require it.
  try {
    await shield.connect();
  } catch (e) {
    console.warn("warning: not authenticated to the API —", (e as Error).message);
  }

  switch (cmd) {
    case "address":
      return void (await cmdAddress(shield));
    case "shield":
      return void (await cmdShield(shield, Number(args[0])));
    case "split":
      return void (await cmdSplit(shield, Number(args[0]), Number(args[1]), Number(args[2])));
    case "merge":
      return void (await cmdMerge(shield, Number(args[0]), Number(args[1])));
    case "withdraw":
      return void (await cmdWithdraw(shield, Number(args[0]), args[1]));
    case "transfer":
      return void (await cmdTransfer(shield, Number(args[0]), args[1]!));
    default:
      console.error(`unknown command: ${cmd}. See clitest.md.`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
