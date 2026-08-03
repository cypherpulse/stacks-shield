// =============================================================================
// Standalone: generate Stacks accounts (keys + addresses) from a seed phrase
// =============================================================================
// Independent of the STX Shield CLI. Generates a fresh 24-word mnemonic (or
// restores one you pass), derives N accounts down the Stacks derivation path,
// and prints each account's private key, public key, and testnet/mainnet
// addresses. Optionally writes them to a JSON file.
//
//   npx tsx scripts/generate-accounts.ts                 # new mnemonic, 3 accounts
//   COUNT=5 npx tsx scripts/generate-accounts.ts         # 5 accounts
//   MNEMONIC="word1 word2 …" npx tsx scripts/generate-accounts.ts   # restore
//   OUTPUT=accounts.json npx tsx scripts/generate-accounts.ts       # also save
//
// Env:
//   MNEMONIC  restore from this seed phrase (12 or 24 words). Omit to generate.
//   COUNT     number of accounts to derive (default 3).
//   WORDS     12 | 24 for a NEW mnemonic (default 24).
//   OUTPUT    path to write the accounts as JSON (optional).
//
// SECURITY: this prints PRIVATE KEYS and a MNEMONIC. Anyone with them controls
// the funds. Never share output, commit it, or use these keys on mainnet with
// real value unless you generated them securely and offline.

import { writeFileSync } from "node:fs";

import { getPublicKeyFromPrivate } from "@stacks/encryption";
import { getAddressFromPrivateKey } from "@stacks/transactions";
import { generateWallet, generateNewAccount, generateSecretKey } from "@stacks/wallet-sdk";

interface AccountOut {
  index: number;
  privateKey: string;
  publicKey: string;
  testnetAddress: string;
  mainnetAddress: string;
}

const COUNT = Math.max(1, Number(process.env["COUNT"] ?? 3));
const WORDS = (Number(process.env["WORDS"]) === 12 ? 12 : 24) as 12 | 24;
const OUTPUT = process.env["OUTPUT"];
// The wallet is derived from the mnemonic; the password only encrypts an
// in-memory config blob and does not affect the derived keys/addresses.
const PASSWORD = "stx-shield-account-gen";

async function main(): Promise<void> {
  const provided = process.env["MNEMONIC"]?.trim();
  const mnemonic = provided && provided.length > 0 ? provided : generateSecretKey(WORDS === 12 ? 128 : 256);
  const fresh = !provided;

  let wallet = await generateWallet({ secretKey: mnemonic, password: PASSWORD });
  while (wallet.accounts.length < COUNT) wallet = generateNewAccount(wallet);

  const accounts: AccountOut[] = wallet.accounts.slice(0, COUNT).map((a, i) => {
    const privateKey = a.stxPrivateKey;
    const publicKey = getPublicKeyFromPrivate(privateKey);
    return {
      index: i,
      privateKey,
      publicKey,
      testnetAddress: getAddressFromPrivateKey(privateKey, "testnet"),
      mainnetAddress: getAddressFromPrivateKey(privateKey, "mainnet"),
    };
  });

  // ---- print -----
  console.log("=".repeat(72));
  console.log(fresh ? "NEW WALLET (generated mnemonic)" : "RESTORED WALLET (from provided mnemonic)");
  console.log("=".repeat(72));
  console.log("Mnemonic:\n  " + mnemonic + "\n");

  for (const a of accounts) {
    console.log(`Account #${a.index}  (m/44'/5757'/0'/0/${a.index})`);
    console.log(`  Testnet:     ${a.testnetAddress}`);
    console.log(`  Mainnet:     ${a.mainnetAddress}`);
    console.log(`  Public key:  ${a.publicKey}`);
    console.log(`  Private key: ${a.privateKey}`);
    console.log("");
  }

  console.log("SECURITY: private keys + mnemonic above grant full control. Keep them secret.");

  if (OUTPUT) {
    writeFileSync(OUTPUT, JSON.stringify({ mnemonic, accounts }, null, 2));
    console.log(`\nSaved to ${OUTPUT} (keep this file private — it is git-ignored).`);
  }
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
