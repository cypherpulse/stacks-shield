import { useOperation } from "@/shared/hooks/useOperation";
import type { MergeResponse, ShieldNote } from "@/shared/types/shield";

export function useMerge() {
  return useOperation<{ notes: [ShieldNote, ShieldNote] }, MergeResponse>(
    "Merge",
    async (client, { notes }, setStep) => {
      setStep("proving");
      const promise = client.merge(notes);
      setStep("submitting");
      return await promise;
    },
  );
}
