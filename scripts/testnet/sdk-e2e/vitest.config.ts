import { defineConfig } from "vitest/config";

// Single-fork pool avoids the environment's tinypool thread conflict.
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { singleFork: true, minForks: 1, maxForks: 1 } },
    include: ["*.test.ts"],
  },
});
