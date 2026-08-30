import {
  type CreateReplayJobRequest,
  type EvidenceScope,
  type PrincipalContext,
  PrincipalContextSchema,
  type ReplayJobSnapshot,
} from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import { CreateDurableReplayJob, type CreateDurableReplayJobCommand } from "./create-replay-job.js";
import { InvalidReplayJobInputError, ReplayRepositoryContractError } from "./errors.js";
import type { ReplayJobControlRepository } from "./replay-job-repository.js";
import { createQueuedReplayJob } from "./replay-job-state.js";

const SCOPE: EvidenceScope = {
  environmentId: "env_job_create",
  projectId: "prj_job_create",
  tenantId: "ten_job_create",
};
const REQUEST: CreateReplayJobRequest = {
  jobId: "job_create_001",
  plan: {
    definitionSha256: "a".repeat(64),
    planId: "plan_create",
    planVersionId: "plv_create_001",
  },
};

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-30T17:20:00.000Z",
      method: "development",
    },
    capabilities: ["replay:run"],
    principalId: "usr_job_runner",
    principalType: "user",
    requestId: "req_job_create_001",
    resourceScope: { mode: "tenant" },
    roles: ["member"],
    tenantId: SCOPE.tenantId,
    ...overrides,
  });
}

function snapshot(
  overrides: {
    readonly createdByPrincipalId?: string;
    readonly jobId?: string;
    readonly plan?: CreateReplayJobRequest["plan"];
    readonly recoveryEpoch?: number;
    readonly scope?: EvidenceScope;
    readonly stateVersion?: number;
  } = {},
): ReplayJobSnapshot {
  const job = createQueuedReplayJob({
    createdAt: "2026-08-30T17:21:00.000Z",
    createdByPrincipalId: overrides.createdByPrincipalId ?? "usr_job_runner",
    request: {
      jobId: overrides.jobId ?? REQUEST.jobId,
      plan: overrides.plan ?? REQUEST.plan,
    },
    scope: overrides.scope ?? SCOPE,
  });
  return {
    attempts: [],
    budgetLedger: [],
    cancellationAcknowledgements: [],
    cancellationRequest: null,
    executionObservations: [],
    job: {
      ...job,
      recoveryEpoch: overrides.recoveryEpoch ?? job.recoveryEpoch,
      stateVersion: overrides.stateVersion ?? job.stateVersion,
    },
    usageObservations: [],
  };
}

function command(
  overrides: Partial<CreateDurableReplayJobCommand> = {},
): CreateDurableReplayJobCommand {
  return {
    environmentId: SCOPE.environmentId,
    jobId: REQUEST.jobId,
    principal: principal(),
    projectId: SCOPE.projectId,
    request: REQUEST,
    ...overrides,
  };
}

function harness() {
  const createJob = vi
    .fn<ReplayJobControlRepository["createJob"]>()
    .mockResolvedValue({ created: true, snapshot: snapshot() });
  const unexpected = vi.fn(async () => {
    throw new Error("Unexpected repository operation");
  });
  const repository: ReplayJobControlRepository = {
    createJob,
    findJob: unexpected,
    requestCancellation: unexpected,
  };
  return { createJob, service: new CreateDurableReplayJob(repository) };
}

