import { describe, expect, it, vi } from "vitest";
import { PrincipalContextSchema, type PrincipalContext } from "@proofstack/contracts";
import { ForbiddenError } from "../errors.js";
import { MemoryPolicyEvaluationJobRepository } from "../testing/memory-policy-evaluation-job-repository.js";
import { policyJobConformanceRequest } from "../testing/policy-evaluation-job-repository-conformance.js";
import {
  enqueuePolicyEvaluationJob,
  readPolicyEvaluationJob,
  cancelPolicyEvaluationJobRequest,
  claimPolicyEvaluationJobRequest,
  mutatePolicyEvaluationWorkerJob,
  readPolicyEvaluationJobHistoryHead,
  readPolicyEvaluationJobHistoryPage,
  PolicyEvaluationCancellationConflictError,
} from "./policy-evaluation-job-use-cases.js";
import { PolicyEvaluationJobHistoryError } from "./policy-evaluation-job-history.js";
import { InvalidPolicyEvaluationJobGraphError } from "./policy-evaluation-job-record-validation.js";

const request = policyJobConformanceRequest();
const scope = request.scope;
function principal(
  capabilities: PrincipalContext["capabilities"],
  overrides: Partial<PrincipalContext> = {},
) {
  return PrincipalContextSchema.parse({
    principalId: "principal_controller",
    principalType: "service",
    tenantId: scope.tenantId,
    authentication: {
      method: "service_token",
      credentialId: "credential_test",
      authenticatedAt: request.createdAt,
    },
    capabilities,
    roles: ["member"],
    requestId: "request_test",
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: scope.projectId, environmentIds: [scope.environmentId] }],
    },
    ...overrides,
  });
}
function route(capabilities: PrincipalContext["capabilities"]) {
  return {
    principal: principal(capabilities),
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}
function definition() {
  const {
    createdAt: _at,
    createdByPrincipalId: _by,
    scope: _scope,
    schemaVersion: _version,
    definitionSha256: _hash,
    ...result
  } = request;
  return result;
}
function harness() {
  let now = request.createdAt;
  const repository = new MemoryPolicyEvaluationJobRepository({ now: () => now });
  return {
    repository,
    clock: { now: () => new Date(now) },
    newJobId: () => "job_usecase",
    setTime: (value: string) => {
      now = value;
    },
  };
}
describe("authorization-first policy job use cases", () => {
  it.each(["head", "page"])(
    "denies history %s before parsing untrusted head or touching the repository",
    async (kind) => {
      const h = harness();
      const calls = [
        vi.spyOn(h.repository, "findHistoryHead"),
        vi.spyOn(h.repository, "readHistoryPage"),
      ];
      const command = { ...route([]), jobId: "!", head: null, pageIndex: Number.NaN };
      const pending =
        kind === "head"
          ? readPolicyEvaluationJobHistoryHead(command, h.repository)
          : readPolicyEvaluationJobHistoryPage(command, h.repository);
      await expect(pending).rejects.toThrow(ForbiddenError);
      for (const call of calls) expect(call).not.toHaveBeenCalled();
    },
  );
  it("reads an original history head and rejects caller scope overrides before lookup", async () => {
    const h = harness();
    await enqueuePolicyEvaluationJob({ ...route(["policy:evaluate"]), input: definition() }, h);
    const command = { ...route(["policy:read"]), jobId: "job_usecase" };
    const head = (await readPolicyEvaluationJobHistoryHead(command, h.repository))!;
    const page = await readPolicyEvaluationJobHistoryPage(
      { ...command, head, pageIndex: 0 },
      h.repository,
    );
    expect(page.entries[0]!.definition.operation.kind).toBe("created");
    expect(
      await readPolicyEvaluationJobHistoryHead({ ...command, jobId: "job_absent" }, h.repository),
    ).toBeNull();
    const spy = vi.spyOn(h.repository, "readHistoryPage");
    await expect(
      readPolicyEvaluationJobHistoryPage(
        {
          ...command,
          head: { ...head, scope: { ...head.scope, tenantId: "tenant_outside" } },
          pageIndex: 0,
        },
        h.repository,
      ),
    ).rejects.toThrow(ForbiddenError);
    expect(spy).not.toHaveBeenCalled();
  });
  it("rejects substituted history query identity and page index", async () => {
    const h = harness();
    await enqueuePolicyEvaluationJob({ ...route(["policy:evaluate"]), input: definition() }, h);
    const command = { ...route(["policy:read"]), jobId: "job_usecase" };
    const head = (await readPolicyEvaluationJobHistoryHead(command, h.repository))!;
    const page = await h.repository.readHistoryPage(head, 0);
    vi.spyOn(h.repository, "readHistoryPage").mockResolvedValue(page);
    await expect(
      readPolicyEvaluationJobHistoryPage({ ...command, head, pageIndex: 1 }, h.repository),
    ).rejects.toThrow("requested page index");
    vi.spyOn(h.repository, "findHistoryHead").mockResolvedValue({
      ...head,
      job: { ...head.job, jobId: "job_substituted" },
    });
    await expect(readPolicyEvaluationJobHistoryHead(command, h.repository)).rejects.toThrow(
      "substituted",
    );
  });
  it("classifies malformed stored graphs and history separately from caller input", async () => {
    const h = harness();
    await enqueuePolicyEvaluationJob({ ...route(["policy:evaluate"]), input: definition() }, h);
    const command = { ...route(["policy:read"]), jobId: "job_usecase" };
    const head = (await h.repository.findHistoryHead(scope, command.jobId))!;
    vi.spyOn(h.repository, "findHistoryHead").mockResolvedValue({} as never);
    await expect(readPolicyEvaluationJobHistoryHead(command, h.repository)).rejects.toBeInstanceOf(
      PolicyEvaluationJobHistoryError,
    );
    vi.spyOn(h.repository, "readHistoryPage").mockResolvedValue({} as never);
    await expect(
      readPolicyEvaluationJobHistoryPage({ ...command, head, pageIndex: 0 }, h.repository),
    ).rejects.toBeInstanceOf(PolicyEvaluationJobHistoryError);
    // The same malformed shape supplied by the caller remains an input schema error.
    await expect(
      readPolicyEvaluationJobHistoryPage({ ...command, head: {}, pageIndex: 0 }, h.repository),
    ).rejects.toMatchObject({ name: "ZodError" });
    vi.spyOn(h.repository, "findJob").mockResolvedValue({} as never);
    await expect(readPolicyEvaluationJob(command, h.repository)).rejects.toBeInstanceOf(
      InvalidPolicyEvaluationJobGraphError,
    );
  });
  it("preserves an owning history integrity failure", async () => {
    const h = harness();
    await enqueuePolicyEvaluationJob({ ...route(["policy:evaluate"]), input: definition() }, h);
    const command = { ...route(["policy:read"]), jobId: "job_usecase" };
    const head = (await h.repository.findHistoryHead(scope, command.jobId))!;
    const page = await h.repository.readHistoryPage(head, 0);
    page.entries[0]!.entrySha256 = "f".repeat(64);
    page.head.entrySha256 = "f".repeat(64);
    vi.spyOn(h.repository, "readHistoryPage").mockResolvedValue(page);
    await expect(
      readPolicyEvaluationJobHistoryPage(
        { ...command, head: page.head, pageIndex: 0 },
        h.repository,
      ),
    ).rejects.toBeInstanceOf(PolicyEvaluationJobHistoryError);
  });
  it("rejects a cancelled graph that omitted its intent as a server integrity failure", async () => {
    const h = harness();
    await enqueuePolicyEvaluationJob({ ...route(["policy:evaluate"]), input: definition() }, h);
    const queued = (await h.repository.findJob(scope, "job_usecase"))!;
    vi.spyOn(h.repository, "cancelJob").mockResolvedValue(queued);
    await expect(
      cancelPolicyEvaluationJobRequest(
        {
          ...route(["policy:evaluation:cancel"]),
          jobId: "job_usecase",
          input: { reason: "operator_requested" },
        },
        { repository: h.repository, newCancellationId: () => "cancel_missing_intent" },
      ),
    ).rejects.toBeInstanceOf(InvalidPolicyEvaluationJobGraphError);
  });
  it("returns one original intent for concurrent identical reason-only cancellations", async () => {
    const h = harness();
    await enqueuePolicyEvaluationJob({ ...route(["policy:evaluate"]), input: definition() }, h);
    const command = {
      ...route(["policy:evaluation:cancel"]),
      jobId: "job_usecase",
      input: { reason: "operator_requested" },
    };
    const results = await Promise.all([
      cancelPolicyEvaluationJobRequest(command, {
        repository: h.repository,
        newCancellationId: () => "cancel_first",
      }),
      cancelPolicyEvaluationJobRequest(command, {
        repository: h.repository,
        newCancellationId: () => "cancel_second",
      }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.cancellation!.cancellationId).toBe("cancel_first");
  });
  it("rejects a nonboolean creation receipt from the repository", async () => {
    const h = harness();
    const created = await enqueuePolicyEvaluationJob(
      { ...route(["policy:evaluate"]), input: definition() },
      h,
    );
    vi.spyOn(h.repository, "createJob").mockResolvedValue({
      ...created,
      created: "false" as unknown as boolean,
    });
    await expect(
      enqueuePolicyEvaluationJob({ ...route(["policy:evaluate"]), input: definition() }, h),
    ).rejects.toThrow("creation receipt");
  });
  it("rejects substituted server-owned claim nonces from an otherwise valid graph", async () => {
    const h = harness();
    await enqueuePolicyEvaluationJob({ ...route(["policy:evaluate"]), input: definition() }, h);
    const claimed = await claimPolicyEvaluationJobRequest(
      { ...route(["policy:evaluation:execute"]), jobId: "job_usecase" },
      {
        repository: h.repository,
        newAttemptId: () => "attempt_original",
        newLeaseId: () => "lease_original",
      },
    );
    vi.spyOn(h.repository, "claimJob").mockResolvedValue(claimed);
    await expect(
      claimPolicyEvaluationJobRequest(
        { ...route(["policy:evaluation:execute"]), jobId: "job_usecase" },
        {
          repository: h.repository,
          newAttemptId: () => "attempt_substituted",
          newLeaseId: () => "lease_substituted",
        },
      ),
    ).rejects.toThrow("substituted");
  });
  it("rejects query scope substitution from a repository and preserves exact absent reads", async () => {
    const h = harness();
    const created = await enqueuePolicyEvaluationJob(
      { ...route(["policy:evaluate"]), input: definition() },
      h,
    );
    expect(
      await readPolicyEvaluationJob(
        { ...route(["policy:read"]), jobId: "job_missing" },
        h.repository,
      ),
    ).toBeNull();
    vi.spyOn(h.repository, "findJob").mockResolvedValue({
      ...created.snapshot,
      job: { ...created.snapshot.job, jobId: "job_other" },
    });
    await expect(
      readPolicyEvaluationJob({ ...route(["policy:read"]), jobId: "job_usecase" }, h.repository),
    ).rejects.toThrow();
  });
  it("rejects another valid request substituted by the enqueue repository", async () => {
    const h = harness();
    const other = await enqueuePolicyEvaluationJob(
      {
        ...route(["policy:evaluate"]),
        input: { ...definition(), evaluationRequestId: "request_other" },
      },
      { ...h, newJobId: () => "job_other" },
    );
    vi.spyOn(h.repository, "createJob").mockResolvedValue({
      created: false,
      snapshot: other.snapshot,
    });
    await expect(
      enqueuePolicyEvaluationJob({ ...route(["policy:evaluate"]), input: definition() }, h),
    ).rejects.toThrow("substituted");
  });
  it("rejects actor/reason changes to retained cancellation intent", async () => {
    const h = harness();
    await enqueuePolicyEvaluationJob({ ...route(["policy:evaluate"]), input: definition() }, h);
    const command = {
      ...route(["policy:evaluation:cancel"]),
      jobId: "job_usecase",
      input: { reason: "operator_requested" },
    };
    await cancelPolicyEvaluationJobRequest(command, {
      repository: h.repository,
      newCancellationId: () => "cancel_original",
    });
    const spy = vi.spyOn(h.repository, "cancelJob");
    await expect(
      cancelPolicyEvaluationJobRequest(
        { ...command, input: { reason: "incident_response" } },
        { repository: h.repository, newCancellationId: () => "cancel_changed" },
      ),
    ).rejects.toThrow(PolicyEvaluationCancellationConflictError);
    await expect(
      cancelPolicyEvaluationJobRequest(
        {
          ...command,
          principal: principal(["policy:evaluation:cancel"], { principalId: "other_actor" }),
        },
        { repository: h.repository, newCancellationId: () => "cancel_changed" },
      ),
    ).rejects.toThrow("already binds");
    expect(spy).not.toHaveBeenCalled();
  });
  it("heartbeats and interrupts only its exact current authenticated attempt", async () => {
    const h = harness();
    await enqueuePolicyEvaluationJob({ ...route(["policy:evaluate"]), input: definition() }, h);
    const claimed = await claimPolicyEvaluationJobRequest(
      { ...route(["policy:evaluation:execute"]), jobId: "job_usecase" },
      {
        repository: h.repository,
        newAttemptId: () => "attempt_operations",
        newLeaseId: () => "lease_operations",
      },
    );
    const fence = claimed.job.currentLease!.mutationFence;
    h.setTime("2026-09-07T12:00:05.000Z");
    const heartbeat = await mutatePolicyEvaluationWorkerJob(
      { ...route(["policy:evaluation:execute"]), fence, operation: "heartbeat" },
      h.repository,
    );
    expect(heartbeat.job.currentLease!.heartbeatAt).toBe("2026-09-07T12:00:05.000Z");
    await expect(
      mutatePolicyEvaluationWorkerJob(
        {
          ...route(["policy:evaluation:execute"]),
          fence,
          operation: "interrupt",
          input: "lease_expired",
        },
        h.repository,
      ),
    ).rejects.toThrow("Invalid fixed");
    const interrupted = await mutatePolicyEvaluationWorkerJob(
      {
        ...route(["policy:evaluation:execute"]),
        fence,
        operation: "interrupt",
        input: "worker_interrupted",
      },
      h.repository,
    );
    expect(interrupted.job.status).toBe("retry_ready");
    const replacement = { ...interrupted, attempts: [...interrupted.attempts] };
    replacement.attempts[0] = {
      ...replacement.attempts[0]!,
      mutationFence: { ...fence, workerId: "other_worker" },
    };
    vi.spyOn(h.repository, "interruptJob").mockResolvedValue(replacement);
    await expect(
      mutatePolicyEvaluationWorkerJob(
        {
          ...route(["policy:evaluation:execute"]),
          fence,
          operation: "interrupt",
          input: "worker_interrupted",
        },
        h.repository,
      ),
    ).rejects.toThrow("substituted");
  });
  it.each(["enqueue", "read", "cancel", "claim", "mutate"] as const)(
    "denies %s before malformed input or repository access",
    async (operation) => {
      const h = harness();
      const calls = [
        vi.spyOn(h.repository, "createJob"),
        vi.spyOn(h.repository, "findJob"),
        vi.spyOn(h.repository, "cancelJob"),
        vi.spyOn(h.repository, "claimJob"),
        vi.spyOn(h.repository, "heartbeatJob"),
      ];
      const command = { ...route([]), jobId: "!", input: null };
      const pending =
        operation === "enqueue"
          ? enqueuePolicyEvaluationJob(command, h)
          : operation === "read"
            ? readPolicyEvaluationJob(command, h.repository)
            : operation === "cancel"
              ? cancelPolicyEvaluationJobRequest(command, {
                  repository: h.repository,
                  newCancellationId: () => "cancel_test",
                })
              : operation === "claim"
                ? claimPolicyEvaluationJobRequest(command, {
                    repository: h.repository,
                    newAttemptId: () => "attempt_test",
                    newLeaseId: () => "lease_test",
                  })
                : mutatePolicyEvaluationWorkerJob(
                    { ...command, fence: null, operation: "heartbeat" },
                    h.repository,
                  );
      await expect(pending).rejects.toThrow(ForbiddenError);
      for (const call of calls) expect(call).not.toHaveBeenCalled();
    },
  );
  it("enqueues an immutable server receipt and returns original request/job on retry", async () => {
    const h = harness();
    const created = await enqueuePolicyEvaluationJob(
      { ...route(["policy:evaluate"]), input: definition() },
      h,
    );
    expect(created.created).toBe(true);
    expect(created.snapshot.request).toEqual(request);
    h.setTime("2026-09-07T12:00:01.000Z");
    const retry = await enqueuePolicyEvaluationJob(
      { ...route(["policy:evaluate"]), input: definition() },
      { ...h, newJobId: () => "job_retry_ignored" },
    );
    expect(retry.created).toBe(false);
    expect(retry.snapshot).toEqual(created.snapshot);
    expect(
      await readPolicyEvaluationJob(
        { ...route(["policy:read"]), jobId: "job_usecase" },
        h.repository,
      ),
    ).toEqual(created.snapshot);
  });
  it("rejects caller receipt/worker/scope fields before creating a job", async () => {
    const h = harness();
    const spy = vi.spyOn(h.repository, "createJob");
    await expect(
      enqueuePolicyEvaluationJob(
        {
          ...route(["policy:evaluate"]),
          input: { ...definition(), createdAt: request.createdAt, workerId: "forged", scope },
        },
        h,
      ),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
  it("uses authenticated worker identity and denies a different principal's fence", async () => {
    const h = harness();
    await enqueuePolicyEvaluationJob({ ...route(["policy:evaluate"]), input: definition() }, h);
    const claimed = await claimPolicyEvaluationJobRequest(
      { ...route(["policy:evaluation:execute"]), jobId: "job_usecase" },
      {
        repository: h.repository,
        newAttemptId: () => "attempt_test",
        newLeaseId: () => "lease_test",
      },
    );
    const fence = claimed.job.currentLease!.mutationFence;
    expect(fence.workerId).toBe("principal_controller");
    const spy = vi.spyOn(h.repository, "reserveUsage");
    await expect(
      mutatePolicyEvaluationWorkerJob(
        {
          ...route(["policy:evaluation:execute"]),
          principal: principal(["policy:evaluation:execute"], { principalId: "another_worker" }),
          fence,
          operation: "reserve",
          input: null,
        },
        h.repository,
      ),
    ).rejects.toThrow(ForbiddenError);
    expect(spy).not.toHaveBeenCalled();
    const reserved = await mutatePolicyEvaluationWorkerJob(
      {
        ...route(["policy:evaluation:execute"]),
        fence,
        operation: "reserve",
        input: { ...claimed.usage, reads: 1 },
      },
      h.repository,
    );
    expect(reserved.usage.reads).toBe(1);
  });
  it("returns original cancellation intent on repeated reason-only requests", async () => {
    const h = harness();
    await enqueuePolicyEvaluationJob({ ...route(["policy:evaluate"]), input: definition() }, h);
    const command = {
      ...route(["policy:evaluation:cancel"]),
      jobId: "job_usecase",
      input: { reason: "operator_requested" },
    };
    const first = await cancelPolicyEvaluationJobRequest(command, {
      repository: h.repository,
      newCancellationId: () => "cancel_original",
    });
    h.setTime("2026-09-07T12:00:01.000Z");
    const nextId = vi.fn(() => "cancel_wrong_retry");
    const retry = await cancelPolicyEvaluationJobRequest(command, {
      repository: h.repository,
      newCancellationId: nextId,
    });
    expect(retry).toEqual(first);
    expect(nextId).not.toHaveBeenCalled();
  });
});
