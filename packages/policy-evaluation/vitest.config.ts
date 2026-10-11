import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Full-graph budget cases are CPU-bound. Keep their existing per-test deadlines while
    // avoiding competition between files; concurrency/cleanup races remain explicit in cases.
    fileParallelism: false,
    coverage: {
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: { branches: 90, functions: 95, lines: 95, statements: 95 },
    },
  },
});
