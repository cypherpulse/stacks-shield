import { useMutation } from "@tanstack/react-query";

import { FAUCET_API_KEY, type FaucetAsset } from "@/shared/constants/protocol";

export interface FaucetResponse {
  txid?: string;
  message?: string;
  explorerUrl?: string;
}

export interface FaucetClaim {
  address: string;
  asset: FaucetAsset;
}

async function claim({ address, asset }: FaucetClaim): Promise<FaucetResponse> {
  const res = await fetch(asset.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": FAUCET_API_KEY },
    body: JSON.stringify({ address }),
  });

  // The Hermes backend returns { success, message, txId, explorerUrl } on success
  // and { error } on failure — normalize txId -> txid for the UI.
  const data = (await res.json().catch(() => ({}))) as {
    txid?: string;
    txId?: string;
    message?: string;
    error?: string;
    explorerUrl?: string;
  };
  if (!res.ok) {
    throw new Error(
      data.message || data.error || `Faucet request failed (${res.status}). Please try again later.`,
    );
  }
  return { txid: data.txid ?? data.txId, message: data.message, explorerUrl: data.explorerUrl };
}

export function useFaucet() {
  return useMutation<FaucetResponse, Error, FaucetClaim>({ mutationFn: claim });
}
