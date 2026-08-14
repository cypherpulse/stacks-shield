import { defineConfig } from "vitest/config";

// Single-fork pool avoids the environment's tinypool thread min/max conflict
// (matches services/api and services/relayer).
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { singleFork: true, minForks: 1, maxForks: 1 } },
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
