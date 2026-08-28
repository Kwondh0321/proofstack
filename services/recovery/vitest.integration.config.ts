import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 120_000,
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 120_000,
  },
});
