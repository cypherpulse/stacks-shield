// =============================================================================
// STX Shield -- circuit version upgrade
// =============================================================================
//   pnpm upgrade:circuits testnet
//
// Verification keys are immutable per (proof-type, circuit-version), which is
// deliberate: a registered circuit can never be swapped underneath users. So
// changing a circuit means registering its key under a NEW version and moving
// the protocol's live version forward.
//
//   1. stage the new vkeys under circuit version N+1   (allowed in any state)
//   2. pause -> begin-upgrade                          (upgrade window opens)
//   3. update-versions: circuit = N+1
//   4. complete-upgrade                               (UPGRADING -> ACTIVE)
//
// Staging first means the window in step 2-4 is as short as possible: if
// anything goes wrong while staging, the protocol has not been touched.
// Existing notes remain spendable — commitments and nullifiers are version
// independent.

import { Cl } from "@stacks/transactions";
import {
  CIRCUITS,
  NETWORKS,
  loadClarinetApiUrl,
  loadEnv,
  resolveDeployerMnemonic,
  type Network,
} from "../deployment/config.js";
import { Deployer, signerFromMnemonic } from "../deployment/deployer.js";

const buf = (hex: string) =>
  Cl.buffer(Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex")));

const ENV_KEY: Record<number, string> = {
  1: "SHIELD",
  2: "TRANSFER",
  3: "WITHDRAW",
  4: "SPLIT",
  5: "MERGE",
};

const main = async (): Promise<number> => {
  const network = (process.argv[2] as Network) ?? "testnet";
  const env = loadEnv(network === "mainnet" ? ".env.mainnet" : ".env.testnet");
  const signer = await signerFromMnemonic(resolveDeployerMnemonic(env, network), network);
  const d = new Deployer(
    network,
    signer,
    env["STACKS_API_URL"] || loadClarinetApiUrl(network) || NETWORKS[network].coreApiUrl,
  );

  const readUint = async (contract: "privacy-registry", fn: string): Promise<number> => {
    const res = await d.readOnly(contract, fn);
    if (!res.okay || !res.result) throw new Error(`${fn} failed: ${res.cause}`);
    return Number(BigInt(res.result.replace(/^0x01/, "0x")));
  };

  const current = await readUint("privacy-registry", "get-circuit-version");
  const next = current + 1;

  console.log("=".repeat(64));
  console.log(`Circuit upgrade on ${network}: v${current} -> v${next}`);
  console.log("=".repeat(64));

  // --- 1. stage the new keys (protocol untouched) -------------------------
  console.log(`\nStaging verification keys under circuit version ${next}...`);
  for (const circuit of CIRCUITS) {
    const key = ENV_KEY[circuit.proofType]!;
    const hash = env[`VKEY_HASH_${key}`];
    const len = env[`PROOF_LEN_${key}`];
    if (!hash || !len) {
      console.error(`  MISSING VKEY_HASH_${key} / PROOF_LEN_${key} — aborting before any change`);
      return 1;
    }
    try {
      await d.callContract(
        "zk-verifier",
        "register-verification-key",
        [Cl.uint(circuit.proofType), Cl.uint(next), buf(hash), Cl.uint(Number(len))],
        `stage ${circuit.name} v${next}`,
      );
    } catch {
      console.log(`  · ${circuit.name} v${next} already staged`);
    }
  }

  // --- 2-4. the upgrade window -------------------------------------------
  console.log("\nOpening the upgrade window...");
  await d.callContract("privacy-registry", "pause-protocol", [], "pause");
  await d.callContract("privacy-registry", "begin-upgrade", [], "begin-upgrade");

  const versions = {
    protocol: await readUint("privacy-registry", "get-protocol-version"),
    verifier: await readUint("privacy-registry", "get-verifier-version"),
    note: await readUint("privacy-registry", "get-note-version"),
    commitment: await readUint("privacy-registry", "get-commitment-version"),
    root: await readUint("privacy-registry", "get-root-version"),
  };

  await d.callContract(
    "privacy-registry",
    "update-versions",
    [
      Cl.tuple({
        protocol: Cl.uint(versions.protocol),
        verifier: Cl.uint(versions.verifier),
        note: Cl.uint(versions.note),
        circuit: Cl.uint(next),
        commitment: Cl.uint(versions.commitment),
        root: Cl.uint(versions.root),
      }),
    ],
    `set circuit version ${next}`,
  );

  // complete-upgrade transitions UPGRADING -> ACTIVE directly. There is NO
  // separate unpause: calling one would fail with u107 because the protocol
  // is already active.
  await d.callContract("privacy-registry", "complete-upgrade", [], "complete-upgrade");

  const live = await readUint("privacy-registry", "get-circuit-version");
  const state = await readUint("privacy-registry", "get-protocol-state");
  console.log(`\nLive circuit version: ${live}   protocol state: ${state} (1 = ACTIVE)`);
  if (live !== next) {
    console.error("UPGRADE DID NOT TAKE EFFECT");
    return 1;
  }
  if (state !== 1) {
    console.error("PROTOCOL IS NOT ACTIVE - resolve before use");
    return 1;
  }
  console.log("Upgrade complete. Existing notes remain spendable.");
  return 0;
};

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error("\nUpgrade failed:", e instanceof Error ? e.message : e);
    console.error("If the protocol is left paused, resolve with resolve-emergency/unpause.");
    process.exit(1);
  });
