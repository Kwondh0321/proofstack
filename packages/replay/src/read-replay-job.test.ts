import {
  type EvidenceScope,
  type PrincipalContext,
  PrincipalContextSchema,
  type ReplayJobSnapshot,
} from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidReplayJobInputError,
  ReplayJobNotFoundError,
  ReplayRepositoryContractError,
} from "./errors.js";
import { ReadReplayJob, type ReadReplayJobCommand } from "./read-replay-job.js";
import { createQueuedReplayJob } from "./replay-job-state.js";
import type { ReplayJobControlRepository } from "./replay-job-repository.js";

const SCOPE: EvidenceScope = {
  environmentId: "env_job_read",
  projectId: "prj_job_read",
  tenantId: "ten_job_read",
};
const JOB_ID = "job_read_001";
const PLAN = {
  definitionSha256: "a".repeat(64),
  planId: "plan_read",
  planVersionId: "plv_read_001",
};

function queuedSnapshot(scope: EvidenceScope = SCOPE, jobId = JOB_ID): ReplayJobSnapshot {
  return {
    attempts: [],
    budgetLedger: [],
    cancellationAcknowledgements: [],
    cancellationRequest: null,
    executionObservations: [],
    job: createQueuedReplayJob({
      createdAt: "2026-08-30T17:10:00.000Z",
      createdByPrincipalId: "usr_job_creator",
      request: { jobId, plan: PLAN },
      scope,
    }),
    usageObservations: [],
  };
}

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-30T17:11:00.000Z",
      method: "development",
    },
    capabilities: ["replay:read"],
    principalId: "usr_job_reader",
    principalType: "user",
    requestId: "req_job_read_001",
    resourceScope: { mode: "tenant" },
    roles: ["viewer"],
    tenantId: SCOPE.tenantId,
    ...overrides,
  });
}

function command(overrides: Partial<ReadReplayJobCommand> = {}): ReadReplayJobCommand {
  return {
    environmentId: SCOPE.environmentId,
    jobId: JOB_ID,
    principal: principal(),
    projectId: SCOPE.projectId,
    ...overrides,
  };
}

function harness(stored: unknown = queuedSnapshot()) {
  const findJob = vi
    .fn<ReplayJobControlRepository["findJob"]>()
    .mockResolvedValue(stored as ReplayJobSnapshot | null);
  const unexpected = vi.fn(async () => {
    throw new Error("Unexpected repository mutation");
  });
  const repository: ReplayJobControlRepository = {
    createJob: unexpected,
    findJob,
    requestCancellation: unexpected,
  };
  return { findJob, reader: new ReadReplayJob(repository) };
}

describe("ReadReplayJob", () => {
  it("returns a detached exact snapshot through a detached authorized scope", async () => {
    const stored = queuedSnapshot();
    const value = harness(stored);
    value.findJob.mockImplementation(async (scope, jobId) => {
      expect(scope).toEqual(SCOPE);
      expect(jobId).toBe(JOB_ID);
      (scope as { environmentId: string }).environmentId = "env_mutated";
      return stored;
    });

    const result = await value.reader.execute(command());

    expect(result).toEqual(stored);
    expect(result).not.toBe(stored);
    (result.attempts as unknown[]).push({});
    expect(stored.attempts).toHaveLength(0);
  });

  it("requires replay read capability before touching protected route input", async () => {
    const value = harness();
    let environmentReads = 0;
    const input = {
      get environmentId() {
        environmentReads += 1;
        return SCOPE.environmentId;
      },
      jobId: JOB_ID,
      principal: principal({ capabilities: ["replay:run"] }),
      projectId: SCOPE.projectId,
    } satisfies ReadReplayJobCommand;

    await expect(value.reader.execute(input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(environmentReads).toBe(0);
    expect(value.findJob).not.toHaveBeenCalled();
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
  ])("authorizes exact scope before parsing job identity %#", async (override) => {
    const value = harness();
    await expect(
      value.reader.execute(command({ jobId: "x", principal: principal(override) })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(value.findJob).not.toHaveBeenCalled();
  });

  it("accepts an explicitly authorized restricted environment", async () => {
    const value = harness();
    const restricted = principal({
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: [SCOPE.environmentId], projectId: SCOPE.projectId }],
      },
    });
    await expect(value.reader.execute(command({ principal: restricted }))).resolves.toEqual(
      queuedSnapshot(),
    );
  });

  it.each([
    ["principal", command({ principal: { principalId: "bad" } as PrincipalContext })],
    ["scope", command({ projectId: "x" })],
    ["job id", command({ jobId: "x" })],
  ])("rejects invalid %s input before repository access", async (_label, input) => {
    const value = harness();
    await expect(value.reader.execute(input)).rejects.toBeInstanceOf(InvalidReplayJobInputError);
    expect(value.findJob).not.toHaveBeenCalled();
  });

  it("returns one bounded not-found error for an absent authorized job", async () => {
    const value = harness(null);
    await expect(value.reader.execute(command())).rejects.toBeInstanceOf(ReplayJobNotFoundError);
  });

  it.each([
    ["invalid snapshot", {}],
    ["inconsistent snapshot", { ...queuedSnapshot(), cancellationRequest: {} }],
    ["substituted job", queuedSnapshot(SCOPE, "job_other_001")],
    ["substituted tenant", queuedSnapshot({ ...SCOPE, tenantId: "ten_other" })],
    ["substituted project", queuedSnapshot({ ...SCOPE, projectId: "prj_other" })],
    ["substituted environment", queuedSnapshot({ ...SCOPE, environmentId: "env_other" })],
  ])("rejects a repository %s as a contract violation", async (_label, stored) => {
    const value = harness(stored);
    await expect(value.reader.execute(command())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("normalizes unreadable repository snapshots as contract violations", async () => {
    const value = harness(
      new Proxy(queuedSnapshot(), {
        ownKeys: () => {
          throw new Error("unreadable snapshot");
        },
      }),
    );
    await expect(value.reader.execute(command())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("preserves job repository failures", async () => {
    const value = harness();
    const failure = new Error("database unavailable");
    value.findJob.mockRejectedValue(failure);
    await expect(value.reader.execute(command())).rejects.toBe(failure);
  });
});
