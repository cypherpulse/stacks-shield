import { useMutation } from "@tanstack/react-query";

import { FAUCET_API_KEY, FAUCET_URL } from "@/shared/constants/protocol";

export interface FaucetResponse {
  txid?: string;
  message?: string;
}

async function claimStx(address: string): Promise<FaucetResponse> {
  const res = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": FAUCET_API_KEY },
    body: JSON.stringify({ address }),
  });

  const data = (await res.json().catch(() => ({}))) as FaucetResponse & { error?: string };
  if (!res.ok) {
    throw new Error(
      data.message || data.error || `Faucet request failed (${res.status}). Please try again later.`,
    );
  }
  return data;
}

export function useFaucet() {
  return useMutation<FaucetResponse, Error, string>({ mutationFn: claimStx });
}
