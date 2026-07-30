import { defineConfig } from "tsup";

// Dual ESM + CJS build with type declarations and tree-shaking. The Node-only
// proof engine (child_process) is loaded via dynamic import at runtime, so it
// never lands in a browser bundle.
export default defineConfig({
  entry: { index: "src/index.ts", node: "src/node.ts", web: "src/web.ts" },
  format: ["esm", "cjs"],
  // Never bundle the heavy provers/verifiers. They are optional peer deps and
  // must load from their own package so bb.js can locate its WASM assets.
  external: ["@aztec/bb.js", "@noir-lang/noir_js", "zkverifyjs", "@stacks/connect"],
  dts: true,
  treeshake: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  outDir: "dist",
  target: "es2022",
  outExtension({ format }) {
    return { js: format === "esm" ? ".js" : ".cjs" };
  },
});