describe("CreateDurableReplayJob authorization and input", () => {
  it("requires replay run authority before reading protected route or body input", async () => {
    const value = harness();
    let requestReads = 0;
    const input = {
      environmentId: SCOPE.environmentId,
      jobId: REQUEST.jobId,
      principal: principal({ capabilities: ["replay:read"] }),
      projectId: SCOPE.projectId,
      get request() {
        requestReads += 1;
        return REQUEST;
      },
    } satisfies CreateDurableReplayJobCommand;

    await expect(value.service.execute(input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(requestReads).toBe(0);
    expect(value.createJob).not.toHaveBeenCalled();
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
  ])("authorizes exact scope before parsing attacker request %#", async (override) => {
    const value = harness();
    await expect(
      value.service.execute(
        command({
          principal: principal(override),
          request: { ...REQUEST, unexpected: true } as CreateReplayJobRequest,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(value.createJob).not.toHaveBeenCalled();
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
    ["scope", command({ projectId: "x" })],
    ["route job id", command({ jobId: "x" })],
    ["request", command({ request: { ...REQUEST, unexpected: true } as CreateReplayJobRequest })],
    ["route mismatch", command({ request: { ...REQUEST, jobId: "job_create_other" } })],
  ])("rejects invalid %s before repository access", async (_label, input) => {
    const value = harness();
    await expect(value.service.execute(input)).rejects.toBeInstanceOf(InvalidReplayJobInputError);
    expect(value.createJob).not.toHaveBeenCalled();
  });
});

describe("CreateDurableReplayJob repository boundary", () => {
  it("submits detached server authority and returns a detached validated snapshot", async () => {
    const value = harness();
    value.createJob.mockImplementation(async (repositoryCommand) => {
      expect(repositoryCommand).toEqual({
        createdByPrincipalId: "usr_job_runner",
        jobId: REQUEST.jobId,
        plan: REQUEST.plan,
        scope: SCOPE,
      });
      (repositoryCommand.scope as { environmentId: string }).environmentId = "env_mutated";
      (repositoryCommand.plan as { planId: string }).planId = "plan_mutated";
      return { created: true, snapshot: snapshot() };
    });

    const result = await value.service.execute(command());

    expect(result).toEqual({ created: true, snapshot: snapshot() });
    (result.snapshot.attempts as unknown[]).push({});
    expect(snapshot().attempts).toHaveLength(0);
    expect(REQUEST.plan.planId).toBe("plan_create");
  });

  it("returns an exact idempotent creation retry", async () => {
    const value = harness();
    value.createJob.mockResolvedValue({ created: false, snapshot: snapshot() });
    await expect(value.service.execute(command())).resolves.toEqual({
      created: false,
      snapshot: snapshot(),
    });
  });

  it.each([
    null,
    {},
    { created: "yes", snapshot: snapshot() },
    { created: true, snapshot: snapshot(), unexpected: true },
    new Proxy(
      { created: true, snapshot: snapshot() },
      {
        ownKeys: () => {
          throw new Error("unreadable keys");
        },
      },
    ),
    new Proxy(
      { created: true, snapshot: snapshot() },
      {
        get: (target, property, receiver) => {
          if (property === "created") throw new Error("unreadable field");
          return Reflect.get(target, property, receiver);
        },
      },
    ),
    { created: true, snapshot: {} },
  ])("rejects malformed creation result %#", async (result) => {
    const value = harness();
    value.createJob.mockResolvedValue(result as never);
    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it.each([
    ["substituted job", snapshot({ jobId: "job_other_001" })],
    ["substituted tenant", snapshot({ scope: { ...SCOPE, tenantId: "ten_other" } })],
    ["substituted project", snapshot({ scope: { ...SCOPE, projectId: "prj_other" } })],
    ["substituted environment", snapshot({ scope: { ...SCOPE, environmentId: "env_other" } })],
    ["substituted creator", snapshot({ createdByPrincipalId: "usr_other" })],
    ["substituted plan id", snapshot({ plan: { ...REQUEST.plan, planId: "plan_other" } })],
    [
      "substituted plan version",
      snapshot({ plan: { ...REQUEST.plan, planVersionId: "plv_other_001" } }),
    ],
    [
      "substituted plan digest",
      snapshot({ plan: { ...REQUEST.plan, definitionSha256: "b".repeat(64) } }),
    ],
    ["invalid initial state version", snapshot({ stateVersion: 2 })],
    ["invalid initial recovery epoch", snapshot({ recoveryEpoch: 1 })],
  ])("rejects a repository %s", async (_label, repositorySnapshot) => {
    const value = harness();
    value.createJob.mockResolvedValue({ created: true, snapshot: repositorySnapshot });
    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("preserves repository failures", async () => {
    const value = harness();
    const failure = new Error("database unavailable");
    value.createJob.mockRejectedValue(failure);
    await expect(value.service.execute(command())).rejects.toBe(failure);
  });
});
