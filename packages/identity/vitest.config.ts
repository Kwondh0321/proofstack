import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep expensive complete-inventory cases isolated from other files. Their deadlines,
    // admission limits and explicit concurrent operations remain unchanged.
    fileParallelism: false,
    coverage: {
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
});
