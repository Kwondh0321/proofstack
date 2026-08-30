import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
    coverage: {
      exclude: ["src/**/*.test.ts"],
      include: ["src/definitions.ts", "src/target-source.ts", "src/worker-input.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 85,
        functions: 85,
        lines: 95,
        statements: 95,
      },
    },
  },
});
