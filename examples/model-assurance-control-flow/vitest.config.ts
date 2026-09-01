import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
    coverage: {
      exclude: ["src/**/*.test.ts", "src/workflow.ts"],
      include: ["src/scenario.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
});
