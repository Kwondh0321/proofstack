import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
    coverage: {
      // These adapters' SQL, RLS, deferred constraints, and rollback semantics are exercised by
      // required real-PostgreSQL conformance suites rather than mocked-client unit tests.
      exclude: [
        "src/postgres-evaluation-repository.ts",
        "src/postgres-replay-definition-repository.ts",
      ],
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
