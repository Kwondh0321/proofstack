import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    exclude: ["src/**/*.integration.test.ts", "node_modules/**"],
    fileParallelism: false,
    coverage: {
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/test-support.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
});
