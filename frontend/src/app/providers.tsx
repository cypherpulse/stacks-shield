import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";

import { queryClient } from "@/lib/query-client";
import { Toaster } from "@/shared/components/ui/sonner";
import { useWallet } from "@/features/wallet/useWallet";
import { useThemeStore } from "@/store/theme";

// ---- theme -----------------------------------------------------------------
function ThemeBootstrap({ children }: { children: ReactNode }) {
  const init = useThemeStore((s) => s.init);
  useEffect(() => init(), [init]);
  return <>{children}</>;
}

// ---- wallet ----------------------------------------------------------------
function WalletBootstrap({ children }: { children: ReactNode }) {
  useWallet(); // restores any persisted session exactly once
  return <>{children}</>;
}

// ---- root providers --------------------------------------------------------
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeBootstrap>
        <WalletBootstrap>
          {children}
          <Toaster position="top-right" richColors closeButton />
        </WalletBootstrap>
      </ThemeBootstrap>
    </QueryClientProvider>
  );
}
