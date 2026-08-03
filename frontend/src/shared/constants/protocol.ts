export const MICRO_PER_STX = 1_000_000;

export const NETWORK = "testnet" as const;

export const API_URL = import.meta.env.VITE_API_URL ?? "https://stx-shield-api.onrender.com";
export const RELAYER_URL =
  import.meta.env.VITE_RELAYER_URL ?? "https://stx-shield-relayer.onrender.com";
// The zkVerify submitter is the relayer's POST /submit endpoint. Defaults to the
// relayer so proofs are submitted through it (browsers never hold a zkVerify seed).
export const ZKVERIFY_URL = import.meta.env.VITE_ZKVERIFY_URL ?? RELAYER_URL;

export const DEPLOYER = "ST2HXRZ8A82JJAP14KD83JEXNRCF34J67088WJSJH";

export const MIN_SHIELD_STX = 1;
export const WITHDRAW_FEE_RATE = 0.003; // ~0.3% protocol withdraw fee

// Testnet faucet (Hermes). The key ships in the client bundle, so it gates
// casual use, not abuse — front a server proxy if the faucet must be protected.
export const FAUCET_URL =
  import.meta.env.VITE_FAUCET_URL ?? "https://hermes-faucet-backend.onrender.com/api/claim-stx";
export const FAUCET_API_KEY = import.meta.env.VITE_FAUCET_API_KEY ?? "hermes_faucet_secret_2026";
export const FAUCET_AMOUNT_STX = 210;

export const EXPLORER_TX = (txid: string) => `https://explorer.hiro.so/txid/${txid}?chain=testnet`;

export const LINKS = {
  docs: "https://docs.stacks.co",
  github: "https://github.com/stx-shield",
};

export const SHIELD_SECRET_MSG = "STX Shield — derive my private note key (v1)";
