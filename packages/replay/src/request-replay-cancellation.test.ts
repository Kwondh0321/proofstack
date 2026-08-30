import {
  type EvidenceScope,
  type PrincipalContext,
  PrincipalContextSchema,
  type ReplayJobSnapshot,
  type RequestReplayCancellation,
} from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import { InvalidReplayJobInputError, ReplayRepositoryContractError } from "./errors.js";
import type { ReplayJobControlRepository } from "./replay-job-repository.js";
import {
  claimReplayJob,
  completeReplayAttempt,
  createQueuedReplayJob,
  requestReplayCancellation,
} from "./replay-job-state.js";
import {
  RequestDurableReplayCancellation,
  type RequestReplayJobCancellationCommand,
} from "./request-replay-cancellation.js";

const SCOPE: EvidenceScope = {
  environmentId: "env_job_cancel",
  projectId: "prj_job_cancel",
  tenantId: "ten_job_cancel",
};
const JOB_ID = "job_cancel_001";
const PLAN = {
  definitionSha256: "1".repeat(64),
  planId: "plan_cancel",
  planVersionId: "plv_cancel_001",
};
const REQUEST: RequestReplayCancellation = {
  cancellationId: "can_job_cancel_001",
  reason: "Stop this bounded replay safely.",
  reasonCode: "operator_request",
};
const CREATED_AT = "2026-08-30T17:30:00.000Z";
const REQUESTED_AT = "2026-08-30T17:30:01.000Z";

function queuedSnapshot(): ReplayJobSnapshot {
  return {
    attempts: [],
    budgetLedger: [],
    cancellationAcknowledgements: [],
    cancellationRequest: null,
    executionObservations: [],
    job: createQueuedReplayJob({
      createdAt: CREATED_AT,
      createdByPrincipalId: "usr_job_creator",
      request: { jobId: JOB_ID, plan: PLAN },
      scope: SCOPE,
    }),
    usageObservations: [],
  };
}

function cancelledSnapshot(
  request: RequestReplayCancellation = REQUEST,
  requestedByPrincipalId = "usr_job_canceller",
): ReplayJobSnapshot {
  const queued = queuedSnapshot();
  const cancelled = requestReplayCancellation(queued.job, {
    input: request,
    now: REQUESTED_AT,
    requestedByPrincipalId,
  });
  return {
    ...queued,
    cancellationRequest: cancelled.request,
    job: cancelled.job,
  };
}

function completedSnapshot(): ReplayJobSnapshot {
  const queued = queuedSnapshot();
  const workerProtocol = { name: "proofstack.replay-worker", version: "1.0.0" };
  const claimed = claimReplayJob(queued.job, {
    attemptId: "att_job_cancel_001",
    isolationProfile: {
      definitionSha256: "2".repeat(64),
      id: "iso_job_cancel",
      kind: "local_child_process",
      version: "1.0.0",
    },
    leaseDurationMilliseconds: 30_000,
    leaseId: "lea_job_cancel_001",
    maxAttempts: 1,
    now: "2026-08-30T17:30:01.000Z",
    runtimeProfile: {
      definitionSha256: "3".repeat(64),
      family: "node",
      id: "run_job_cancel",
      version: "1.0.0",
    },
    targetRelease: {
      definitionSha256: "4".repeat(64),
      targetAdapter: {
        name: "proofstack.test",
        protocolVersion: "1.0.0",
        version: "1.0.0",
      },
      targetId: "target_job_cancel",
      targetReleaseId: "trg_job_cancel_001",
      workerProtocol,
    },
    workerBuildSha256: "5".repeat(64),
    workerId: "wrk_job_cancel_001",
    workerProtocol,
  });
  const completed = completeReplayAttempt(
    claimed.job,
    claimed.attempt,
    claimed.lease.mutationFence,
    {
      cancellationRequested: false,
      code: "completed",
      now: "2026-08-30T17:30:02.000Z",
      result: {
        artifactId: "art_job_cancel_result",
        classification: "internal",
        mediaType: "application/json",
        sha256: "6".repeat(64),
        sizeBytes: 32,
      },
      status: "succeeded",
    },
  );
  return {
    ...queued,
    attempts: [completed.attempt],
    job: completed.job,
  };
}

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-30T17:29:00.000Z",
      method: "development",
    },
    capabilities: ["replay:cancel"],
    principalId: "usr_job_canceller",
    principalType: "user",
    requestId: "req_job_cancel_001",
    resourceScope: { mode: "tenant" },
    roles: ["member"],
    tenantId: SCOPE.tenantId,
    ...overrides,
  });
}

function command(
  overrides: Partial<RequestReplayJobCancellationCommand> = {},
): RequestReplayJobCancellationCommand {
  return {
    environmentId: SCOPE.environmentId,
    jobId: JOB_ID,
    principal: principal(),
    projectId: SCOPE.projectId,
    request: REQUEST,
    ...overrides,
  };
}

function harness() {
  const requestCancellation = vi
    .fn<ReplayJobControlRepository["requestCancellation"]>()
    .mockResolvedValue({ created: true, snapshot: cancelledSnapshot() });
  const unexpected = vi.fn(async () => {
    throw new Error("Unexpected repository operation");
  });
  const repository: ReplayJobControlRepository = {
    createJob: unexpected,
    findJob: unexpected,
    requestCancellation,
  };
  return {
    requestCancellation,
    service: new RequestDurableReplayCancellation(repository),
  };
}

