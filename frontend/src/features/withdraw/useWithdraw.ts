import { useOperation } from "@/shared/hooks/useOperation";
import type { ShieldNote, WithdrawResponse } from "@/shared/types/shield";

export function useWithdraw() {
  return useOperation<{ note: ShieldNote; recipient?: string }, WithdrawResponse>(
    "Withdraw",
    async (client, { note, recipient }, setStep) => {
      setStep("proving");
      const promise = recipient ? client.withdraw(note, recipient) : client.withdraw(note);
      setStep("submitting");
      return await promise;
    },
  );
}
