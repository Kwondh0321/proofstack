import type {
  ReplayCancellationAcknowledgement,
  ReplayCancellationRequest,
  ReplayWorkerMutationFence,
} from "@proofstack/contracts";
import type { ReplayJobRepository, ReplayJobSnapshot } from "@proofstack/replay";
import { describe, expect, it, vi } from "vitest";
import { acknowledgeReplayAttemptCancellation } from "./attempt-cancellation.js";

const scope = {
  environmentId: "env_cancel",
  projectId: "prj_cancel",
  tenantId: "ten_cancel",
} as const;

const workerFence: ReplayWorkerMutationFence = {
  attemptId: "att_cancel_001",
  fencingToken: 13,
  jobId: "job_cancel_001",
  leaseId: "lea_cancel_001",
  recoveryEpoch: 0,
  workerId: "wrk_cancel_001",
};

const cancellation: ReplayCancellationRequest = {
  cancellationId: "can_cancel_001",
  jobId: workerFence.jobId,
  reason: "Operator requested a safe stop",
  reasonCode: "operator_request",
  requestedAt: "2026-08-30T00:00:00.000Z",
  requestedByPrincipalId: "usr_cancel",
  schemaVersion: "0.1",
  scope,
};

function snapshot(
  overrides: {
    readonly cancellation?: unknown;
    readonly job?: Readonly<Record<string, unknown>>;
  } = {},
): ReplayJobSnapshot {
  return {
    attempts: [],
    budgetLedger: [],
    cancellationAcknowledgements: [],
    cancellationRequest:
      overrides.cancellation === undefined ? cancellation : overrides.cancellation,
    executionObservations: [],
    job: {
      currentLease: { mutationFence: workerFence },
      jobId: workerFence.jobId,
      scope,
      ...overrides.job,
    },
    usageObservations: [],
  } as unknown as ReplayJobSnapshot;
}

function repository(returned: ReplayJobSnapshot, order: string[] = []) {
  const acknowledgeCancellation = vi.fn(
    async (_command: Parameters<ReplayJobRepository["acknowledgeCancellation"]>[0]) => {
      order.push("acknowledge");
      return returned;
    },
  );
  const appendExecutionObservation = vi.fn(
    async (_command: Parameters<ReplayJobRepository["appendExecutionObservation"]>[0]) => {
      order.push("observe");
      return returned;
    },
  );
  const heartbeatJob = vi.fn(
    async (_command: Parameters<ReplayJobRepository["heartbeatJob"]>[0]) => {
      order.push("heartbeat");
      return returned;
    },
  );
  const mocks = { acknowledgeCancellation, appendExecutionObservation, heartbeatJob };
  return mocks as typeof mocks & ReplayJobRepository;
}

describe("acknowledgeReplayAttemptCancellation", () => {
  it("persists request and action evidence before acknowledging each cancellation outcome", async () => {
    const expectedEvents = {
      observed_after_uninterruptible_completion: "late_completion_observed",
      stop_requested: "stop_requested",
      stopped_before_target_start: "stopped_before_target_start",
    } as const;
    for (const action of Object.keys(
      expectedEvents,
    ) as ReplayCancellationAcknowledgement["action"][]) {
      const current = snapshot();
      const order: string[] = [];
      const firstRepository = repository(current, order);
      await expect(
        acknowledgeReplayAttemptCancellation({
          action,
          leaseDurationMilliseconds: 1_000,
          repository: firstRepository,
          scope,
          snapshot: current,
          workerFence,
        }),
      ).resolves.toBe(current);
      expect(order).toEqual([
        "heartbeat",
        "observe",
        "heartbeat",
        "observe",
        "heartbeat",
        "acknowledge",
      ]);
      expect(
        firstRepository.appendExecutionObservation.mock.calls.map(([command]) =>
          command.payload.kind === "cancellation" ? command.payload.event : "unexpected",
        ),
      ).toEqual(["request_observed", expectedEvents[action]]);
      expect(JSON.stringify(firstRepository.appendExecutionObservation.mock.calls)).not.toContain(
        cancellation.reason,
      );

      const retryRepository = repository(current);
      await acknowledgeReplayAttemptCancellation({
        action,
        leaseDurationMilliseconds: 1_000,
        repository: retryRepository,
        scope,
        snapshot: current,
        workerFence,
      });
      expect(
        retryRepository.appendExecutionObservation.mock.calls.map(
          ([command]) => command.observationId,
        ),
      ).toEqual(
        firstRepository.appendExecutionObservation.mock.calls.map(
          ([command]) => command.observationId,
        ),
      );
      expect(retryRepository.acknowledgeCancellation.mock.calls[0]?.[0].acknowledgementId).toBe(
        firstRepository.acknowledgeCancellation.mock.calls[0]?.[0].acknowledgementId,
      );
    }
  });

  it("rejects invalid lease policy before any mutation", async () => {
    const current = snapshot();
    for (const leaseDurationMilliseconds of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalidRepository = repository(current);
      await expect(
        acknowledgeReplayAttemptCancellation({
          action: "stop_requested",
          leaseDurationMilliseconds,
          repository: invalidRepository,
          scope,
          snapshot: current,
          workerFence,
        }),
      ).rejects.toMatchObject({ code: "invalid_lease_policy" });
      expect(invalidRepository.heartbeatJob).not.toHaveBeenCalled();
    }
  });

  it("rejects missing, malformed, cross-scope, and stale cancellation authority", async () => {
    const cases: readonly {
      readonly action?: unknown;
      readonly current: ReplayJobSnapshot;
      readonly currentScope?: unknown;
    }[] = [
      { current: snapshot({ cancellation: null }) },
      { current: snapshot({ cancellation: { nope: true } }) },
      {
        current: snapshot({
          cancellation: { ...cancellation, jobId: "job_other" },
        }),
      },
      { current: snapshot({ job: { jobId: "job_other" } }) },
      {
        current: snapshot({ job: { scope: { ...scope, projectId: "prj_other" } } }),
      },
      {
        current: snapshot({
          cancellation: { ...cancellation, scope: { ...scope, environmentId: "env_other" } },
        }),
      },
      { current: snapshot({ job: { currentLease: undefined } }) },
      { action: "invented", current: snapshot() },
      { current: snapshot(), currentScope: { tenantId: "invalid" } },
    ];
    for (const testCase of cases) {
      const invalidRepository = repository(testCase.current);
      await expect(
        acknowledgeReplayAttemptCancellation({
          action: (testCase.action ?? "stop_requested") as never,
          leaseDurationMilliseconds: 1_000,
          repository: invalidRepository,
          scope: testCase.currentScope ?? scope,
          snapshot: testCase.current,
          workerFence,
        }),
      ).rejects.toMatchObject({ code: "invalid_cancellation_context" });
      expect(invalidRepository.heartbeatJob).not.toHaveBeenCalled();
    }
  });
});
