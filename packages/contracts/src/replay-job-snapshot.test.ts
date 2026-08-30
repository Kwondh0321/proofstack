import { describe, expect, it } from "vitest";
import { REPLAY_BUDGET_DIMENSIONS, type ReplayBudgetDimension } from "./replay-accounting.js";
import { type ReplayJobSnapshot, ReplayJobSnapshotSchema } from "./replay-job-snapshot.js";

const scope = {
  environmentId: "env_snapshot_test",
  projectId: "prj_snapshot_test",
  tenantId: "ten_snapshot_test",
} as const;
const plan = {
  definitionSha256: "1".repeat(64),
  planId: "plan_snapshot_test",
  planVersionId: "plv_snapshot_test",
} as const;
const workerProtocol = { name: "proofstack.replay-worker", version: "1.0.0" } as const;
const createdAt = "2026-08-30T01:00:00.000Z";
const startedAt = "2026-08-30T01:00:01.000Z";
const requestedAt = "2026-08-30T01:00:02.000Z";
const observedAt = "2026-08-30T01:00:03.000Z";
const endedAt = "2026-08-30T01:00:04.000Z";
const jobId = "job_snapshot_test";
const attemptId = "att_snapshot_test";
const fence = {
  attemptId,
  fencingToken: 1,
  jobId,
  leaseId: "lease_snapshot_test",
  recoveryEpoch: 0,
  workerId: "wrk_snapshot_test",
} as const;

function queuedSnapshot(): ReplayJobSnapshot {
  return {
    attempts: [],
    budgetLedger: [],
    cancellationAcknowledgements: [],
    cancellationRequest: null,
    executionObservations: [],
    job: {
      createdAt,
      createdByPrincipalId: "usr_snapshot_test",
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

function reservationDimensions() {
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [
      dimension,
      {
        committedBefore: 0,
        limit: 10,
        measurement: "measured" as const,
        reservedAmount: 1,
      },
    ]),
  ) as Record<
    ReplayBudgetDimension,
    {
      readonly committedBefore: number;
      readonly limit: number;
      readonly measurement: "measured";
      readonly reservedAmount: number;
    }
  >;
}

function reconciliationDimensions() {
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [
      dimension,
      {
        actualUsage: { amount: 1, source: "measured" as const, status: "observed" as const },
        disposition: "settled" as const,
        overrunAmount: 0,
        releasedAmount: 0,
        reservedAmount: 1,
      },
    ]),
  ) as Record<
    ReplayBudgetDimension,
    {
      readonly actualUsage: {
        readonly amount: number;
        readonly source: "measured";
        readonly status: "observed";
      };
      readonly disposition: "settled";
      readonly overrunAmount: number;
      readonly releasedAmount: number;
      readonly reservedAmount: number;
    }
  >;
}

