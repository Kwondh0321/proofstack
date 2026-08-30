import { describe, expect, it } from "vitest";
import { type RunDurableReplayExampleOptions, runDurableReplayExample } from "./workflow.js";

const options: RunDurableReplayExampleOptions = {
  apiUrl: "http://127.0.0.1:4318",
  environmentId: "env_durable_test",
  outputRoot: "/tmp/proofstack-durable-validation-only",
  projectId: "prj_durable_test",
  sourceRevision: "a".repeat(40),
  tenantId: "ten_local",
  workerDatabaseUrl: "postgresql://worker:private-password@127.0.0.1:5432/proofstack",
  workerEntryPointPath: "/tmp/proofstack-durable-validation-only/worker.js",
};

describe("durable replay workflow input boundary", () => {
  it.each([
    [{ tenantId: "ten_other" }, "tenant ten_local"],
    [{ sourceRevision: "main" }, "exact Git object identifier"],
    [{ workerEntryPointPath: "worker.js" }, "absolute"],
    [{ workerEntryPointPath: "/tmp/worker\0.js" }, "absolute"],
    [{ outputRoot: "output" }, "absolute"],
    [{ outputRoot: "/tmp/output\0" }, "absolute"],
  ])(
    "rejects invalid operator input before local or remote mutation %#",
    async (override, message) => {
      await expect(runDurableReplayExample({ ...options, ...override })).rejects.toThrow(message);
    },
  );
});
