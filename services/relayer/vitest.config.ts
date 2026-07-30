import { defineConfig } from "vitest/config";

// Standalone config so the relayer tests do NOT inherit the repo-root Clarinet
// simnet setup. Single-fork pool avoids the environment's tinypool thread
// conflict.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true, minForks: 1, maxForks: 1 } },
  },
});
