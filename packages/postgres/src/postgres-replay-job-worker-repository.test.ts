import {
  REPLAY_BUDGET_DIMENSIONS,
  ReplayBudgetReconciliationSchema,
  ReplayBudgetReservationSchema,
  ReplayUsageObservationSchema,
  type ReplayBudgetDimension,
  type ReplayJob,
  type ReplayWorkerMutationFence,
} from "@proofstack/contracts";
import {
  DurableReplayAccountingError,
  DurableReplayStateError,
  ReplayDefinitionLineageError,
  ReplayJobConflictError,
  ReplayJobNotFoundError,
  ReplayRepositoryContractError,
  type ReplayBudgetAmounts,
  type ReplayJobSnapshot,
  type ReplayUsageMeasurements,
} from "@proofstack/replay";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresReplayJobWorkerRepository } from "./postgres-replay-job-worker-repository.js";

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
  return { client, repository: new PostgresReplayJobWorkerRepository(poolWith(client)) };
}

const scope = {
  environmentId: "env_worker_test",
  projectId: "prj_worker_test",
  tenantId: "ten_worker_test",
} as const;
const jobId = "job_worker_test";
const attemptId = "att_worker_test";
const fence = {
  attemptId,
  fencingToken: 1,
  jobId,
  leaseId: "lease_worker_test",
  recoveryEpoch: 0,
  workerId: "wrk_worker_test",
} as const satisfies ReplayWorkerMutationFence;
const startedAt = "2026-08-30T01:00:00.000Z";
const endedAt = "2026-08-30T01:00:01.000Z";
const sha = (character: string) => character.repeat(64);
const plan = {
  definitionSha256: sha("1"),
  planId: "plan_worker_test",
  planVersionId: "plv_worker_test",
} as const;
const workerProtocol = { name: "proofstack.replay-worker", version: "1.0.0" } as const;
const targetRelease = {
  definitionSha256: sha("2"),
  targetAdapter: {
    name: "proofstack.test",
    protocolVersion: "1.0.0",
    version: "1.0.0",
  },
  targetId: "target_worker_test",
  targetReleaseId: "trg_worker_test",
  workerProtocol,
} as const;
const resultArtifact = {
  artifactId: "art_worker_result",
  classification: "confidential",
  mediaType: "application/json",
  sha256: sha("9"),
  sizeBytes: 10,
} as const;

function runningAttempt() {
  return {
    attemptId,
    attemptSequence: 0,
    isolationProfile: {
      definitionSha256: sha("3"),
      id: "iso_worker_test",
      kind: "local_child_process",
      version: "1.0.0",
    },
    jobId,
    mutationFence: fence,
    plan,
    runtimeProfile: {
      definitionSha256: sha("4"),
      family: "node",
      id: "run_worker_test",
      version: "1.0.0",
    },
    schemaVersion: "0.1",
    scope,
    startedAt,
    status: "running",
    targetRelease,
    workerBuildSha256: sha("5"),
    workerProtocol,
  } as const;
}

function runningJob(): ReplayJob {
  return {
    createdAt: startedAt,
    createdByPrincipalId: "usr_worker_test",
    currentLease: {
      acquiredAt: startedAt,
      attemptSequence: 0,
      expiresAt: "2026-08-30T01:00:02.000Z",
      heartbeatAt: startedAt,
      mutationFence: fence,
      schemaVersion: "0.1",
      scope,
    },
    jobId,
    lastFencingToken: 1,
    latestAttemptSequence: 0,
    plan,
    recoveryEpoch: 0,
    schemaVersion: "0.1",
    scope,
    startedAt,
    stateVersion: 2,
    status: "running",
  };
}

function queuedSnapshot(): ReplayJobSnapshot {
  return {
    attempts: [],
    budgetLedger: [],
    cancellationAcknowledgements: [],
    cancellationRequest: null,
    executionObservations: [],
    job: {
      createdAt: startedAt,
      createdByPrincipalId: "usr_worker_test",
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

function runningSnapshot(overrides: Partial<ReplayJobSnapshot> = {}): ReplayJobSnapshot {
  return {
    attempts: [runningAttempt()],
    budgetLedger: [],
    cancellationAcknowledgements: [],
    cancellationRequest: null,
    executionObservations: [],
    job: runningJob(),
    usageObservations: [],
    ...overrides,
  };
}

function amounts(overrides: Partial<Record<ReplayBudgetDimension, number>> = {}) {
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [dimension, overrides[dimension] ?? 0]),
  ) as ReplayBudgetAmounts;
}

function usage(overrides: Partial<ReplayUsageMeasurements> = {}) {
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [
      dimension,
      overrides[dimension] ?? { amount: 0, source: "measured", status: "observed" },
    ]),
  ) as ReplayUsageMeasurements;
}