function runningSnapshot(): ReplayJobSnapshot {
  const cancellationRequest = {
    cancellationId: "can_snapshot_test",
    jobId,
    reason: "Stop this bounded replay safely.",
    reasonCode: "operator_request" as const,
    requestedAt,
    requestedByPrincipalId: "usr_snapshot_test",
    schemaVersion: "0.1" as const,
    scope,
  };
  return {
    attempts: [
      {
        attemptId,
        attemptSequence: 0,
        isolationProfile: {
          definitionSha256: "2".repeat(64),
          id: "iso_snapshot_test",
          kind: "local_child_process",
          version: "1.0.0",
        },
        jobId,
        mutationFence: fence,
        plan,
        runtimeProfile: {
          definitionSha256: "3".repeat(64),
          family: "node",
          id: "run_snapshot_test",
          version: "1.0.0",
        },
        schemaVersion: "0.1",
        scope,
        startedAt,
        status: "running",
        targetRelease: {
          definitionSha256: "4".repeat(64),
          targetAdapter: {
            name: "proofstack.test",
            protocolVersion: "1.0.0",
            version: "1.0.0",
          },
          targetId: "target_snapshot_test",
          targetReleaseId: "trg_snapshot_test",
          workerProtocol,
        },
        workerBuildSha256: "5".repeat(64),
        workerProtocol,
      },
    ],
    budgetLedger: [
      {
        dimensions: reservationDimensions(),
        entryType: "reservation",
        ledgerSequence: 0,
        mutationFence: fence,
        reservationId: "res_snapshot_test",
        reservedAt: startedAt,
        schemaVersion: "0.1",
        scope,
        work: { kind: "attempt_start" },
      },
      {
        dimensions: reconciliationDimensions(),
        entryType: "reconciliation",
        ledgerSequence: 1,
        mutationFence: fence,
        reconciledAt: observedAt,
        reconciliationId: "rec_snapshot_test",
        reservationId: "res_snapshot_test",
        schemaVersion: "0.1",
        scope,
      },
    ],
    cancellationAcknowledgements: [
      {
        acknowledgedAt: observedAt,
        acknowledgementId: "ack_snapshot_1",
        action: "stop_requested",
        cancellationId: cancellationRequest.cancellationId,
        mutationFence: fence,
        schemaVersion: "0.1",
        scope,
      },
      {
        acknowledgedAt: observedAt,
        acknowledgementId: "ack_snapshot_2",
        action: "stop_requested",
        cancellationId: cancellationRequest.cancellationId,
        mutationFence: fence,
        schemaVersion: "0.1",
        scope,
      },
    ],
    cancellationRequest,
    executionObservations: [
      {
        mutationFence: fence,
        observationId: "obs_snapshot_0",
        observationSequence: 0,
        observedAt,
        payload: {
          cancellationId: cancellationRequest.cancellationId,
          event: "request_observed",
          evidenceSha256: "6".repeat(64),
          kind: "cancellation",
        },
        schemaVersion: "0.1",
        scope,
      },
      {
        mutationFence: fence,
        observationId: "obs_snapshot_2",
        observationSequence: 2,
        observedAt,
        payload: {
          afterCancellationRequest: true,
          evidenceSha256: "7".repeat(64),
          event: "started",
          kind: "target",
        },
        schemaVersion: "0.1",
        scope,
      },
    ],
    job: {
      createdAt,
      createdByPrincipalId: "usr_snapshot_test",
      currentLease: {
        acquiredAt: startedAt,
        attemptSequence: 0,
        expiresAt: "2026-08-30T01:01:00.000Z",
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
      stateVersion: 3,
      status: "running",
    },
    usageObservations: [
      {
        measurements: [
          {
            dimension: "elapsedMilliseconds",
            usage: { amount: 2, source: "measured", status: "observed" },
          },
        ],
        mutationFence: fence,
        observationId: "obs_snapshot_1",
        observationSequence: 1,
        observedAt,
        schemaVersion: "0.1",
        scope,
        sourceEventSha256: "8".repeat(64),
      },
    ],
  };
}

function completedSnapshot(): ReplayJobSnapshot {
  const running = runningSnapshot();
  const attempt = requireValue(running.attempts[0], "running attempt");
  return {
    ...running,
    attempts: [
      {
        ...attempt,
        endedAt,
        result: {
          artifactId: "art_snapshot_result",
          classification: "confidential",
          mediaType: "application/json",
          sha256: "9".repeat(64),
          sizeBytes: 12,
        },
        retryDisposition: "not_retryable",
        status: "succeeded",
      },
    ],
    job: {
      ...running.job,
      currentLease: undefined,
      stateVersion: 4,
      status: "succeeded",
      terminal: {
        attemptId,
        code: "completed",
        committedAt: endedAt,
        status: "succeeded",
      },
    },
  };
}

function rejects(input: unknown): void {
  expect(ReplayJobSnapshotSchema.safeParse(input).success).toBe(false);
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}

describe("ReplayJobSnapshotSchema", () => {
  it("accepts exact queued, running, and completed snapshots", () => {
    expect(ReplayJobSnapshotSchema.parse(queuedSnapshot())).toEqual(queuedSnapshot());
    expect(ReplayJobSnapshotSchema.parse(runningSnapshot())).toEqual(runningSnapshot());
    expect(ReplayJobSnapshotSchema.parse(completedSnapshot())).toEqual(completedSnapshot());
  });

  it("rejects unknown fields and inconsistent attempt history", () => {
    rejects({ ...queuedSnapshot(), unknown: true });
    const running = runningSnapshot();
    const attempt = requireValue(running.attempts[0], "running attempt");
    const lease = requireValue(running.job.currentLease, "current lease");
    rejects({ ...running, attempts: [attempt, attempt] });
    rejects({
      ...running,
      attempts: [{ ...attempt, attemptSequence: 1 }],
    });
    rejects({
      ...running,
      attempts: [{ ...attempt, plan: { ...plan, planId: "plan_other" } }],
    });
    rejects({
      ...running,
      job: {
        ...running.job,
        currentLease: {
          ...lease,
          mutationFence: { ...fence, workerId: "wrk_other" },
        },
      },
    });
    const completed = completedSnapshot();
    const terminal = requireValue(completed.job.terminal, "terminal record");
    rejects({
      ...completed,
      job: {
        ...completed.job,
        terminal: { ...terminal, attemptId: "att_unknown" },
      },
    });
  });

  it("rejects inconsistent budget history", () => {
    const running = runningSnapshot();
    const firstLedgerEntry = requireValue(running.budgetLedger[0], "first ledger entry");
    rejects({
      ...running,
      budgetLedger: [{ ...firstLedgerEntry, ledgerSequence: 1 }],
    });
    rejects({
      ...running,
      budgetLedger: [firstLedgerEntry, firstLedgerEntry],
    });
    const reservation = running.budgetLedger[0];
    if (reservation?.entryType !== "reservation") throw new Error("Expected reservation");
    rejects({
      ...running,
      budgetLedger: [
        {
          ...reservation,
          dimensions: {
            ...reservation.dimensions,
            elapsedMilliseconds: {
              ...reservation.dimensions.elapsedMilliseconds,
              committedBefore: 1,
            },
          },
        },
      ],
    });
    const reconciliation = running.budgetLedger[1];
    if (reconciliation?.entryType !== "reconciliation") {
      throw new Error("Expected reconciliation");
    }
    rejects({ ...running, budgetLedger: [{ ...reconciliation, ledgerSequence: 0 }] });
    rejects({
      ...running,
      budgetLedger: [reservation, reconciliation, { ...reconciliation, ledgerSequence: 2 }],
    });
    rejects({
      ...running,
      budgetLedger: [
        reservation,
        {
          ...reconciliation,
          dimensions: {
            ...reconciliation.dimensions,
            elapsedMilliseconds: {
              ...reconciliation.dimensions.elapsedMilliseconds,
              reservedAmount: 2,
            },
          },
        },
      ],
    });
  });

  it("rejects cancellation state without exact request, scope, fence, and order", () => {
    const running = runningSnapshot();
    const cancellationRequest = requireValue(running.cancellationRequest, "cancellation request");
    const firstAcknowledgement = requireValue(
      running.cancellationAcknowledgements[0],
      "first cancellation acknowledgement",
    );
    const secondAcknowledgement = requireValue(
      running.cancellationAcknowledgements[1],
      "second cancellation acknowledgement",
    );
    rejects({
      ...running,
      cancellationRequest: { ...cancellationRequest, jobId: "job_other" },
    });
    const queued = queuedSnapshot();
    rejects({
      ...queued,
      job: {
        ...queued.job,
        stateVersion: 2,
        status: "cancelled",
        terminal: {
          code: "cancellation_committed",
          committedAt: endedAt,
          status: "cancelled",
        },
      },
    });
    rejects({
      ...running,
      cancellationAcknowledgements: [firstAcknowledgement, firstAcknowledgement],
    });
    rejects({
      ...running,
      cancellationAcknowledgements: [secondAcknowledgement, firstAcknowledgement],
    });
    rejects({
      ...running,
      cancellationAcknowledgements: [
        {
          ...firstAcknowledgement,
          mutationFence: { ...fence, workerId: "wrk_other" },
        },
      ],
    });
  });

  it("rejects observation duplication, gaps, order, causality, and cancellation drift", () => {
    const running = runningSnapshot();
    const firstExecutionObservation = requireValue(
      running.executionObservations[0],
      "first execution observation",
    );
    const secondExecutionObservation = requireValue(
      running.executionObservations[1],
      "second execution observation",
    );
    const usageObservation = requireValue(running.usageObservations[0], "usage observation");
    rejects({
      ...running,
      usageObservations: [
        {
          ...usageObservation,
          observationId: firstExecutionObservation.observationId,
        },
      ],
    });
    rejects({
      ...running,
      executionObservations: [secondExecutionObservation, firstExecutionObservation],
    });
    rejects({
      ...running,
      usageObservations: [{ ...usageObservation, observationSequence: 3 }],
    });
    rejects({
      ...running,
      executionObservations: [
        {
          ...firstExecutionObservation,
          observedAt: createdAt,
        },
        secondExecutionObservation,
      ],
    });
    const cancellationObservation = firstExecutionObservation;
    if (cancellationObservation.payload.kind !== "cancellation") {
      throw new Error("Expected cancellation observation");
    }
    rejects({
      ...running,
      executionObservations: [
        {
          ...cancellationObservation,
          payload: { ...cancellationObservation.payload, cancellationId: "can_other" },
        },
        secondExecutionObservation,
      ],
    });
  });
});
