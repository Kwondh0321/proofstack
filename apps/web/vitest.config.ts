import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["lib/**/*.integration.test.ts"],
    include: ["lib/**/*.test.ts"],
    coverage: {
      exclude: ["**/*.test.ts", "next-env.d.ts"],
      include: ["lib/**/*.ts"],
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