function reservation() {
  return ReplayBudgetReservationSchema.parse({
    dimensions: Object.fromEntries(
      REPLAY_BUDGET_DIMENSIONS.map((dimension) => [
        dimension,
        {
          committedBefore: 0,
          limit: 10,
          measurement: "measured",
          reservedAmount: dimension === "jobAttempts" ? 1 : 0,
        },
      ]),
    ),
    entryType: "reservation",
    ledgerSequence: 0,
    mutationFence: fence,
    reservationId: "res_worker_test",
    reservedAt: startedAt,
    schemaVersion: "0.1",
    scope,
    work: { kind: "attempt_start" },
  });
}

function reconciliation() {
  return ReplayBudgetReconciliationSchema.parse({
    dimensions: Object.fromEntries(
      REPLAY_BUDGET_DIMENSIONS.map((dimension) => [
        dimension,
        {
          actualUsage: {
            amount: dimension === "jobAttempts" ? 1 : 0,
            source: "measured",
            status: "observed",
          },
          disposition: "settled",
          overrunAmount: 0,
          releasedAmount: 0,
          reservedAmount: dimension === "jobAttempts" ? 1 : 0,
        },
      ]),
    ),
    entryType: "reconciliation",
    ledgerSequence: 1,
    mutationFence: fence,
    reconciledAt: endedAt,
    reconciliationId: "rec_worker_test",
    reservationId: "res_worker_test",
    schemaVersion: "0.1",
    scope,
  });
}

function cancellationRequest(requestedAt = startedAt) {
  return {
    cancellationId: "can_worker_test",
    jobId,
    reason: "Stop the bounded test worker.",
    reasonCode: "operator_request",
    requestedAt,
    requestedByPrincipalId: "usr_worker_test",
    schemaVersion: "0.1",
    scope,
  } as const;
}

function executionObservation(
  observationSequence: number,
  observationId: string,
  observedAt = endedAt,
) {
  return {
    mutationFence: fence,
    observationId,
    observationSequence,
    observedAt,
    payload: {
      afterCancellationRequest: false,
      evidenceSha256: sha("8"),
      event: "started",
      kind: "target",
    },
    schemaVersion: "0.1",
    scope,
  } as const;
}

function usageObservation(observationSequence: number, observationId: string) {
  return ReplayUsageObservationSchema.parse({
    measurements: [
      {
        dimension: "jobAttempts",
        usage: { amount: 1, source: "measured", status: "observed" },
      },
    ],
    mutationFence: fence,
    observationId,
    observationSequence,
    observedAt: endedAt,
    schemaVersion: "0.1",
    scope,
    sourceEventSha256: sha("7"),
  });
}

