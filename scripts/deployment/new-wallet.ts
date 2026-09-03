// =============================================================================
// new-wallet.ts -- generate the fresh v2 deployer wallet
// =============================================================================
//   npx tsx scripts/deployment/new-wallet.ts
//
// Generates a brand-new 24-word Stacks wallet for the v2 relaunch and prints its
// testnet address. The mnemonic is a SECRET: it is shown once, on your terminal
// only. Paste both values into .env.v2.deploy:
//   NEW_DEPLOYER_MNEMONIC="<the 24 words>"
//   NEW_DEPLOYER_ADDRESS=<the ST... address>
//
// If .env.v2.deploy does not exist yet, this copies .env.v2.deploy.example to it
// and fills in the two wallet lines for you (every other value stays blank for
// you to fill). It NEVER overwrites an existing .env.v2.deploy.
//
// After this: fund the address from the testnet faucet, then follow the runbook.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateSecretKey, generateWallet, getStxAddress } from "@stacks/wallet-sdk";

const ENV_FILE = ".env.v2.deploy";
const EXAMPLE = ".env.v2.deploy.example";

async function main(): Promise<void> {
  const mnemonic = generateSecretKey(256); // 24 words
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  const account = wallet.accounts[0];
  if (!account) throw new Error("failed to derive an account");
  const address = getStxAddress({ account, network: "testnet" });

  let wroteFile = false;
  if (!existsSync(ENV_FILE) && existsSync(EXAMPLE)) {
    const filled = readFileSync(EXAMPLE, "utf8")
      .replace(/^NEW_DEPLOYER_MNEMONIC=.*$/m, `NEW_DEPLOYER_MNEMONIC="${mnemonic}"`)
      .replace(/^NEW_DEPLOYER_ADDRESS=.*$/m, `NEW_DEPLOYER_ADDRESS=${address}`);
    writeFileSync(ENV_FILE, filled, { mode: 0o600 });
    wroteFile = true;
  }

  console.log("=".repeat(70));
  console.log("NEW v2 DEPLOYER WALLET (testnet)");
  console.log("=".repeat(70));
  console.log(`Address : ${address}`);
  console.log(`Mnemonic: ${mnemonic}`);
  console.log("=".repeat(70));
  if (wroteFile) {
    console.log(`Wrote ${ENV_FILE} with the wallet filled in (mode 600).`);
    console.log("Fill in the remaining values (vkeys, assets, zkVerify) before deploying.");
  } else if (existsSync(ENV_FILE)) {
    console.log(`${ENV_FILE} already exists -- NOT modified. Paste the two lines above into it:`);
    console.log(`  NEW_DEPLOYER_MNEMONIC="${mnemonic}"`);
    console.log(`  NEW_DEPLOYER_ADDRESS=${address}`);
  }
  console.log(
    `\nNext: fund ${address} from the testnet faucet:\n` +
      "  https://explorer.hiro.so/sandbox/faucet?chain=testnet\n" +
      "SAVE THE MNEMONIC SECURELY. It is shown only once and never logged elsewhere.",
  );
}

main().catch((e) => {
  console.error("wallet generation failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
