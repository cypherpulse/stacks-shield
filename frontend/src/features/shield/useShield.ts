import { useOperation } from "@/shared/hooks/useOperation";
import type { ShieldResponse } from "@/shared/types/shield";

export function useShield() {
  return useOperation<{ amount: number }, ShieldResponse>(
    "Shield",
    async (client, { amount }, setStep) => {
      setStep("proving");
      const promise = client.shield(amount);
      setStep("submitting");
      const res = await promise;
      setStep("confirming");
      return res;
    },
  );
}
