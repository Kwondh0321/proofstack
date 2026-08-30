import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000,
  },
});
