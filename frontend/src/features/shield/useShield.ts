import { useOperation } from "@/shared/hooks/useOperation";
import type { AssetRef, ShieldResponse } from "@/shared/types/shield";

export function useShield() {
  return useOperation<{ amount: number; asset?: AssetRef }, ShieldResponse>(
    "Shield",
    async (client, { amount, asset }, setStep) => {
      setStep("proving");
      const promise = client.shield(amount, asset);
      setStep("submitting");
      const res = await promise;
      setStep("confirming");
      return res;
    },
  );
}
