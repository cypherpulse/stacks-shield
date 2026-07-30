import { useOperation } from "@/shared/hooks/useOperation";
import type { ShieldNote, SplitResponse } from "@/shared/types/shield";

export function useSplit() {
  return useOperation<{ note: ShieldNote; amounts: [number, number] }, SplitResponse>(
    "Split",
    async (client, { note, amounts }, setStep) => {
      setStep("proving");
      const promise = client.split(note, amounts);
      setStep("submitting");
      return await promise;
    },
  );
}
