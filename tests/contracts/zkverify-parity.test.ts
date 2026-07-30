import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { keccak_256 } from "@noble/hashes/sha3.js";

/*
  THE GATE: contract == SDK == zkVerify.

  This is not a simulation. Every value here was captured from the LIVE
  zkVerify Volta network and a real finalized UltraHonk proof of our shield
  circuit (extrinsic 0x7000313b…, statement 0x29287d84…).

  zkVerify's statement (leaf) formula, taken verbatim from the pallet
  (pallets/verifiers/src/lib.rs:227-231):

    let mut data = keccak_256(hash_context_data()).to_vec();  // b"ultrahonk"
    data.extend(vk_hash);                                     // keccak256(vk.encode())
    data.extend(version_hash);                                // per proof version
    data.extend(keccak_256(pubs_bytes));                      // keccak256(public inputs)
    keccak_256(data)

  We assert the DEPLOYED contract's `statement-leaf`, configured with the real
  constants, reproduces the real statement byte-for-byte. If this passes, the
  encoding is correct against the network — not against our assumptions.
*/

const VERIFIER = "zk-verifier";
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;

// ---- values observed from the LIVE network -------------------------------

/** keccak256(b"ultrahonk") — the UltraHonk pallet's verifier context. */
const CONTEXT_HASH = "0xa33e2e948e18eac44032d702b6274d45df693c3ddd3b1260bbadf0c89c16d7cb";

/** SHA2-256("ultrahonk:v3.0"), the V3_0 proof version hash (pallet constant). */
const VERSION_HASH_V3_0 =
  "0x55b52ad2b4153c872e27d688f567c1406f0d93b5528dd2b0bf2a9a40df97f1f9";

/** zkVerify vk hashes (keccak256 of the SCALE-encoded VersionedVk), per
 *  circuit, obtained from the network's `vk_hash` RPC. */
const ZKV_VK_HASH = {
  shield: "0x96889d2466624e271b44d4e32ac8b557bdfdc922a1a16dc42f5c807f2dcacad8",
  transfer: "0x3668b8b291ddf8cb0bc60bf9f3f33ce9e5af9d2de631ebd3bfb10a4455e91595",
  withdraw: "0x5e1ad470b0b8b0094acd87360989f31c1059ba73e6613522d0b07d55e6b749de",
  split: "0x7a3fbca8876dbbd32c5977c886cc843b41b18201330a80378719b12383ec2b01",
  merge: "0x025d92c5d1f17b50433ab138f5f603eb64cb94b48299b5f23b9b8fcda76735de",
} as const;

/** From the real shield proof: keccak256 of its `public_inputs` bytes. */
const REAL_KECCAK_PUBS =
  "0x3de12c8af00ae185802ae389ef304c58122bfa6a472ed41ab3f642d1f34eef7d";

/** The statement zkVerify actually returned for that proof. */
const REAL_STATEMENT = "0x29287d845ebb45c1085dc13b7f8c309f5ebdec56ee9a02cd6dad6cb5e8f07c93";

const PROOF_TYPE_SHIELD = 1;
const CIRCUIT_VERSION = 1;
const PROOF_LEN = 7872;
const VKEY = "0x" + "5a".repeat(32);

