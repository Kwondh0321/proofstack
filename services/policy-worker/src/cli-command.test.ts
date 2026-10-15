import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MemoryPolicyEvaluationJobRepository,
  policySnapshotRepositoryFixture,
} from "@proofstack/core/testing";
import { generateServiceToken, hashServiceTokenSecret } from "@proofstack/identity";
import { runPolicyWorkerCli } from "./cli-command.js";
import type { PolicyWorkerAttemptPorts } from "./attempt.js";
import type { createPostgresPolicyWorkerRuntime } from "./postgres-runtime.js";

const p = "PROOFSTACK_POLICY_WORKER_",
  token = generateServiceToken();
let root: string, path: string, hash: Awaited<ReturnType<typeof hashServiceTokenSecret>>;
let f: ReturnType<typeof policySnapshotRepositoryFixture>;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "proofstack-worker-command-"));
  await chmod(root, 0o700);
  path = join(root, "credentials.json");
  hash = await hashServiceTokenSecret(token.secret);
  f = policySnapshotRepositoryFixture();
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: "0.1",
      revision: "catalogue_command",
      credentials: [
        {
          kind: "service_token",
          credentialId: "credential_command",
          prefix: token.prefix,
          passwordHash: hash,
          principalId: f.workerId,
          tenantId: f.scope.tenantId,
          capabilities: ["policy:evaluation:execute", "artifact:read"],
          resourceScope: {
            mode: "restricted",
            projects: [{ projectId: f.scope.projectId, environmentIds: [f.scope.environmentId] }],
          },
          status: "active",
          notBefore: new Date(Date.now() - 60000).toISOString(),
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        },
      ],
    }),
    { mode: 0o600, flag: "wx" },
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
function environment(): NodeJS.ProcessEnv {
  return {
    PROOFSTACK_ENV: "test",
    [p + "SERVICE_TOKEN"]: token.value,
    [p + "CREDENTIALS_FILE"]: path,
    [p + "DATABASE_URL"]: "postgresql://proofstack_policy_evaluator@127.0.0.1/proofstack_test",
    [p + "S3_BUCKET"]: "command-fixture",
    [p + "S3_REGION"]: "us-east-1",
    [p + "S3_ACCESS_KEY_ID"]: "test-command-access",
    [p + "S3_SECRET_ACCESS_KEY"]: "test-command-secret",
    [p + "KEYRING_ACTIVE_KEY_ID"]: "key_command",
    [p + "KEYRING_KEYS"]: JSON.stringify({
      key_command: Buffer.alloc(32, 51).toString("base64url"),
    }),
  };
}
async function fixture() {
  const time = { now: f.request.createdAt };
  const repository = new MemoryPolicyEvaluationJobRepository({ now: () => time.now });
  await repository.createJob({ request: f.request, jobId: f.jobId });
  const ports: PolicyWorkerAttemptPorts = {
    worker: repository,
    snapshots: repository,
    results: repository,
    async seal({ fence, principal }) {
      time.now = f.publicationAt;
      return repository.publishSnapshot({
        scope: f.scope,
        fence,
        pageSet: f.pageSet,
        principalId: principal.principalId,
      });
    },
    close: vi.fn(async () => {}),
  };
  const createRuntime = vi.fn<typeof createPostgresPolicyWorkerRuntime>().mockResolvedValue(ports),
    writeOutput = vi.fn(),
    writeError = vi.fn();
  const dependencies = { environment: environment(), createRuntime, writeOutput, writeError };
  const args = ["execute", f.scope.projectId, f.scope.environmentId, f.jobId];
  return {
    repository,
    time,
    ports,
    dependencies,
    args,
    createRuntime,
    writeOutput,
    writeError,
    run: () => runPolicyWorkerCli(args, dependencies),
  };
}
describe("finite separately authenticated policy worker command", () => {
  it.each([
    { args: [] },
    { args: ["execute"] },
    { args: ["other", "project", "environment", "job"] },
    { args: ["execute", "project", "environment", "job", "extra"] },
  ])(
    "refuses unsupported argument shapes without credentials or execution %#",
    async ({ args }) => {
      const execute = vi.fn(),
        writeError = vi.fn();
      expect(await runPolicyWorkerCli(args, { environment: {}, execute, writeError })).toBe(64);
      expect(execute).not.toHaveBeenCalled();
      expect(writeError.mock.calls[0]![0]).toContain("Usage:");
    },
  );
  it("authenticates the actual file/secret and completes the real memory state machine before bounded output", async () => {
    const h = await fixture();
    expect(await h.run()).toBe(0);
    expect(h.ports.close).toHaveBeenCalledOnce();
    expect(h.writeError).not.toHaveBeenCalled();
    const output = h.writeOutput.mock.calls[0]![0] as string,
      receipt = JSON.parse(output);
    expect(Buffer.byteLength(output)).toBeLessThan(4096);
    expect(output).not.toContain(token.value);
    expect(output).not.toContain(hash.digest);
    expect(output).not.toContain("test-command-secret");
    expect(receipt).toMatchObject({
      schemaVersion: "0.1",
      disposition: "completed",
      scope: f.scope,
      job: { jobId: f.jobId, status: "completed" },
    });
    expect(receipt.ruleOutcomes.indeterminate).toBeGreaterThan(0);
    expect(Object.keys(receipt.ruleOutcomes).sort()).toEqual([
      "indeterminate",
      "not_applicable",
      "satisfied",
      "violated",
    ]);
    const job = await h.repository.findJob(f.scope, f.jobId);
    expect(receipt.result).toEqual(job!.job.result);
    expect(receipt.snapshot).toEqual(job!.job.snapshot);
  });
  it("retains original result and fees on a second finite invocation", async () => {
    const h = await fixture();
    expect(await h.run()).toBe(0);
    const original = await h.repository.findJob(f.scope, f.jobId);
    expect(await h.run()).toBe(0);
    expect(await h.repository.findJob(f.scope, f.jobId)).toEqual(original);
    expect(JSON.parse(h.writeOutput.mock.calls[1]![0]).disposition).toBe("observed_terminal");
  });
  it("defers a healthy existing lease without treating it as operational completion", async () => {
    const h = await fixture();
    await h.repository.claimJob({
      scope: f.scope,
      jobId: f.jobId,
      workerId: "worker_other",
      attemptId: "attempt_other",
      leaseId: "lease_other",
    });
    expect(await h.run()).toBe(2);
    const receipt = JSON.parse(h.writeOutput.mock.calls[0]![0]);
    expect(receipt.disposition).toBe("deferred");
    expect(receipt.ruleOutcomes).toBeNull();
    expect(receipt.result).toBeNull();
  });
  it("observes cancellation with nonzero status and no invented rule outcomes", async () => {
    const h = await fixture();
    await h.repository.cancelJob({
      scope: f.scope,
      jobId: f.jobId,
      cancellationId: "cancel_command",
      principalId: "controller_command",
      reason: "operator_requested",
    });
    expect(await h.run()).toBe(2);
    expect(JSON.parse(h.writeOutput.mock.calls[0]![0])).toMatchObject({
      disposition: "observed_terminal",
      job: { status: "cancelled" },
      ruleOutcomes: null,
    });
  });
  it("denies a wrong actual secret before malformed delivery or database configuration", async () => {
    const h = await fixture();
    h.dependencies.environment[p + "SERVICE_TOKEN"] =
      `pss_v1_${token.prefix}_${generateServiceToken().secret}`;
    delete h.dependencies.environment[p + "DATABASE_URL"];
    h.args[1] = token.value;
    expect(await h.run()).toBe(1);
    expect(h.createRuntime).not.toHaveBeenCalled();
    expect(h.writeOutput).not.toHaveBeenCalled();
    expect(h.writeError.mock.calls[0]![0]).not.toContain(token.value);
  });
  it("does not replace missing service authentication with ambient credentials", async () => {
    const h = await fixture();
    delete h.dependencies.environment[p + "SERVICE_TOKEN"];
    expect(await h.run()).toBe(1);
    expect(h.createRuntime).not.toHaveBeenCalled();
  });
  it("returns a safe failure when authenticated runtime configuration is invalid", async () => {
    const h = await fixture();
    h.dependencies.environment["PROOFSTACK_ENV"] = "production";
    expect(await h.run()).toBe(1);
    expect(h.createRuntime).not.toHaveBeenCalled();
    expect(h.writeOutput).not.toHaveBeenCalled();
  });
  it("installs actual bounded object resources after authentication and explicit role configuration", async () => {
    const h = await fixture();
    h.dependencies.environment[p + "DATABASE_ROLE"] = "custom_policy_worker";
    h.createRuntime.mockImplementation(async (_input, options) => {
      expect(options.databaseRole).toBe("custom_policy_worker");
      const resources = await options.openArtifacts();
      expect(Object.keys(resources.reader)).toEqual(["get"]);
      await resources.close();
      return h.ports;
    });
    expect(await h.run()).toBe(0);
  });
  it("reports idle-pool errors without leaking causes or fabricating command success", async () => {
    const h = await fixture();
    h.createRuntime.mockImplementation(async (_input, options) => {
      options.onIdleError(new Error(token.value));
      return h.ports;
    });
    expect(await h.run()).toBe(1);
    expect(h.writeOutput).not.toHaveBeenCalled();
    expect(h.writeError.mock.calls[0]![0]).not.toContain(token.value);
    expect(h.ports.close).toHaveBeenCalledOnce();
  });
  it("does not report successful output if owning cleanup fails", async () => {
    const h = await fixture();
    vi.mocked(h.ports.close).mockRejectedValue(new Error(token.value));
    expect(await h.run()).toBe(1);
    expect(h.writeOutput).not.toHaveBeenCalled();
    expect(h.writeError.mock.calls[0]![0]).not.toContain(token.value);
  });
  it("uses the real default native factory and fails safely on invalid role configuration", async () => {
    const h = await fixture();
    h.dependencies.environment[p + "DATABASE_ROLE"] = "not-valid";
    expect(
      await runPolicyWorkerCli(h.args, {
        environment: h.dependencies.environment,
        writeError: h.writeError,
        writeOutput: h.writeOutput,
      }),
    ).toBe(1);
    expect(h.writeOutput).not.toHaveBeenCalled();
  });
  it("writes default output channels without printing token material", async () => {
    const h = await fixture(),
      stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true),
      stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(
        await runPolicyWorkerCli(h.args, {
          environment: h.dependencies.environment,
          createRuntime: h.createRuntime,
        }),
      ).toBe(0);
      expect(stdout).toHaveBeenCalled();
      expect(await runPolicyWorkerCli([])).toBe(64);
      expect(stderr).toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
