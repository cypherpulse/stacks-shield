// =============================================================================
// @stx-shield/sdk -- Node example
// =============================================================================
//   npx tsx examples/node.ts
//
// A full private lifecycle from Node. Requires a proof engine (the Noir +
// Barretenberg toolchain) and a key-based signer.

import { STXShield, type WalletSigner } from "@stx-shield/sdk";

// A minimal key-based signer. In a real app, back it with your wallet library.
declare const signer: WalletSigner;
// A Node proof engine (toolchain-backed). See the SDK's proving guide.
declare const nodeProofEngine: import("@stx-shield/sdk").ProofEngine;

async function main() {
  const shield = new STXShield({
    network: "testnet",
    signer,
    proofEngine: nodeProofEngine,
  });

  await shield.connect();
  console.log("shield address:", await shield.getAddress());

  // Shield 100 STX.
  const { note } = await shield.shield(100);
  console.log("shielded note:", note.commitment, note.amount, "µSTX");

  // Split 100 -> 40 + 60, then 60 -> 35 + 25.
  const { notes: [a, big] } = await shield.split(note, [40, 60]);
  const { notes: [b, c] } = await shield.split(big, [35, 25]);

  // Withdraw each to a transparent address.
  for (const n of [a, b, c]) {
    const res = await shield.withdraw(n);
    console.log(`withdrew ${n.amount} µSTX -> ${res.recipient} (${res.txid})`);
  }

  console.log("stats:", await shield.getStats());
}

main().catch(console.error);
