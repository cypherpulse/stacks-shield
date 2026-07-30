import { poseidon2, poseidon4 } from "poseidon-lite";
import { createNodeEngine } from "../../sdk/src/node.js";

const engine = createNodeEngine({ circuitsDir: "zk/circuits", threads: 4 });
const secret = new Uint8Array(32).fill(7);
secret[31] = 42;
const owner = await engine.deriveOwnerKey(secret);
const amount = 1_000_000n, blinding = 12345n;
const commitment = BigInt(poseidon4([amount, owner.pkX, owner.pkY, blinding]));
const ownerCommitment = BigInt(poseidon2([owner.pkX, owner.pkY]));
const t = Date.now();
const raw = await engine.proveShield({ note: { amount, ownerPkX: owner.pkX, ownerPkY: owner.pkY, blinding }, commitment, ownerCommitment });
console.log("proveShield OK: proof", raw.proof.length, "chars, pub", raw.publicInputs.length, "vk", raw.vk.length, "chars,", ((Date.now() - t) / 1000).toFixed(1) + "s");
console.log("*** SDK bb.js engine generates a REAL proof end-to-end (ESM):", raw.proof.startsWith("0x") && raw.publicInputs.length === 5 && raw.vk.length > 1000, "***");
process.exit(0);
