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
    // The @stx-shield/sdk workspace package is symlinked from ../sdk (outside the
    // frontend root); allow Vite's dev server to serve files from the repo root.
    fs: { allow: [".."] },
  },
  preview: { headers: crossOriginIsolation },
  // Pre-bundle the linked SDK so the dev server resolves it like any dependency.
  optimizeDeps: { include: ["@stx-shield/sdk", "@stx-shield/sdk/web"] },
  build: { target: "es2022", sourcemap: false },
});