describe("RequestDurableReplayCancellation authorization and input", () => {
  it("requires replay cancel authority before reading protected route or body input", async () => {
    const value = harness();
    let requestReads = 0;
    const input = {
      environmentId: SCOPE.environmentId,
      jobId: JOB_ID,
      principal: principal({ capabilities: ["replay:read"] }),
      projectId: SCOPE.projectId,
      get request() {
        requestReads += 1;
        return REQUEST;
      },
    } satisfies RequestReplayJobCancellationCommand;

    await expect(value.service.execute(input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(requestReads).toBe(0);
    expect(value.requestCancellation).not.toHaveBeenCalled();
  });

  it.each([
    {
      resourceScope: {
        mode: "restricted" as const,
        projects: [{ projectId: "prj_other" }],
      },
    },
    {
      resourceScope: {
        mode: "restricted" as const,
        projects: [{ environmentIds: ["env_other"], projectId: SCOPE.projectId }],
      },
    },
  ])("authorizes exact scope before parsing attacker input %#", async (override) => {
    const value = harness();
    await expect(
      value.service.execute(
        command({
          principal: principal(override),
          request: { ...REQUEST, unexpected: true } as RequestReplayCancellation,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(value.requestCancellation).not.toHaveBeenCalled();
  });

  it("accepts an explicitly authorized restricted environment", async () => {
    const value = harness();
    const restricted = principal({
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: [SCOPE.environmentId], projectId: SCOPE.projectId }],
      },
    });
    await expect(value.service.execute(command({ principal: restricted }))).resolves.toMatchObject({
      created: true,
    });
  });

  it.each([
    ["principal", command({ principal: { principalId: "bad" } as PrincipalContext })],
    ["scope", command({ environmentId: "x" })],
    ["job id", command({ jobId: "x" })],
    [
      "request",
      command({ request: { ...REQUEST, unexpected: true } as RequestReplayCancellation }),
    ],
  ])("rejects invalid %s before repository access", async (_label, input) => {
    const value = harness();
    await expect(value.service.execute(input)).rejects.toBeInstanceOf(InvalidReplayJobInputError);
    expect(value.requestCancellation).not.toHaveBeenCalled();
  });
});

describe("RequestDurableReplayCancellation repository boundary", () => {
  it("submits detached cancellation authority and returns a detached immutable request", async () => {
    const value = harness();
    value.requestCancellation.mockImplementation(async (repositoryCommand) => {
      expect(repositoryCommand).toEqual({
        input: REQUEST,
        jobId: JOB_ID,
        requestedByPrincipalId: "usr_job_canceller",
        scope: SCOPE,
      });
      (repositoryCommand.input as { reason: string }).reason = "mutated";
      (repositoryCommand.scope as { environmentId: string }).environmentId = "env_mutated";
      return { created: true, snapshot: cancelledSnapshot() };
    });

    const result = await value.service.execute(command());

    expect(result).toEqual({ created: true, snapshot: cancelledSnapshot() });
    (result.snapshot.attempts as unknown[]).push({});
    expect(cancelledSnapshot().attempts).toHaveLength(0);
    expect(REQUEST.reason).toBe("Stop this bounded replay safely.");
  });

  it("accepts an exact retry recorded by another authorized principal", async () => {
    const value = harness();
    const existing = cancelledSnapshot(REQUEST, "usr_original_canceller");
    value.requestCancellation.mockResolvedValue({ created: false, snapshot: existing });
    await expect(value.service.execute(command())).resolves.toEqual({
      created: false,
      snapshot: existing,
    });
  });

  it("accepts the terminal race when no cancellation was committed", async () => {
    const value = harness();
    const completed = completedSnapshot();
    value.requestCancellation.mockResolvedValue({ created: false, snapshot: completed });
    await expect(value.service.execute(command())).resolves.toEqual({
      created: false,
      snapshot: completed,
    });
  });

  it("rejects created or nonterminal results without a cancellation request", async () => {
    const created = harness();
    created.requestCancellation.mockResolvedValue({ created: true, snapshot: queuedSnapshot() });
    await expect(created.service.execute(command())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );

    const retry = harness();
    retry.requestCancellation.mockResolvedValue({ created: false, snapshot: queuedSnapshot() });
    await expect(retry.service.execute(command())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it.each([
    ["cancellation id", cancelledSnapshot({ ...REQUEST, cancellationId: "can_other_001" })],
    ["reason code", cancelledSnapshot({ ...REQUEST, reasonCode: "superseded" })],
    ["reason", cancelledSnapshot({ ...REQUEST, reason: "Stop a different replay." })],
    ["requesting principal", cancelledSnapshot(REQUEST, "usr_other")],
  ])("rejects a newly created result with substituted %s", async (_label, snapshot) => {
    const value = harness();
    value.requestCancellation.mockResolvedValue({ created: true, snapshot });
    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("rejects a retry with different immutable cancellation semantics", async () => {
    const value = harness();
    value.requestCancellation.mockResolvedValue({
      created: false,
      snapshot: cancelledSnapshot({ ...REQUEST, reason: "Stop a different replay." }),
    });
    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("rejects invalid snapshots and preserves repository failures", async () => {
    const invalid = harness();
    invalid.requestCancellation.mockResolvedValue({ created: true, snapshot: {} as never });
    await expect(invalid.service.execute(command())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );

    const failed = harness();
    const failure = new Error("database unavailable");
    failed.requestCancellation.mockRejectedValue(failure);
    await expect(failed.service.execute(command())).rejects.toBe(failure);
  });
});
