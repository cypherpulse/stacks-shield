// =============================================================================
// Fund .env.users wallets + a dedicated relayer-service account from wallet_4
// =============================================================================
//   npx tsx scripts/testnet/fund-users.ts
// Sends 1000 STX to Alice/Bob/Carol and 200 STX to the relayer service account
// (generated + persisted to .env.svc). Prints the relayer service credentials.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateSecretKey, generateWallet, getStxAddress } from "@stacks/wallet-sdk";
import { broadcastTransaction, makeSTXTokenTransfer } from "@stacks/transactions";

const API = "https://api.testnet.hiro.so";
const ONE = 1_000_000n;

const signer = async (m: string) => {
  const w = await generateWallet({ secretKey: m, password: "" });
  const a = w.accounts[0]!;
  return { key: a.stxPrivateKey, address: getStxAddress({ account: a, network: "testnet" }), mnemonic: m };
};
const tomlMnemonic = (file: string, acct: string) =>
  readFileSync(file, "utf8").match(new RegExp(`\\[accounts\\.${acct}\\][\\s\\S]*?mnemonic\\s*=\\s*"([^"]+)"`))![1]!;
const envUser = (name: string) => readFileSync(".env.users", "utf8").match(new RegExp(`${name}_MNEMONIC=(.+)`))![1]!.trim();
const stxBalance = async (a: string): Promise<bigint> => {
  const r = await fetch(`${API}/extended/v1/address/${a}/balances`);
  return r.ok ? BigInt(((await r.json()) as any).stx.balance) : 0n;
};
const waitTx = async (txid: string, label: string) => {
  const dl = Date.now() + 900_000;
  while (Date.now() < dl) {
    const r = await fetch(`${API}/extended/v1/tx/${txid}`);
    if (r.ok) {
      const b = (await r.json()) as any;
      if (b.tx_status === "success") return;
      if (b.tx_status.startsWith("abort")) throw new Error(`${label} aborted ${txid}`);
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error(`${label} not confirmed ${txid}`);
};

const main = async () => {
  const funder = await signer(tomlMnemonic("settings/Devnet.toml", "wallet_4"));
  console.log("funder wallet_4:", funder.address, "balance", Number(await stxBalance(funder.address)) / 1e6, "STX");

  // Load or create the dedicated relayer service account (persisted, gitignored).
  let svcMnemonic: string;
  if (existsSync(".env.svc")) {
    svcMnemonic = readFileSync(".env.svc", "utf8").match(/RELAYER_SVC_MNEMONIC=(.+)/)![1]!.trim();
  } else {
    svcMnemonic = generateSecretKey(256);
  }
  const svc = await signer(svcMnemonic);
  if (!existsSync(".env.svc")) {
    writeFileSync(".env.svc", `RELAYER_SVC_MNEMONIC=${svcMnemonic}\nRELAYER_SVC_KEY=${svc.key}\nRELAYER_SVC_ADDRESS=${svc.address}\n`);
  }

  const targets: Array<{ name: string; address: string; amount: bigint }> = [
    { name: "ALICE", address: (await signer(envUser("ALICE"))).address, amount: 1000n * ONE },
    { name: "BOB", address: (await signer(envUser("BOB"))).address, amount: 1000n * ONE },
    { name: "CAROL", address: (await signer(envUser("CAROL"))).address, amount: 1000n * ONE },
    { name: "RELAYER_SVC", address: svc.address, amount: 200n * ONE },
  ];

  let nonce = BigInt(((await (await fetch(`${API}/extended/v1/address/${funder.address}/nonces`)).json()) as any).possible_next_nonce);
  const pending: Array<{ name: string; txid: string }> = [];
  for (const t of targets) {
    const tx = await makeSTXTokenTransfer({
      recipient: t.address, amount: t.amount, senderKey: funder.key, network: "testnet", fee: 3000n, nonce,
    });
    const r = await broadcastTransaction({ transaction: tx, network: "testnet" });
    const txid = (r as any).txid;
    if (!txid) throw new Error(`${t.name} fund broadcast failed: ${JSON.stringify(r)}`);
    console.log(`  -> ${t.name} ${t.address}: ${Number(t.amount) / 1e6} STX  tx ${txid}`);
    pending.push({ name: t.name, txid });
    nonce += 1n;
  }

  console.log("waiting for confirmations...");
  for (const p of pending) await waitTx(p.txid, p.name);

  console.log("\nfunded balances:");
  for (const t of targets) console.log(`  ${t.name} ${t.address}: ${Number(await stxBalance(t.address)) / 1e6} STX`);
  console.log("\nrelayer service account:");
  console.log("  RELAYER_ADDRESS =", svc.address);
  console.log("  (key persisted in .env.svc)");
};

main().catch((e) => { console.error("fund failed:", e instanceof Error ? e.message : e); process.exit(1); });
