import { useOperation } from "@/shared/hooks/useOperation";
import type { AssetRef, OperationResponse } from "@/shared/types/shield";

export function useTransfer() {
  return useOperation<{ amount: number; recipient: string; asset?: AssetRef }, OperationResponse>(
    "Transfer",
    async (client, { amount, recipient, asset }, setStep) => {
      setStep("proving");
      const promise = client.transfer(amount, recipient, asset);
      setStep("submitting");
      return await promise;
    },
  );
}
