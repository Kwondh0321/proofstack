import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
    coverage: {
      exclude: ["src/**/*.test.ts", "src/run.ts", "src/workflow.ts"],
      include: ["src/scenario.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 90,
        functions: 100,
        lines: 95,
        statements: 95,
      },
    },
  },
});
