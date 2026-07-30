import { QueryClient } from "@tanstack/react-query";

/** Single shared QueryClient — imported by both the router context and providers. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});