const buf = (hex: string) => Cl.buffer(Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex")));
const vCall = (fn: string, args: unknown[]) =>
  simnet.callPublicFn(VERIFIER, fn, args as never, deployer);
const vRead = (fn: string, args: unknown[]) =>
  simnet.callReadOnlyFn(VERIFIER, fn, args as never, deployer).result;

/** Configure the deployed verifier with the REAL zkVerify constants. */
const configureShield = () => {
  vCall("register-verification-key", [
    Cl.uint(PROOF_TYPE_SHIELD),
    Cl.uint(CIRCUIT_VERSION),
    buf(VKEY),
    Cl.uint(PROOF_LEN),
  ]);
  vCall("set-zkverify-context-hash", [buf(CONTEXT_HASH)]);
  vCall("set-zkverify-binding", [
    Cl.uint(PROOF_TYPE_SHIELD),
    Cl.uint(CIRCUIT_VERSION),
    buf(ZKV_VK_HASH.shield),
    buf(VERSION_HASH_V3_0),
  ]);
};

describe("contract == zkVerify (real network values)", () => {
  it("reproduces the pallet's statement formula off chain (sanity)", () => {
    // Independent JS reproduction, so a contract failure below can be
    // localized to the contract rather than the constants.
    const h = (s: string) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ""), "hex"));
    const cat = (...a: Uint8Array[]) => {
      const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
      let i = 0;
      for (const x of a) {
        o.set(x, i);
        i += x.length;
      }
      return o;
    };
    const statement = keccak_256(
      cat(h(CONTEXT_HASH), h(ZKV_VK_HASH.shield), h(VERSION_HASH_V3_0), h(REAL_KECCAK_PUBS)),
    );
    expect("0x" + Buffer.from(statement).toString("hex")).toBe(REAL_STATEMENT);
  });

  it("the DEPLOYED contract derives the real statement from the real inputs", () => {
    configureShield();
    // get-statement-leaf takes the public-inputs-hash the pool would compute.
    // For the real proof that hash is keccak256(public_inputs) = REAL_KECCAK_PUBS,
    // because the pool hashes exactly the circuit's field elements (canonical
    // encoding). The contract must return the exact statement zkVerify did.
    expect(
      vRead("get-statement-leaf", [
        Cl.uint(PROOF_TYPE_SHIELD),
        Cl.uint(CIRCUIT_VERSION),
        buf(REAL_KECCAK_PUBS),
      ]),
    ).toBeOk(buf(REAL_STATEMENT));
  });

  it("context hash is keccak256(\"ultrahonk\")", () => {
    const k = keccak_256(new TextEncoder().encode("ultrahonk"));
    expect("0x" + Buffer.from(k).toString("hex")).toBe(CONTEXT_HASH);
  });

  it("each circuit has a distinct zkVerify vk hash", () => {
    const hashes = Object.values(ZKV_VK_HASH);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("a wrong vk hash no longer reproduces the statement", () => {
    configureShield();
    // reconfigure with transfer's vk hash under shield's slot
    vCall("set-zkverify-binding", [
      Cl.uint(PROOF_TYPE_SHIELD),
      Cl.uint(CIRCUIT_VERSION),
      buf(ZKV_VK_HASH.transfer),
      buf(VERSION_HASH_V3_0),
    ]);
const leaf = vRead("get-statement-leaf", [
      Cl.uint(PROOF_TYPE_SHIELD),
      Cl.uint(CIRCUIT_VERSION),
      buf(REAL_KECCAK_PUBS),
    ]);
    expect(leaf).not.toBeOk(buf(REAL_STATEMENT));
  });
});

/*
  Real zkVerify aggregation Merkle sample. Captured from a live domain-0
  aggregation of our shield proof:
    aggregation 269656, single leaf, root = keccak256(leaf).
  Proves the deployed contract's Merkle verification matches Substrate's
  binary-merkle-tree (leaves are hashed) against real network data.
*/
describe("merkle inclusion == real zkVerify aggregation", () => {
  const REAL_LEAF = "0x29287d845ebb45c1085dc13b7f8c309f5ebdec56ee9a02cd6dad6cb5e8f07c93";
  const REAL_ROOT = "0x35de1280db488fbc7144bf986d51e6636406f984db0b84e6f020622e798473b1";

  it("reconstructs the real single-leaf root (root == keccak256(leaf))", () => {
    vCall("submit-aggregation", [Cl.uint(0), Cl.uint(269656), buf(REAL_ROOT), Cl.uint(1)]);
    expect(
      vRead("check-inclusion", [
        Cl.uint(0),
        Cl.uint(269656),
        buf(REAL_LEAF),
        Cl.list([]),
        Cl.uint(0),
      ]),
    ).toBeOk(Cl.bool(true));
  });

  it("rejects a wrong leaf against the real root", () => {
    vCall("submit-aggregation", [Cl.uint(0), Cl.uint(269656), buf(REAL_ROOT), Cl.uint(1)]);
    expect(
      vRead("check-inclusion", [
        Cl.uint(0),
        Cl.uint(269656),
        buf("0x" + "11".repeat(32)),
        Cl.list([]),
        Cl.uint(0),
      ]),
    ).toBeOk(Cl.bool(false));
  });
});
