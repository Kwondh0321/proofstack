import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real HTTP routes exercise the complete comparison graph and can exceed Vitest's
    // five-second default when the CI runner executes the monorepo suites concurrently.
    testTimeout: 30_000,
    coverage: {
      exclude: ["src/**/*.test.ts", "src/run.ts"],
      include: [
        "src/adversarial-scenario.ts",
        "src/scenario.ts",
        "src/service.ts",
        "src/templates.ts",
        "src/workflow.ts",
      ],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 85,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
