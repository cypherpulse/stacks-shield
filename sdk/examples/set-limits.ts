// =============================================================================
// @stx-shield/sdk -- admin: lift the shield/withdraw limits on the LIVE contract
// =============================================================================
// Calls privacy-registry.update-protocol-limits with the protocol-admin key, so
// you do NOT need to redeploy. update-protocol-limits replaces the WHOLE set, so
// this passes all fields but only raises MAX SHIELD (to 50M); withdraw + mins
// stay at the original limits. Override any via env.
//
//   cd sdk
//   npx tsx --env-file=../.env.cli examples/set-limits.ts
//
// Requires ADMIN_PRIVATE_KEY (the deployer / ROLE-PROTOCOL-ADMIN key). Anyone
// else is rejected on-chain with ERR-UNAUTHORIZED.
//
// Override any value via env (all amounts in STX, converted to µSTX):
//   MIN_SHIELD_STX, MAX_SHIELD_STX, MIN_WITHDRAW_STX, MAX_WITHDRAW_STX

import {
  Cl,
  broadcastTransaction,
  makeContractCall,
  PostConditionMode,
  type ClarityValue,
} from "@stacks/transactions";

// ---- config ----------------------------------------------------------------

const ADMIN_KEY = process.env["ADMIN_PRIVATE_KEY"] ?? process.env["STX_PRIVATE_KEY"];
if (!ADMIN_KEY) {
  console.error("ADMIN_PRIVATE_KEY (the deployer/admin key) is not set.");
  process.exit(1);
}
const NETWORK = (process.env["STX_NETWORK"] ?? "testnet") as "testnet" | "mainnet";
const DEPLOYER = process.env["STX_DEPLOYER"] ?? "ST2HXRZ8A82JJAP14KD83JEXNRCF34J67088WJSJH";

// On-chain constants from privacy-registry.clar.
const STX = 1_000_000n;
const SUPPLY_CEILING = 1_818_000_000_000_000n; // STX-SUPPLY-CEILING (µSTX) -- the hard max
const TREE_CAPACITY = 1_048_576n; // MERKLE-TREE-CAPACITY

const stxEnv = (name: string, fallbackMicro: bigint): bigint =>
  process.env[name] ? BigInt(Math.round(Number(process.env[name]) * 1e6)) : fallbackMicro;

// Change SHIELD only: raise max shield to 50M; keep everything else at the
// ORIGINAL limits (min 1 STX, withdraw min 1 / max 1,000,000 STX).
// Override any via env (STX units).
const MIN_SHIELD = stxEnv("MIN_SHIELD_STX", 1n * STX);
const MAX_SHIELD = stxEnv("MAX_SHIELD_STX", 50_000_000n * STX);
const MIN_WITHDRAW = stxEnv("MIN_WITHDRAW_STX", 1n * STX);
const MAX_WITHDRAW = stxEnv("MAX_WITHDRAW_STX", 1_000_000n * STX);

for (const [k, v] of Object.entries({ MAX_SHIELD, MAX_WITHDRAW })) {
  if (v > SUPPLY_CEILING) {
    console.error(`${k} (${Number(v) / 1e6} STX) exceeds the STX supply ceiling; lower it.`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const limits = {
    "min-shield": Cl.uint(MIN_SHIELD),
    "max-shield": Cl.uint(MAX_SHIELD),
    "min-withdrawal": Cl.uint(MIN_WITHDRAW),
    "max-withdrawal": Cl.uint(MAX_WITHDRAW),
    "max-commitments": Cl.uint(TREE_CAPACITY),
    "max-notes": Cl.uint(TREE_CAPACITY),
    "max-fee-bps": Cl.uint(100n),
  };

  console.log("Updating privacy-registry protocol limits:");
  console.log(`  min shield:    ${Number(MIN_SHIELD) / 1e6} STX`);
  console.log(`  max shield:    ${(Number(MAX_SHIELD) / 1e6).toLocaleString()} STX`);
  console.log(`  min withdraw:  ${Number(MIN_WITHDRAW) / 1e6} STX`);
  console.log(`  max withdraw:  ${Number(MAX_WITHDRAW) / 1e6} STX`);

  const tx = await makeContractCall({
    contractAddress: DEPLOYER,
    contractName: "privacy-registry",
    functionName: "update-protocol-limits",
    functionArgs: [Cl.tuple(limits) as ClarityValue],
    senderKey: ADMIN_KEY!,
    network: NETWORK,
    postConditionMode: PostConditionMode.Deny, // this call moves no STX
  });

  const res = await broadcastTransaction({ transaction: tx, network: NETWORK });
  if ("error" in res && res.error) {
    throw new Error(`broadcast failed: ${res.reason ?? ""} ${res.error}`);
  }
  console.log(`\nBroadcast OK. txid: ${res.txid}`);
  console.log(`Track: https://explorer.hiro.so/txid/${res.txid}?chain=${NETWORK}`);
  console.log("Once confirmed, shields up to the new max succeed (ERR u132 gone).");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
