import type { ReplayJobSnapshot } from "@proofstack/replay";
import {
  DurableReplayStateError,
  ReplayDefinitionLineageError,
  ReplayJobConflictError,
  ReplayJobNotFoundError,
  ReplayRepositoryContractError,
} from "@proofstack/replay";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresReplayJobControlRepository } from "./postgres-replay-job-control-repository.js";

type QueryHandler = (
  text: string,
  values: readonly unknown[] | undefined,
) => { readonly rows: readonly Record<string, unknown>[] };

class FakeClient {
  readonly queries: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];

  constructor(private readonly handler: QueryHandler) {}

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, ...(values ? { values } : {}) });
    return this.handler(text, values);
  }

  release(): void {}
}

function poolWith(client: FakeClient): Pick<Pool, "connect"> {
  return { connect: async () => client } as unknown as Pick<Pool, "connect">;
}

function repository(handler: QueryHandler) {
  const client = new FakeClient((text, values) => {
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.includes("set_config")
    ) {
      return { rows: [] };
    }
    return handler(text, values);
  });
  return { client, repository: new PostgresReplayJobControlRepository(poolWith(client)) };
}

const scope = {
  environmentId: "env_control_test",
  projectId: "prj_control_test",
  tenantId: "ten_control_test",
} as const;
const jobId = "job_control_test";
const plan = {
  definitionSha256: "1".repeat(64),
  planId: "plan_control_test",
  planVersionId: "plv_control_test",
} as const;
const principalId = "usr_control_test";
const createdAt = "2026-08-30T02:00:00.000Z";
const endedAt = "2026-08-30T02:00:01.000Z";

function queuedSnapshot(): ReplayJobSnapshot {
  return {
    attempts: [],
    budgetLedger: [],
    cancellationAcknowledgements: [],
    cancellationRequest: null,
    executionObservations: [],
    job: {
      createdAt,
      createdByPrincipalId: principalId,
      jobId,
      lastFencingToken: 0,
      plan,
      recoveryEpoch: 0,
      schemaVersion: "0.1",
      scope,
      stateVersion: 1,
      status: "queued",
    },
    usageObservations: [],
  };
}

function cancellationRequest(requestedByPrincipalId = principalId) {
  return {
    cancellationId: "can_control_test",
    jobId,
    reason: "Stop this queued replay before target execution.",
    reasonCode: "operator_request",
    requestedAt: endedAt,
    requestedByPrincipalId,
    schemaVersion: "0.1",
    scope,
  } as const;
}

function cancelledSnapshot(requestedByPrincipalId = principalId): ReplayJobSnapshot {
  return {
    ...queuedSnapshot(),
    cancellationRequest: cancellationRequest(requestedByPrincipalId),
    job: {
      ...queuedSnapshot().job,
      stateVersion: 2,
      status: "cancelled",
      terminal: {
        code: "cancellation_committed",
        committedAt: endedAt,
        status: "cancelled",
      },
    },
  };
}

function completedSnapshot(): ReplayJobSnapshot {
  const attemptId = "att_control_test";
  const workerProtocol = { name: "proofstack.replay-worker", version: "1.0.0" } as const;
  const fence = {
    attemptId,
    fencingToken: 1,
    jobId,
    leaseId: "lease_control_test",
    recoveryEpoch: 0,
    workerId: "wrk_control_test",
  } as const;
  return {
    attempts: [
      {
        attemptId,
        attemptSequence: 0,
        endedAt,
        isolationProfile: {
          definitionSha256: "2".repeat(64),
          id: "iso_control_test",
          kind: "local_child_process",
          version: "1.0.0",
        },
        jobId,
        mutationFence: fence,
        plan,
        result: {
          artifactId: "art_control_result",
          classification: "confidential",
          mediaType: "application/json",
          sha256: "3".repeat(64),
          sizeBytes: 10,
        },
        retryDisposition: "not_retryable",
        runtimeProfile: {
          definitionSha256: "4".repeat(64),
          family: "node",
          id: "run_control_test",
          version: "1.0.0",
        },
        schemaVersion: "0.1",
        scope,
        startedAt: createdAt,
        status: "succeeded",
        targetRelease: {
          definitionSha256: "5".repeat(64),
          targetAdapter: {
            name: "proofstack.test",
            protocolVersion: "1.0.0",
            version: "1.0.0",
          },
          targetId: "target_control_test",
          targetReleaseId: "trg_control_test",
          workerProtocol,
        },
        workerBuildSha256: "6".repeat(64),
        workerProtocol,
      },
    ],
    budgetLedger: [],
    cancellationAcknowledgements: [],
    cancellationRequest: null,
    executionObservations: [],
    job: {
      createdAt,
      createdByPrincipalId: principalId,
      jobId,
      lastFencingToken: 1,
      latestAttemptSequence: 0,
      plan,
      recoveryEpoch: 0,
      schemaVersion: "0.1",
      scope,
      startedAt: createdAt,
      stateVersion: 3,
      status: "succeeded",
      terminal: {
        attemptId,
        code: "completed",
        committedAt: endedAt,
        status: "succeeded",
      },
    },
    usageObservations: [],
  };
}

