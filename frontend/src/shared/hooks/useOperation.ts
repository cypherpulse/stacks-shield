import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { getShield } from "@/services/sdk/shield.service";
import { errorMessage } from "@/shared/utils/format";

export type OperationStep =
  "idle" | "preparing" | "proving" | "submitting" | "confirming" | "done" | "error";

export const STEP_LABEL: Record<OperationStep, string> = {
  idle: "Ready",
  preparing: "Preparing your request",
  proving: "Securing your transaction",
  submitting: "Submitting to the network",
  confirming: "Waiting for confirmation",
  done: "Complete",
  error: "Failed",
};

export const STEP_PROGRESS: Record<OperationStep, number> = {
  idle: 0,
  preparing: 12,
  proving: 45,
  submitting: 78,
  confirming: 92,
  done: 100,
  error: 100,
};

/**
 * Shared plumbing for every protocol operation: staged progress, toasts,
 * cache invalidation. The actual work always happens inside the SDK.
 */
export function useOperation<TVars, TResult>(
  name: string,
  run: (
    client: Awaited<ReturnType<typeof getShield>>,
    vars: TVars,
    setStep: (step: OperationStep) => void,
  ) => Promise<TResult>,
) {
  const [step, setStep] = useState<OperationStep>("idle");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (vars: TVars) => {
      setStep("preparing");
      const client = await getShield();
      return run(client, vars, setStep);
    },
    onSuccess: () => {
      setStep("done");
      toast.success(`${name} complete`);
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      queryClient.invalidateQueries({ queryKey: ["history"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (error) => {
      setStep("error");
      toast.error(`${name} failed`, { description: errorMessage(error) });
    },
  });

  return {
    ...mutation,
    step,
    progress: STEP_PROGRESS[step],
    stepLabel: STEP_LABEL[step],
    reset: () => {
      setStep("idle");
      mutation.reset();
    },
  };
}
