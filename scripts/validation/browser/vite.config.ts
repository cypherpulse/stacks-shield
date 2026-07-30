import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../..");
const PKG: Record<string, string> = {
  shield: "shield/target/shield_note.json",
  transfer: "transfer/target/transfer_note.json",
  split: "split/target/split_note.json",
  merge: "merge/target/merge_note.json",
  withdraw: "withdraw/target/withdraw_note.json",
  keygen: "keygen/target/keygen.json",
};

// COOP/COEP enable SharedArrayBuffer (WASM threads). All resources are served
// same-origin by Vite, so they are allowed under COEP require-corp.
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  root: __dirname,
  server: { headers },
  preview: { headers },
  // bb.js / noir must not be pre-bundled by esbuild (breaks their WASM loading).
  optimizeDeps: { exclude: ["@aztec/bb.js", "@noir-lang/noir_js"] },
  plugins: [
    {
      name: "serve-circuit-artifacts",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const m = req.url?.match(/^\/circuits\/(\w+)\.json/);
          if (m && PKG[m[1]!]) {
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
            res.end(readFileSync(`${REPO}/zk/circuits/${PKG[m[1]!]}`));
            return;
          }
          next();
        });
      },
    },
  ],
});
