import assert from "node:assert/strict";
import { test } from "node:test";
import { collectWorkflowAcceptanceDiagnostics } from "./workflow-acceptance-diagnostics.mjs";

function context() {
  return {
    composeFile: "/test/proofstack/compose.yaml",
    environment: { COMPOSE_DISABLE_ENV_FILE: "true", PROOFSTACK_POSTGRES_PORT: "12345" },
    projectName: "proofstack-workflow-2-candidate-isolated",
  };
}

test("collects bounded status and service logs only from the exact disposable project", async () => {
  const target = context();
  const before = structuredClone(target);
  const calls = [];
  const failures = await collectWorkflowAcceptanceDiagnostics(async (...arguments_) => {
    calls.push(arguments_);
  }, target);
  const prefix = [
    "compose",
    "--file",
    target.composeFile,
    "--project-name",
    target.projectName,
    "--profile",
    "object-storage",
  ];
  assert.deepEqual(failures, []);
  assert.deepEqual(calls, [
    [
      "docker",
      [...prefix, "ps", "--all"],
      { env: target.environment, timeout: 10_000, killSignal: "SIGKILL" },
    ],
    [
      "docker",
      [...prefix, "logs", "--no-color", "--tail", "160", "postgres", "seaweedfs"],
      { env: target.environment, timeout: 10_000, killSignal: "SIGKILL" },
    ],
  ]);
  assert.deepEqual(target, before);
});

test("still collects logs after the status command fails", async () => {
  const calls = [];
  const failures = await collectWorkflowAcceptanceDiagnostics(async (_command, arguments_) => {
    calls.push(arguments_);
    if (arguments_.includes("ps")) throw new Error("status unavailable");
  }, context());
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("logs"));
  assert.deepEqual(failures, [{ kind: "status", message: "status unavailable" }]);
});

test("returns log failures rather than throwing diagnostic errors", async () => {
  const failures = await collectWorkflowAcceptanceDiagnostics(async (_command, arguments_) => {
    if (arguments_.includes("logs")) throw new Error("logs unavailable");
  }, context());
  assert.deepEqual(failures, [{ kind: "logs", message: "logs unavailable" }]);
});

test("contains both diagnostic failures, including non-Error rejections", async () => {
  const failures = await collectWorkflowAcceptanceDiagnostics(async (_command, arguments_) => {
    if (arguments_.includes("ps")) throw new Error("status unavailable");
    throw "logs unavailable";
  }, context());
  assert.deepEqual(failures, [
    { kind: "status", message: "status unavailable" },
    { kind: "logs", message: "logs unavailable" },
  ]);
});
