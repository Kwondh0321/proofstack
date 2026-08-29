import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
    coverage: {
      // This adapter's SQL, RLS, deferred constraints, and rollback semantics are exercised by
      // the required real-PostgreSQL conformance suite rather than mocked-client unit tests.
      exclude: ["src/postgres-replay-definition-repository.ts"],
      include: ["src/**/*.ts"],
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