describe("PostgresReplayJobWorkerRepository", () => {
  it("reads one detached tenant-scoped snapshot and hides unavailable scope", async () => {
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
    expect(stored.job.createdByPrincipalId).toBe("usr_worker_test");
    visible = false;
    await expect(testHarness.repository.findJob(scope, jobId)).resolves.toBeNull();
  });

  it("fails closed when snapshot authority returns no result row", async () => {
    const testHarness = repository(() => ({ rows: [] }));
    await expect(testHarness.repository.findJob(scope, jobId)).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("accepts exact historical attempt fences after the recovery epoch advances", async () => {
    const completedAttempt = {
      ...runningAttempt(),
      endedAt,
      result: resultArtifact,
      retryDisposition: "not_retryable",
      status: "succeeded",
    } as const;
    const recovered = runningSnapshot({
      attempts: [completedAttempt],
      job: {
        ...runningJob(),
        currentLease: undefined,
        recoveryEpoch: 1,
        stateVersion: 3,
        status: "succeeded",
        terminal: {
          attemptId,
          code: "completed",
          committedAt: endedAt,
          status: "succeeded",
        },
      },
    });
    const testHarness = repository(() => ({ rows: [{ snapshot: recovered }] }));
    await expect(testHarness.repository.findJob(scope, jobId)).resolves.toEqual(recovered);
  });

  it("claims exact worker authority and validates claimed and deferred results", async () => {
    let snapshot: ReplayJobSnapshot = runningSnapshot();
    let claimed = true;
    const testHarness = repository((text, values) => {
      if (text.includes("proofstack_claim_replay_job")) {
        expect(values).toEqual([
          scope.projectId,
          scope.environmentId,
          jobId,
          attemptId,
          fence.leaseId,
          fence.workerId,
          workerProtocol.name,
          workerProtocol.version,
          sha("5"),
          2_000,
        ]);
        return {
          rows: [
            claimed
              ? {
                  attempt: snapshot.attempts[0],
                  claimed: true,
                  job: snapshot.job,
                  reason: null,
                  worker_fence: fence,
                }
              : {
                  attempt: null,
                  claimed: false,
                  job: snapshot.job,
                  reason: "retry_not_ready",
                  worker_fence: null,
                },
          ],
        };
      }
      return { rows: [{ snapshot }] };
    });
    const command = {
      attemptId,
      jobId,
      leaseDurationMilliseconds: 2_000,
      leaseId: fence.leaseId,
      scope,
      workerBuildSha256: sha("5"),
      workerId: fence.workerId,
      workerProtocol,
    } as const;

    await expect(testHarness.repository.claimJob(command)).resolves.toMatchObject({
      claimed: true,
      workerFence: fence,
    });
    claimed = false;
    snapshot = queuedSnapshot();
    await expect(testHarness.repository.claimJob(command)).resolves.toMatchObject({
      claimed: false,
      reason: "retry_not_ready",
    });
  });

  it("rejects an unclaimed job row that disagrees with the durable snapshot", async () => {
    const snapshot = queuedSnapshot();
    const testHarness = repository((text) => {
      if (text.includes("proofstack_claim_replay_job")) {
        return {
          rows: [
            {
              attempt: null,
              claimed: false,
              job: { ...snapshot.job, createdByPrincipalId: "usr_other" },
              reason: "retry_not_ready",
              worker_fence: null,
            },
          ],
        };
      }
      return { rows: [{ snapshot }] };
    });
    await expect(
      testHarness.repository.claimJob({
        attemptId,
        jobId,
        leaseDurationMilliseconds: 2_000,
        leaseId: fence.leaseId,
        scope,
        workerBuildSha256: sha("5"),
        workerId: fence.workerId,
        workerProtocol,
      }),
    ).rejects.toBeInstanceOf(ReplayRepositoryContractError);
  });

  it("persists every fenced worker mutation and cross-checks its snapshot", async () => {
    let snapshot = runningSnapshot();
    let mutationRow: Record<string, unknown> = {};
    const testHarness = repository((text) => {
      if (text.includes("proofstack_read_replay_job_snapshot")) return { rows: [{ snapshot }] };
      if (text.includes("proofstack_heartbeat_replay_job")) {
        return { rows: [{ job: snapshot.job }] };
      }
      if (text.includes("proofstack_complete_replay_job")) {
        return { rows: [{ attempt: snapshot.attempts[0], job: snapshot.job }] };
      }
      return { rows: [{ created: true, ...mutationRow }] };
    });

    await expect(
      testHarness.repository.heartbeatJob({
        leaseDurationMilliseconds: 2_000,
        scope,
        workerFence: fence,
      }),
    ).resolves.toEqual(snapshot);

    const cancellationRequest = {
      cancellationId: "can_worker_test",
      jobId,
      reason: "Stop the bounded test worker.",
      reasonCode: "operator_request",
      requestedAt: startedAt,
      requestedByPrincipalId: "usr_worker_test",
      schemaVersion: "0.1",
      scope,
    } as const;
    const acknowledgement = {
      acknowledgementId: "ack_worker_test",
      acknowledgedAt: endedAt,
      action: "stop_requested",
      cancellationId: cancellationRequest.cancellationId,
      mutationFence: fence,
      schemaVersion: "0.1",
      scope,
    } as const;
    snapshot = runningSnapshot({
      cancellationAcknowledgements: [acknowledgement],
      cancellationRequest,
    });
    mutationRow = { acknowledgement };
    await expect(
      testHarness.repository.acknowledgeCancellation({
        acknowledgementId: acknowledgement.acknowledgementId,
        action: acknowledgement.action,
        scope,
        workerFence: fence,
      }),
    ).resolves.toEqual(snapshot);

    const reserved = reservation();
    snapshot = runningSnapshot({ budgetLedger: [reserved] });
    mutationRow = { reservation: reserved };
    await expect(
      testHarness.repository.reserveBudget({
        requested: amounts({ jobAttempts: 1 }),
        reservationId: reserved.reservationId,
        scope,
        work: reserved.work,
        workerFence: fence,
      }),
    ).resolves.toEqual(snapshot);

    const reconciled = reconciliation();
    snapshot = runningSnapshot({ budgetLedger: [reserved, reconciled] });
    mutationRow = { reconciliation: reconciled };
    await expect(
      testHarness.repository.reconcileBudget({
        reconciliationId: reconciled.reconciliationId,
        reservationId: reserved.reservationId,
        scope,
        usage: usage({
          jobAttempts: { amount: 1, source: "measured", status: "observed" },
        }),
        workerFence: fence,
      }),
    ).resolves.toEqual(snapshot);

    const executionObservation = {
      mutationFence: fence,
      observationId: "obs_worker_execution",
      observationSequence: 0,
      observedAt: endedAt,
      payload: {
        afterCancellationRequest: false,
        evidenceSha256: sha("6"),
        event: "started",
        kind: "target",
      },
      schemaVersion: "0.1",
      scope,
    } as const;
    snapshot = runningSnapshot({ executionObservations: [executionObservation] });
    mutationRow = { observation: executionObservation };
    await expect(
      testHarness.repository.appendExecutionObservation({
        observationId: executionObservation.observationId,
        payload: executionObservation.payload,
        scope,
        workerFence: fence,
      }),
    ).resolves.toEqual(snapshot);

    const usageObservation = ReplayUsageObservationSchema.parse({
      measurements: [
        {
          dimension: "jobAttempts",
          usage: { amount: 1, source: "measured", status: "observed" },
        },
      ],
      mutationFence: fence,
      observationId: "obs_worker_usage",
      observationSequence: 0,
      observedAt: endedAt,
      schemaVersion: "0.1",
      scope,
      sourceEventSha256: sha("7"),
    });
    snapshot = runningSnapshot({ usageObservations: [usageObservation] });
    mutationRow = { observation: usageObservation };
    await expect(
      testHarness.repository.appendUsageObservation({
        measurements: usageObservation.measurements,
        observationId: usageObservation.observationId,
        scope,
        sourceEventSha256: usageObservation.sourceEventSha256,
        workerFence: fence,
      }),
    ).resolves.toEqual(snapshot);

    const completedAttempt = {
      ...runningAttempt(),
      endedAt,
      result: resultArtifact,
      retryDisposition: "not_retryable",
      status: "succeeded",
    } as const;
    const completedJob = {
      ...runningJob(),
      currentLease: undefined,
      stateVersion: 3,
      status: "succeeded",
      terminal: {
        attemptId,
        code: "completed",
        committedAt: endedAt,
        status: "succeeded",
      },
    } as const;
    snapshot = runningSnapshot({ attempts: [completedAttempt], job: completedJob });
    await expect(
      testHarness.repository.completeJob({
        code: "completed",
        result: resultArtifact,
        scope,
        status: "succeeded",
        workerFence: fence,
      }),
    ).resolves.toEqual(snapshot);
  });

  it.each([
    ["non-object payload", () => "invalid"],
    ["missing key", () => ({ ...queuedSnapshot(), attempts: undefined })],
    ["extra key", () => ({ ...queuedSnapshot(), unexpected: true })],
    ["non-array attempts", () => ({ ...queuedSnapshot(), attempts: {} })],
    [
      "wrong scope",
      () => ({
        ...queuedSnapshot(),
        job: {
          ...queuedSnapshot().job,
          scope: { ...scope, projectId: "prj_other" },
        },
      }),
    ],
    [
      "attempt gap",
      () => ({
        ...runningSnapshot(),
        attempts: [{ ...runningAttempt(), attemptSequence: 1 }],
      }),
    ],
    [
      "duplicate attempt identifiers",
      () => ({
        ...runningSnapshot(),
        attempts: [runningAttempt(), runningAttempt()],
      }),
    ],
    [
      "duplicate lease identifiers",
      () => ({
        ...runningSnapshot(),
        attempts: [
          runningAttempt(),
          {
            ...runningAttempt(),
            attemptId: "att_worker_second",
            attemptSequence: 1,
            mutationFence: {
              ...fence,
              attemptId: "att_worker_second",
              fencingToken: 2,
            },
          },
        ],
      }),
    ],
    [
      "attempt plan mismatch",
      () => ({
        ...runningSnapshot(),
        attempts: [
          {
            ...runningAttempt(),
            plan: { ...plan, definitionSha256: sha("8") },
          },
        ],
      }),
    ],
    [
      "terminal latest attempt under an active lease",
      () => ({
        ...runningSnapshot(),
        attempts: [
          {
            ...runningAttempt(),
            endedAt,
            result: resultArtifact,
            retryDisposition: "not_retryable",
            status: "succeeded",
          },
        ],
      }),
    ],
    [
      "unknown fence",
      () => ({
        ...runningSnapshot(),
        job: {
          ...runningJob(),
          currentLease: {
            ...runningJob().currentLease,
            mutationFence: { ...fence, fencingToken: 2 },
          },
        },
      }),
    ],
    [
      "unknown terminal attempt",
      () => ({
        ...runningSnapshot(),
        job: {
          ...runningJob(),
          currentLease: undefined,
          status: "succeeded",
          terminal: {
            attemptId: "att_worker_unknown",
            code: "completed",
            committedAt: endedAt,
            status: "succeeded",
          },
        },
      }),
    ],
    [
      "terminal commit before attempt completion",
      () => ({
        ...runningSnapshot(),
        attempts: [
          {
            ...runningAttempt(),
            endedAt,
            result: resultArtifact,
            retryDisposition: "not_retryable",
            status: "succeeded",
          },
        ],
        job: {
          ...runningJob(),
          currentLease: undefined,
          status: "succeeded",
          terminal: {
            attemptId,
            code: "completed",
            committedAt: startedAt,
            status: "succeeded",
          },
        },
      }),
    ],
    [
      "budget sequence gap",
      () => ({
        ...runningSnapshot(),
        budgetLedger: [{ ...reservation(), ledgerSequence: 1 }],
      }),
    ],
    [
      "duplicate budget reservation identifiers",
      () => ({
        ...runningSnapshot(),
        budgetLedger: [reservation(), { ...reservation(), ledgerSequence: 1 }],
      }),
    ],
    [
      "reconciliation without a reservation",
      () => ({
        ...runningSnapshot(),
        budgetLedger: [{ ...reconciliation(), ledgerSequence: 0 }],
      }),
    ],
    [
      "duplicate budget reconciliation identifiers",
      () => ({
        ...runningSnapshot(),
        budgetLedger: [
          reservation(),
          { ...reconciliation(), reconciliationId: "rec_worker_duplicate" },
          {
            ...reservation(),
            ledgerSequence: 2,
            reservationId: "res_worker_second",
          },
          {
            ...reconciliation(),
            ledgerSequence: 3,
            reconciliationId: "rec_worker_duplicate",
            reservationId: "res_worker_second",
          },
        ],
      }),
    ],
    [
      "cancellation terminal without a request",
      () => ({
        ...queuedSnapshot(),
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
      }),
    ],
    [
      "cancellation request before job creation",
      () => ({
        ...runningSnapshot(),
        cancellationRequest: cancellationRequest("2026-08-29T01:00:00.000Z"),
      }),
    ],
    [
      "cancellation scope mismatch",
      () => ({
        ...runningSnapshot(),
        cancellationRequest: {
          cancellationId: "can_worker_invalid",
          jobId,
          reason: "Stop this bounded worker.",
          reasonCode: "operator_request",
          requestedAt: startedAt,
          requestedByPrincipalId: "usr_worker_test",
          schemaVersion: "0.1",
          scope: { ...scope, environmentId: "env_other" },
        },
      }),
    ],
    [
      "acknowledgement without request",
      () => ({
        ...runningSnapshot(),
        cancellationAcknowledgements: [
          {
            acknowledgementId: "ack_worker_invalid",
            acknowledgedAt: endedAt,
            action: "stop_requested",
            cancellationId: "can_worker_invalid",
            mutationFence: fence,
            schemaVersion: "0.1",
            scope,
          },
        ],
      }),
    ],
    [
      "duplicate acknowledgement identifiers",
      () => ({
        ...runningSnapshot(),
        cancellationAcknowledgements: [
          {
            acknowledgementId: "ack_worker_duplicate",
            acknowledgedAt: endedAt,
            action: "stop_requested",
            cancellationId: "can_worker_test",
            mutationFence: fence,
            schemaVersion: "0.1",
            scope,
          },
          {
            acknowledgementId: "ack_worker_duplicate",
            acknowledgedAt: endedAt,
            action: "stop_requested",
            cancellationId: "can_worker_test",
            mutationFence: fence,
            schemaVersion: "0.1",
            scope,
          },
        ],
        cancellationRequest: cancellationRequest(),
      }),
    ],
    [
      "acknowledgement before its request",
      () => ({
        ...runningSnapshot(),
        cancellationAcknowledgements: [
          {
            acknowledgementId: "ack_worker_early",
            acknowledgedAt: startedAt,
            action: "stop_requested",
            cancellationId: "can_worker_test",
            mutationFence: fence,
            schemaVersion: "0.1",
            scope,
          },
        ],
        cancellationRequest: cancellationRequest(endedAt),
      }),
    ],
    [
      "unordered acknowledgements",
      () => ({
        ...runningSnapshot(),
        cancellationAcknowledgements: [
          {
            acknowledgementId: "ack_worker_second",
            acknowledgedAt: "2026-08-30T01:00:00.500Z",
            action: "stop_requested",
            cancellationId: "can_worker_test",
            mutationFence: fence,
            schemaVersion: "0.1",
            scope,
          },
          {
            acknowledgementId: "ack_worker_first",
            acknowledgedAt: "2026-08-30T01:00:00.250Z",
            action: "stop_requested",
            cancellationId: "can_worker_test",
            mutationFence: fence,
            schemaVersion: "0.1",
            scope,
          },
        ],
        cancellationRequest: cancellationRequest(),
      }),
    ],
    [
      "observation sequence gap",
      () => ({
        ...runningSnapshot(),
        executionObservations: [
          {
            mutationFence: fence,
            observationId: "obs_worker_invalid",
            observationSequence: 1,
            observedAt: endedAt,
            payload: {
              afterCancellationRequest: false,
              evidenceSha256: sha("8"),
              event: "started",
              kind: "target",
            },
            schemaVersion: "0.1",
            scope,
          },
        ],
      }),
    ],
    [
      "duplicate observation identifiers",
      () => ({
        ...runningSnapshot(),
        executionObservations: [
          executionObservation(0, "obs_worker_duplicate"),
          executionObservation(1, "obs_worker_duplicate"),
        ],
      }),
    ],
    [
      "unordered execution observations",
      () => ({
        ...runningSnapshot(),
        executionObservations: [
          executionObservation(1, "obs_worker_second"),
          executionObservation(0, "obs_worker_first"),
        ],
      }),
    ],
    [
      "unordered usage observations",
      () => ({
        ...runningSnapshot(),
        usageObservations: [
          usageObservation(1, "obs_worker_usage_second"),
          usageObservation(0, "obs_worker_usage_first"),
        ],
      }),
    ],
    [
      "observation before attempt start",
      () => ({
        ...runningSnapshot(),
        executionObservations: [
          executionObservation(0, "obs_worker_early", "2026-08-29T01:00:00.000Z"),
        ],
      }),
    ],
    [
      "cancellation observation without request",
      () => ({
        ...runningSnapshot(),
        executionObservations: [
          {
            mutationFence: fence,
            observationId: "obs_worker_cancel_invalid",
            observationSequence: 0,
            observedAt: endedAt,
            payload: {
              cancellationId: "can_worker_invalid",
              event: "request_observed",
              evidenceSha256: sha("8"),
              kind: "cancellation",
            },
            schemaVersion: "0.1",
            scope,
          },
        ],
      }),
    ],
  ])("fails closed for a stored snapshot with %s", async (_label, build) => {
    const testHarness = repository(() => ({ rows: [{ snapshot: build() }] }));
    await expect(testHarness.repository.findJob(scope, jobId)).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it.each([
    ["P0002", "Replay job is unavailable", ReplayJobNotFoundError],
    ["23503", "Replay job has no exact published plan", ReplayDefinitionLineageError],
    ["23505", "Replay attempt identifier is already in use", ReplayJobConflictError],
    ["55000", "Replay worker mutation fence is stale", DurableReplayStateError],
    ["40001", "Replay job changed during claim", DurableReplayStateError],
    ["22003", "Replay job counter is exhausted", DurableReplayStateError],
    [
      "23514",
      "Replay worker protocol does not match the published plan",
      ReplayDefinitionLineageError,
    ],
    [
      "22023",
      "Replay lease duration exceeds the published attempt timeout",
      ReplayJobConflictError,
    ],
  ])("maps PostgreSQL %s failures to domain errors", async (code, message, ExpectedError) => {
    const testHarness = repository((text) => {
      if (text.includes("proofstack_claim_replay_job")) {
        throw Object.assign(new Error(message), { code });
      }
      return { rows: [] };
    });
    await expect(
      testHarness.repository.claimJob({
        attemptId,
        jobId,
        leaseDurationMilliseconds: 2_000,
        leaseId: fence.leaseId,
        scope,
        workerBuildSha256: sha("5"),
        workerId: fence.workerId,
        workerProtocol,
      }),
    ).rejects.toBeInstanceOf(ExpectedError);
  });

  it("rejects invalid local accounting and lease inputs before acquiring a connection", async () => {
    const testHarness = repository(() => ({ rows: [] }));
    await expect(
      testHarness.repository.heartbeatJob({
        leaseDurationMilliseconds: 0,
        scope,
        workerFence: fence,
      }),
    ).rejects.toBeInstanceOf(ReplayJobConflictError);
    await expect(
      testHarness.repository.reserveBudget({
        requested: { jobAttempts: 1 } as ReplayBudgetAmounts,
        reservationId: "res_worker_invalid",
        scope,
        work: { kind: "attempt_start" },
        workerFence: fence,
      }),
    ).rejects.toBeInstanceOf(DurableReplayAccountingError);
    await expect(
      testHarness.repository.reserveBudget({
        requested: amounts({ jobAttempts: -1 }),
        reservationId: "res_worker_negative",
        scope,
        work: { kind: "attempt_start" },
        workerFence: fence,
      }),
    ).rejects.toBeInstanceOf(DurableReplayAccountingError);
    await expect(
      testHarness.repository.reconcileBudget({
        reconciliationId: "rec_worker_invalid",
        reservationId: "res_worker_test",
        scope,
        usage: {
          jobAttempts: { amount: 1, source: "measured", status: "observed" },
        } as ReplayUsageMeasurements,
        workerFence: fence,
      }),
    ).rejects.toBeInstanceOf(DurableReplayAccountingError);
    await expect(
      testHarness.repository.heartbeatJob({
        leaseDurationMilliseconds: 86_400_001,
        scope,
        workerFence: fence,
      }),
    ).rejects.toBeInstanceOf(ReplayJobConflictError);
  });

  it("maps missing mutation prerequisites and open accounting without hiding their meaning", async () => {
    let failure = Object.assign(new Error("Replay cancellation request is unavailable"), {
      code: "P0002",
    });
    const testHarness = repository(() => {
      throw failure;
    });
    await expect(
      testHarness.repository.acknowledgeCancellation({
        acknowledgementId: "ack_worker_missing",
        action: "stop_requested",
        scope,
        workerFence: fence,
      }),
    ).rejects.toBeInstanceOf(ReplayJobConflictError);

    failure = Object.assign(
      new Error("Replay completion requires every budget reservation to be reconciled"),
      { code: "55000" },
    );
    await expect(
      testHarness.repository.completeJob({
        code: "completed",
        result: resultArtifact,
        scope,
        status: "succeeded",
        workerFence: fence,
      }),
    ).rejects.toBeInstanceOf(DurableReplayAccountingError);
  });
});
