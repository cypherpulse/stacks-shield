import { CommitmentTree } from "./merkle-tree/index.js";
import { Cl, cvToHex, hexToCV, cvToJSON } from "@stacks/transactions";

const API = process.env.API_URL || "https://stx-shield-api.onrender.com";
const HIRO = "https://api.testnet.hiro.so";
const DEP = process.env.STX_DEPLOYER || "ST18XMPE0PS5VNEEKB82BPW7NRZRHXEPH16JK8NN6";
const hexToBytes = (h: string) => { const s = h.replace(/^0x/, ""); const o = new Uint8Array(s.length/2); for (let i=0;i<o.length;i++) o[i]=parseInt(s.slice(i*2,i*2+2),16); return o; };
const bytesToHex = (b: Uint8Array) => "0x" + Array.from(b, x=>x.toString(16).padStart(2,"0")).join("");

const cr = await fetch(`${API}/commitments`);
if (!cr.ok) { console.log("/commitments ->", cr.status, "(API not redeployed?)"); process.exit(0); }
const { results } = await cr.json() as { results: {commitment:string;leafIndex:number}[] };
console.log("commitments:", results.length, "| first leafIndex:", results[0]?.leafIndex, "| last:", results.at(-1)?.leafIndex);

const tree = new CommitmentTree();
for (const c of results) tree.insert(hexToBytes(c.commitment.startsWith("0x")?c.commitment:"0x"+c.commitment));
const recon = bytesToHex(tree.root);
console.log("reconstructed root:", recon);

const rc = await fetch(`${HIRO}/v2/contracts/call-read/${DEP}/privacy-registry/get-current-root`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sender:DEP,arguments:[]})});
const live = (cvToJSON(hexToCV(((await rc.json()) as any).result)) as any).value.root.value;
console.log("live current-root: ", live);
console.log("MATCH reconstructed == live:", recon.toLowerCase() === live.toLowerCase());

const kr = await fetch(`${HIRO}/v2/contracts/call-read/${DEP}/privacy-registry/is-known-root`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sender:DEP,arguments:[cvToHex(Cl.bufferFromHex(recon.replace(/^0x/,"")))]})});
const known = cvToJSON(hexToCV(((await kr.json()) as any).result));
console.log("is-known-root(reconstructed):", JSON.stringify(known));
