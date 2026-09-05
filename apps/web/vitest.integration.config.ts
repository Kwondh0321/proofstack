import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lib/**/*.integration.test.ts"],
  },
});
