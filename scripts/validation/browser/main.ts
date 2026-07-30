// Browser smoke test: generate a real shield proof with the SDK's web engine.
import { poseidon2, poseidon4 } from "poseidon-lite";
import { createWebEngine } from "../../../sdk/src/web.js";

declare global {
  interface Window { __result?: unknown }
}

const out = document.getElementById("out")!;
const log = (m: string) => { out.textContent += "\n" + m; console.log(m); };

(async () => {
  try {
    const isolated = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? false;
    const threads = isolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
    log(`crossOriginIsolated=${isolated}, threads=${threads}, ua=${navigator.userAgent.slice(0, 40)}`);

    const engine = createWebEngine({ artifactsBaseUrl: "/circuits", threads });

    const secret = new Uint8Array(32).fill(7); secret[31] = 42;
    let t = performance.now();
    const owner = await engine.deriveOwnerKey(secret);
    const keyMs = Math.round(performance.now() - t);
    log(`deriveOwnerKey ok (${keyMs}ms)`);

    const amount = 1_000_000n, blinding = 12345n;
    const commitment = BigInt(poseidon4([amount, owner.pkX, owner.pkY, blinding]));
    const ownerCommitment = BigInt(poseidon2([owner.pkX, owner.pkY]));

    t = performance.now();
    const raw = await engine.proveShield({ note: { amount, ownerPkX: owner.pkX, ownerPkY: owner.pkY, blinding }, commitment, ownerCommitment });
    const proveMs = Math.round(performance.now() - t);

    const proofBytes = (raw.proof.length - 2) / 2;
    const vkBytes = (raw.vk.length - 2) / 2;
    const ok = raw.proof.startsWith("0x") && raw.publicInputs.length === 5 && proofBytes === 7872 && vkBytes === 1888;
    log(`proveShield ok (${proveMs}ms): proof ${proofBytes}B, pub ${raw.publicInputs.length}, vk ${vkBytes}B`);
    window.__result = { ok, isolated, threads, keyMs, proveMs, proofBytes, vkBytes, publicInputs: raw.publicInputs.length };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const cause = (e as { cause?: unknown })?.cause;
    const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : "(none)";
    const causeStack = cause instanceof Error ? (cause.stack ?? "").split("\n").slice(0, 4).join(" | ") : "";
    log("ERROR: " + err + " | CAUSE: " + causeMsg + " | " + causeStack);
    window.__result = { ok: false, error: err, cause: causeMsg, stack: causeStack };
  }
})();
