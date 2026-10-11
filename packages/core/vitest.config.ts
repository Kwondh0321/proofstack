import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Isolate expensive boundary cases from other files while preserving their existing deadlines
    // and the explicit concurrent operations inside conformance/race tests.
    fileParallelism: false,
    coverage: {
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/testing/**"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 95,
        statements: 95,
      },
    },
  },
});
