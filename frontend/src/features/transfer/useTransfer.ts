import { useOperation } from "@/shared/hooks/useOperation";
import type { OperationResponse } from "@/shared/types/shield";

export function useTransfer() {
  return useOperation<{ amount: number; recipient: string }, OperationResponse>(
    "Transfer",
    async (client, { amount, recipient }, setStep) => {
      setStep("proving");
      const promise = client.transfer(amount, recipient);
      setStep("submitting");
      return await promise;
    },
  );
}