function createCommand() {
  return { createdByPrincipalId: principalId, jobId, plan, scope } as const;
}

function cancelCommand(requestedByPrincipalId = principalId) {
  const request = cancellationRequest();
  return {
    input: {
      cancellationId: request.cancellationId,
      reason: request.reason,
      reasonCode: request.reasonCode,
    },
    jobId,
    requestedByPrincipalId,
    scope,
  } as const;
}

function postgresError(code: string, message?: string) {
  return Object.assign(new Error(message), { code });
}

describe("PostgresReplayJobControlRepository", () => {
  it("reads a detached tenant-scoped snapshot and hides unavailable jobs", async () => {
    const stored = queuedSnapshot();
    let visible = true;
    const testHarness = repository((text, values) => {
      expect(text).toContain("proofstack_read_replay_job_snapshot");
      expect(values).toEqual([scope.projectId, scope.environmentId, jobId]);
      return { rows: [{ snapshot: visible ? stored : null }] };
    });

    const first = await testHarness.repository.findJob(scope, jobId);
    expect(first).toEqual(stored);
    if (!first) throw new Error("Expected a replay snapshot");
    first.job.createdByPrincipalId = "usr_mutated";
    expect(stored.job.createdByPrincipalId).toBe(principalId);
    visible = false;
    await expect(testHarness.repository.findJob(scope, jobId)).resolves.toBeNull();
  });

  it("fails closed when the snapshot reader returns no row", async () => {
    const testHarness = repository(() => ({ rows: [] }));
    await expect(testHarness.repository.findJob(scope, jobId)).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("creates an exact-plan job and cross-checks the durable snapshot", async () => {
    const snapshot = queuedSnapshot();
    const testHarness = repository((text, values) => {
      if (text.includes("proofstack_create_replay_job")) {
        expect(values).toEqual([
          scope.projectId,
          scope.environmentId,
          jobId,
          plan.planId,
          plan.planVersionId,
          plan.definitionSha256,
          principalId,
        ]);
        return { rows: [{ created: true, job: snapshot.job }] };
      }
      return { rows: [{ snapshot }] };
    });

    await expect(testHarness.repository.createJob(createCommand())).resolves.toEqual({
      created: true,
      snapshot,
    });
  });

  it("accepts an idempotent creation retry after the job has completed", async () => {
    const snapshot = completedSnapshot();
    const testHarness = repository((text) =>
      text.includes("proofstack_create_replay_job")
        ? { rows: [{ created: false, job: snapshot.job }] }
        : { rows: [{ snapshot }] },
    );
    await expect(testHarness.repository.createJob(createCommand())).resolves.toEqual({
      created: false,
      snapshot,
    });
  });

  it.each([
    [
      "mismatched returned job",
      { created: true, job: { ...queuedSnapshot().job, stateVersion: 2 } },
    ],
    ["non-boolean creation flag", { created: "true", job: queuedSnapshot().job }],
  ])("rejects an invalid %s", async (_label, row) => {
    const snapshot = queuedSnapshot();
    const testHarness = repository((text) =>
      text.includes("proofstack_create_replay_job") ? { rows: [row] } : { rows: [{ snapshot }] },
    );
    await expect(testHarness.repository.createJob(createCommand())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("rejects multiple creation rows", async () => {
    const snapshot = queuedSnapshot();
    const row = { created: true, job: snapshot.job };
    const testHarness = repository((text) =>
      text.includes("proofstack_create_replay_job")
        ? { rows: [row, row] }
        : { rows: [{ snapshot }] },
    );
    await expect(testHarness.repository.createJob(createCommand())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("rejects a newly created result that already contains execution history", async () => {
    const snapshot = completedSnapshot();
    const testHarness = repository((text) =>
      text.includes("proofstack_create_replay_job")
        ? { rows: [{ created: true, job: snapshot.job }] }
        : { rows: [{ snapshot }] },
    );
    await expect(testHarness.repository.createJob(createCommand())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("requests cancellation with exact immutable input and snapshot agreement", async () => {
    const snapshot = cancelledSnapshot();
    const testHarness = repository((text, values) => {
      if (text.includes("proofstack_request_replay_cancellation")) {
        expect(values).toEqual([
          scope.projectId,
          scope.environmentId,
          jobId,
          snapshot.cancellationRequest?.cancellationId,
          snapshot.cancellationRequest?.reasonCode,
          snapshot.cancellationRequest?.reason,
          principalId,
        ]);
        return {
          rows: [{ created: true, job: snapshot.job, request: snapshot.cancellationRequest }],
        };
      }
      return { rows: [{ snapshot }] };
    });
    await expect(testHarness.repository.requestCancellation(cancelCommand())).resolves.toEqual({
      created: true,
      snapshot,
    });
  });

  it("accepts an idempotent cancellation retry without rebinding its principal", async () => {
    const snapshot = cancelledSnapshot();
    const testHarness = repository((text) =>
      text.includes("proofstack_request_replay_cancellation")
        ? {
            rows: [{ created: false, job: snapshot.job, request: snapshot.cancellationRequest }],
          }
        : { rows: [{ snapshot }] },
    );
    await expect(
      testHarness.repository.requestCancellation(cancelCommand("usr_retrying_operator")),
    ).resolves.toEqual({ created: false, snapshot });
  });

  it("returns an unchanged terminal job when no cancellation request exists", async () => {
    const snapshot = completedSnapshot();
    const testHarness = repository((text) =>
      text.includes("proofstack_request_replay_cancellation")
        ? { rows: [{ created: false, job: snapshot.job, request: null }] }
        : { rows: [{ snapshot }] },
    );
    await expect(testHarness.repository.requestCancellation(cancelCommand())).resolves.toEqual({
      created: false,
      snapshot,
    });
  });

  it("rejects a cancellation request that disagrees with the durable snapshot", async () => {
    const snapshot = cancelledSnapshot();
    const returned = { ...snapshot.cancellationRequest, cancellationId: "can_other" };
    const testHarness = repository((text) =>
      text.includes("proofstack_request_replay_cancellation")
        ? { rows: [{ created: true, job: snapshot.job, request: returned }] }
        : { rows: [{ snapshot }] },
    );
    await expect(
      testHarness.repository.requestCancellation(cancelCommand()),
    ).rejects.toBeInstanceOf(ReplayRepositoryContractError);
  });

  it("rejects a cancellation job that disagrees with the durable snapshot", async () => {
    const snapshot = cancelledSnapshot();
    const returnedJob = { ...snapshot.job, stateVersion: 3 };
    const testHarness = repository((text) =>
      text.includes("proofstack_request_replay_cancellation")
        ? {
            rows: [{ created: true, job: returnedJob, request: snapshot.cancellationRequest }],
          }
        : { rows: [{ snapshot }] },
    );
    await expect(
      testHarness.repository.requestCancellation(cancelCommand()),
    ).rejects.toBeInstanceOf(ReplayRepositoryContractError);
  });

  it("rejects a newly created cancellation attributed to another principal", async () => {
    const snapshot = cancelledSnapshot("usr_other_operator");
    const testHarness = repository((text) =>
      text.includes("proofstack_request_replay_cancellation")
        ? { rows: [{ created: true, job: snapshot.job, request: snapshot.cancellationRequest }] }
        : { rows: [{ snapshot }] },
    );
    await expect(
      testHarness.repository.requestCancellation(cancelCommand()),
    ).rejects.toBeInstanceOf(ReplayRepositoryContractError);
  });

  it("rejects a null cancellation request for a nonterminal job", async () => {
    const snapshot = queuedSnapshot();
    const testHarness = repository((text) =>
      text.includes("proofstack_request_replay_cancellation")
        ? { rows: [{ created: false, job: snapshot.job, request: null }] }
        : { rows: [{ snapshot }] },
    );
    await expect(
      testHarness.repository.requestCancellation(cancelCommand()),
    ).rejects.toBeInstanceOf(ReplayRepositoryContractError);
  });

  it.each([
    [
      "create",
      "23503",
      "Replay job requires an exact published plan",
      ReplayDefinitionLineageError,
    ],
    ["create", "23505", undefined, ReplayJobConflictError],
    ["cancel", "P0002", "Replay job is unavailable", ReplayJobNotFoundError],
    ["cancel", "23505", "Replay cancellation identity conflicts", DurableReplayStateError],
    ["cancel", "40001", "Replay job changed", DurableReplayStateError],
    ["cancel", "22003", "Replay job state version is exhausted", DurableReplayStateError],
    [
      "create",
      "23514",
      "Stored replay job is missing its canonical intent",
      ReplayRepositoryContractError,
    ],
    ["cancel", "22023", "Invalid replay cancellation authority input", ReplayJobConflictError],
  ] as const)("maps %s PostgreSQL error %s", async (operation, code, message, ErrorType) => {
    const error = postgresError(code, message);
    const testHarness = repository((text) => {
      if (
        text.includes("proofstack_create_replay_job") ||
        text.includes("proofstack_request_replay_cancellation")
      ) {
        throw error;
      }
      return { rows: [] };
    });
    const result =
      operation === "create"
        ? testHarness.repository.createJob(createCommand())
        : testHarness.repository.requestCancellation(cancelCommand());
    await expect(result).rejects.toBeInstanceOf(ErrorType);
  });

  it("preserves unknown persistence errors", async () => {
    const error = new Error("connection closed");
    const testHarness = repository(() => {
      throw error;
    });
    await expect(testHarness.repository.createJob(createCommand())).rejects.toBe(error);
  });

  it("validates public control inputs before opening a transaction", async () => {
    const testHarness = repository(() => ({ rows: [] }));
    await expect(
      testHarness.repository.createJob({ ...createCommand(), jobId: "INVALID" }),
    ).rejects.toBeDefined();
    await expect(
      testHarness.repository.requestCancellation({
        ...cancelCommand(),
        input: { ...cancelCommand().input, reason: " invalid " },
      }),
    ).rejects.toBeDefined();
    expect(testHarness.client.queries).toEqual([]);
  });
});
