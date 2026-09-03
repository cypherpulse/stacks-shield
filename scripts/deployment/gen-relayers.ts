// =============================================================================
// gen-relayers.ts -- mint fresh relayer wallets (default 3)
// =============================================================================
//   npx tsx scripts/deployment/gen-relayers.ts        # 3 relayers
//   npx tsx scripts/deployment/gen-relayers.ts 2      # N relayers
//
// Generates N brand-new Stacks wallets to run as relayers -- SEPARATE from the
// deployer. For each it prints the testnet address, the private key (for the
// relayer service's RELAYER_PRIVATE_KEY), and the mnemonic (backup). These are
// SECRETS shown once on your terminal only; nothing is written to disk.
//
// After this:
//   1. FUND each address at the testnet faucet (relayers pay gas).
//   2. Put the addresses in .env.v2.deploy as RELAYER_ADDRESSES=ST..,ST..,ST..
//      then: npx tsx scripts/deployment/set-relayers.ts   (seats them on both verifiers)
//   3. Run one relayer service per wallet (services/relayer), each with its own
//      RELAYER_PRIVATE_KEY + RELAYER_ADDRESS, and expose their URLs to the SDK
//      via STX_SHIELD_RELAYERS=r1=https://..,r2=https://..,r3=https://..

import { generateSecretKey, generateWallet, getStxAddress } from "@stacks/wallet-sdk";

async function one(): Promise<{ address: string; key: string; mnemonic: string }> {
  const mnemonic = generateSecretKey(256);
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  const account = wallet.accounts[0];
  if (!account) throw new Error("failed to derive account");
  return { address: getStxAddress({ account, network: "testnet" }), key: account.stxPrivateKey, mnemonic };
}

async function main(): Promise<void> {
  const n = Math.max(1, Math.min(10, Number(process.argv[2] ?? 3)));
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(await one());

  console.log("=".repeat(70));
  console.log(`${n} RELAYER WALLETS (testnet) -- SECRETS, shown once`);
  console.log("=".repeat(70));
  rows.forEach((r, i) => {
    console.log(`\nRelayer ${i + 1}`);
    console.log(`  address    : ${r.address}`);
    console.log(`  privateKey : ${r.key}`);
    console.log(`  mnemonic   : ${r.mnemonic}`);
  });
  console.log("\n" + "=".repeat(70));
  console.log("# paste into .env.v2.deploy:");
  console.log(`RELAYER_ADDRESSES=${rows.map((r) => r.address).join(",")}`);
  console.log("RELAYER_DROP_DEPLOYER=true");
  console.log("=".repeat(70));
  console.log(
    "\nNext: fund each address at https://explorer.hiro.so/sandbox/faucet?chain=testnet ,\n" +
      "then `npx tsx scripts/deployment/set-relayers.ts`. Give each relayer SERVICE its own\n" +
      "privateKey (RELAYER_PRIVATE_KEY). SAVE THESE SECRETS -- not shown again.",
  );
}

main().catch((e) => {
  console.error("gen-relayers failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
