# STX Shield — SDK CLI test guide

Run the full private lifecycle (**shield → split → merge → withdraw → transfer**)
from Node using your own key, and **list / verify your notes directly from the
chain** (commitment registration + nullifier‑spent) instead of trusting the API.

The harness lives at [`sdk/examples/cli.ts`](sdk/examples/cli.ts). Your notes are
kept locally in `cli-notes.json` (the SDK's in‑memory store does not persist).
Amounts are decrypted locally and never leave your machine.

---

## 1. How "notes from chain" works here

The contract stores only **commitments, roots, and nullifiers** — never the
encrypted note payload (that lives in the API, so only you can read amounts).
So a fully trustless read means: *you* hold your notes, and for each one you ask
the chain two questions via `privacy-registry` read‑only calls:

| Question | Read‑only call | Meaning |
|---|---|---|
| Is this note on chain? | `is-commitment-registered(commitment)` | it was really shielded/created |
| Has it been spent? | `is-nullifier-spent(nullifier)` | `nullifier = Poseidon2(commitment, ownerSk)` |

`list` computes each note's nullifier locally from its secret and checks both —
**no API, no indexer** — then sums the unspent, registered notes into your
on‑chain balance. (`get-current-root` is also available if you want the live root.)

---

## 2. Prerequisites

- **Node ≥ 20** (for `--env-file`) and `pnpm`.
- **SDK built** and the **proving toolchain** available:
  ```bash
  pnpm --filter @stx-shield/sdk install
  pnpm --filter @stx-shield/sdk build
  ```
- **Compiled circuits** at `zk/circuits/*/target/*.json` (already in the repo).
- A **running relayer** — proofs are submitted through its `/submit` endpoint,
  and it broadcasts the relayed ops (split/merge/withdraw/transfer). It must be
  configured with a zkVerify seed (`.env.relayer`). Locally:
  ```bash
  pnpm --filter @stx-shield/relayer dev      # serves http://localhost:8787
  ```
- The **API reachable** (default: the hosted testnet API) so `connect()` can
  authenticate and register ciphertexts.
- A **testnet‑funded** Stacks account (for the `shield` STX transfer + gas).
  Get testnet STX from the Hiro faucet.

---

## 3. Configure your key

Create **`.env.cli`** in the repo root (this file is secret — do not commit it):

```dotenv
# Required — your testnet account private key (64-hex, or 66-hex compressed).
STX_PRIVATE_KEY=your_private_key_here

# Optional overrides (sensible testnet defaults shown).
STX_NETWORK=testnet
STX_API_URL=https://stx-shield-api.onrender.com
STX_RELAYER_URL=http://localhost:8787
STX_DEPLOYER=ST2HXRZ8A82JJAP14KD83JEXNRCF34J67088WJSJH
STX_HIRO_URL=https://api.testnet.hiro.so
STX_CIRCUITS_DIR=../zk/circuits
STX_NOTES_FILE=./cli-notes.json
```

> If your relayer is deployed, point `STX_RELAYER_URL` at it instead of
> localhost. `STX_RELAYER_URL` is used both to relay ops and (as
> `${STX_RELAYER_URL}/submit`) to submit proofs to zkVerify.

---

## 4. Run

All commands run from the `sdk` directory (so the self‑import resolves):

```bash
cd sdk
npx tsx --env-file=../.env.cli examples/cli.ts <command> [args]
```

### Commands

| Command | What it does |
|---|---|
| `address` | Print your Stacks address and your STX Shield address |
| `shield <stx>` | Shield `<stx>` STX into a new note (you sign + broadcast) |
| `list` | List your notes, each **verified against chain** + balance |
| `split <index> <a> <b>` | Split note `#index` into `a` + `b` STX |
| `merge <i> <j>` | Merge notes `#i` and `#j` into one |
| `withdraw <index> [recipient]` | Redeem note `#index` to a transparent address |
| `transfer <index> <shieldAddr>` | Send note `#index` privately to a shield address |

Indices come from `list`.

### A full lifecycle

```bash
cd sdk

# 0) Who am I?
npx tsx --env-file=../.env.cli examples/cli.ts address

# 1) Shield 5 STX  ->  one 5 STX note
npx tsx --env-file=../.env.cli examples/cli.ts shield 5

# 2) See it, verified on chain
npx tsx --env-file=../.env.cli examples/cli.ts list
#   #0  5 STX  0x6f3c67b1…  [unspent]
#   Spendable balance (on-chain, unspent): 5 STX

# 3) Split 5 -> 2 + 3   (the contract splits 1->2 per tx; re-split for more)
npx tsx --env-file=../.env.cli examples/cli.ts split 0 2 3

# 4) Split the 3 again -> 2 + 1   (list first to get the new index)
npx tsx --env-file=../.env.cli examples/cli.ts list
npx tsx --env-file=../.env.cli examples/cli.ts split 1 2 1

# 5) Merge two notes back together
npx tsx --env-file=../.env.cli examples/cli.ts merge 0 1

# 6) Withdraw a note to your wallet (or pass an ST… recipient)
npx tsx --env-file=../.env.cli examples/cli.ts withdraw 0

# 7) Transfer a note privately to someone's shield address
npx tsx --env-file=../.env.cli examples/cli.ts transfer 0 stxsh1abc…
```

After each op, `list` re‑checks every note against the chain, so a spent input
shows `[SPENT]` and drops out of the balance — proving the spend landed without
consulting the API.

---

## 5. Splitting into many amounts (e.g. 2 / 2 / 1)

`split` produces exactly two notes per transaction (the contract is 1→2). To get
N denominations, **split the results again**, waiting for each to confirm:

```bash
# 5 -> 2 + 3, then 3 -> 2 + 1  ==>  2, 2, 1
cli.ts split 0 2 3
cli.ts list                 # wait until the 3 STX note shows [unspent]
cli.ts split <its-index> 2 1
```

Each step is atomic and independently confirmed — if one fails you just retry
that one.

---

## 6. Things to know

- **This CLI has its own identity.** `getShieldSecret` derives a stable key from
  your private key, so the CLI shield address is **independent of your browser**
  shield address. It sees only notes it created. That is exactly what you want
  for a self‑contained lifecycle test. (To act on browser‑created notes you would
  have to reproduce the browser's signature‑based secret derivation.)
- **Amounts are local.** The chain never has them; `list` reads the value from
  your local `cli-notes.json` and only the *status* from chain.
- **`connect()` is best‑effort.** It authenticates so output ciphertexts get
  registered (needed for `transfer` and for browser discovery). Reading notes
  from chain does not require it — `list` works offline of the API.
- **First proof is slow.** The bb.js prover initializes on first use.
- **Keep `.env.cli` and `cli-notes.json` private.** The notes file holds spend
  secrets; anyone with it can spend those notes.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `STX_PRIVATE_KEY is not set` | Create `.env.cli` and pass `--env-file=../.env.cli` |
| `No zkVerify submission path configured` | Set `STX_RELAYER_URL`; ensure the relayer runs with a zkVerify seed |
| `broadcast failed …` on `shield` | Account not testnet‑funded, or a post‑condition/nonce issue — check the address has STX |
| `note commitment is not on chain yet` on split | The input note has not been indexed yet; run `list` until it shows `[unspent]` |
| `call-read … failed` in `list` | Wrong `STX_DEPLOYER`/`STX_HIRO_URL`, or Hiro rate‑limit — retry |
| `not authenticated to the API` warning | API unreachable; relayed ops still work, but `transfer` needs it |
