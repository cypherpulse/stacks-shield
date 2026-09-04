import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Cross-origin isolation (COOP/COEP) is required for the SDK's WASM proving
// threads (@aztec/bb.js). Without these headers the web engine falls back to
// single-threaded proving.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react(), tailwindcss(), tsconfigPaths()],
  // Force a single instance of React and the router so React context (e.g. the
  // sidebar provider) is never split across duplicate copies under pnpm.
  resolve: {
    dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-query"],
  },
  server: {
    headers: crossOriginIsolation,
    // pnpm hoists deps to the monorepo-root store; let the dev server read it.
    fs: { allow: [".."] },
  },
  preview: { headers: crossOriginIsolation },
  // Pre-bundle the published SDK (installed from npm) so the dev server resolves
  // its ESM cleanly.
  optimizeDeps: { include: ["@stacks-shield/sdk", "@stacks-shield/sdk/web"] },
  build: { target: "es2022", sourcemap: false },
});
