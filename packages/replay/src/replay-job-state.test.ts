import type {
  EvidenceScope,
  ReplayAttempt,
  ReplayJob,
  ReplayWorkerMutationFence,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { DurableReplayStateError, type DurableReplayStateErrorCode } from "./errors.js";
import {
  acknowledgeReplayCancellation,
  type ClaimReplayJobOptions,
  claimReplayJob,
  completeReplayAttempt,
  createQueuedReplayJob,
  heartbeatReplayJob,
  requestReplayCancellation,
} from "./replay-job-state.js";

const sha = (digit: string): string => digit.repeat(64);

const scope: EvidenceScope = {
  environmentId: "env_state",
  projectId: "prj_state",
  tenantId: "ten_state",
};

const workerProtocol = { name: "proofstack.replay-worker", version: "1.0.0" };
const targetRelease = {
  definitionSha256: sha("1"),
  targetAdapter: {
    name: "proofstack.reference_target",
    protocolVersion: "1.0.0",
    version: "1.0.0",
  },
  targetId: "target_state",
  targetReleaseId: "trg_state_001",
  workerProtocol,
};

function queuedJob(): ReplayJob {
  return createQueuedReplayJob({
    createdAt: "2026-08-29T00:00:00.000Z",
    createdByPrincipalId: "usr_state",
    request: {
      jobId: "job_state_001",
      plan: {
        definitionSha256: sha("2"),
        planId: "plan_state",
        planVersionId: "plv_state_001",
      },
    },
    scope,
  });
}

function claimOptions(overrides: Partial<ClaimReplayJobOptions> = {}): ClaimReplayJobOptions {
  return {
    attemptId: "att_state_001",
    isolationProfile: {
      definitionSha256: sha("3"),
      id: "iso_state",
      kind: "local_child_process",
      version: "1.0.0",
    },
    leaseDurationMilliseconds: 30_000,
    leaseId: "lea_state_001",
    maxAttempts: 3,
    now: "2026-08-29T00:00:01.000Z",
    runtimeProfile: {
      definitionSha256: sha("4"),
      family: "node",
      id: "run_state",
      version: "1.0.0",
    },
    targetRelease,
    workerBuildSha256: sha("5"),
    workerId: "wrk_state_001",
    workerProtocol,
    ...overrides,
  };
}

function initialClaim() {
  return claimReplayJob(queuedJob(), claimOptions());
}

function resultArtifact() {
  return {
    artifactId: "art_state_result",
    classification: "internal" as const,
    mediaType: "application/json",
    sha256: sha("6"),
    sizeBytes: 128,
  };
}

function expectStateError(run: () => unknown, code: DurableReplayStateErrorCode): void {
  try {
    run();
    throw new Error("Expected a durable replay state error");
  } catch (error) {
    expect(error).toBeInstanceOf(DurableReplayStateError);
    expect(error).toMatchObject({ code, name: "DurableReplayStateError" });
  }
}

describe("durable replay job creation and claim", () => {
  it("creates a canonical queued job from one exact plan", () => {
    expect(queuedJob()).toMatchObject({
      jobId: "job_state_001",
      lastFencingToken: 0,
      recoveryEpoch: 0,
      stateVersion: 1,
      status: "queued",
    });
    expect(() =>
      createQueuedReplayJob({
        createdAt: "2026-08-29T00:00:00.000Z",
        createdByPrincipalId: "usr_state",
        request: { jobId: "job_state_001", plan: { planId: "latest" } },
        scope,
      }),
    ).toThrow();
  });

  it("claims a queued job with its first positive fence and attempt", () => {
    const claimed = initialClaim();
    expect(claimed.expiredAttempt).toBeUndefined();
    expect(claimed.job).toMatchObject({
      lastFencingToken: 1,
      latestAttemptSequence: 0,
      startedAt: "2026-08-29T00:00:01.000Z",
      stateVersion: 2,
      status: "running",
    });
    expect(claimed.lease).toMatchObject({
      attemptSequence: 0,
      expiresAt: "2026-08-29T00:00:31.000Z",
      mutationFence: { fencingToken: 1 },
    });
    expect(claimed.attempt).toMatchObject({ attemptSequence: 0, status: "running" });
  });

  it("reclaims an expired lease atomically and preserves the expired attempt", () => {
    const first = initialClaim();
    const second = claimReplayJob(
      first.job,
      claimOptions({
        attemptId: "att_state_002",
        currentAttempt: first.attempt,
        expiredEffectCertainty: "none",
        leaseId: "lea_state_002",
        now: first.lease.expiresAt,
        workerId: "wrk_state_002",
      }),
    );
    expect(second.expiredAttempt).toMatchObject({
      attemptId: first.attempt.attemptId,
      error: { code: "lease_expired", effectCertainty: "none" },
      retryDisposition: "retry_scheduled",
      status: "lease_expired",
    });
    expect(second.job).toMatchObject({
      lastFencingToken: 2,
      latestAttemptSequence: 1,
      startedAt: first.job.startedAt,
    });
    expect(second.attempt).toMatchObject({ attemptId: "att_state_002", attemptSequence: 1 });
  });

  it("blocks reclaim when an expired attempt may have produced an external effect", () => {
    const first = initialClaim();
    expectStateError(
      () =>
        claimReplayJob(
          first.job,
          claimOptions({
            attemptId: "att_state_002",
            currentAttempt: first.attempt,
            expiredEffectCertainty: "may_have_occurred",
            leaseId: "lea_state_002",
            now: first.lease.expiresAt,
          }),
        ),
      "effect_uncertain",
    );
  });

  it.each([0, 0.5, 86_400_001])("rejects invalid lease duration %s", (duration) => {
    expectStateError(
      () => claimReplayJob(queuedJob(), claimOptions({ leaseDurationMilliseconds: duration })),
      "invalid_lease_duration",
    );
  });

  it.each([0, 0.5])("rejects invalid attempt limit %s", (maxAttempts) => {
    expectStateError(
      () => claimReplayJob(queuedJob(), claimOptions({ maxAttempts })),
      "attempt_limit_reached",
    );
  });

  it("rejects active leases, exhausted retries, and inconsistent attempt records", () => {
    const first = initialClaim();
    expectStateError(
      () => claimReplayJob(first.job, claimOptions({ currentAttempt: first.attempt })),
      "lease_active",
    );
    expectStateError(
      () =>
        claimReplayJob(
          first.job,
          claimOptions({
            attemptId: "att_state_002",
            currentAttempt: first.attempt,
            leaseId: "lea_state_002",
            maxAttempts: 1,
            now: first.lease.expiresAt,
          }),
        ),
      "attempt_limit_reached",
    );
    expectStateError(
      () =>
        claimReplayJob(
          first.job,
          claimOptions({
            attemptId: "att_state_002",
            leaseId: "lea_state_002",
            now: first.lease.expiresAt,
          }),
        ),
      "invalid_attempt_state",
    );
    expectStateError(
      () => claimReplayJob(queuedJob(), claimOptions({ currentAttempt: first.attempt })),
      "invalid_attempt_state",
    );
  });

  it("rejects a stored current attempt that does not match lease identity, scope, or sequence", () => {
    const first = initialClaim();
    const expiredOptions = {
      attemptId: "att_state_002",
      expiredEffectCertainty: "none" as const,
      leaseId: "lea_state_002",
      now: first.lease.expiresAt,
    };
    const otherAttempt: ReplayAttempt = {
      ...first.attempt,
      attemptId: "att_state_other",
      mutationFence: {
        ...first.attempt.mutationFence,
        attemptId: "att_state_other",
        leaseId: "lea_state_other",
      },
    };
    for (const currentAttempt of [
      otherAttempt,
      { ...first.attempt, scope: { ...scope, projectId: "prj_other" } },
      { ...first.attempt, attemptSequence: 1 },
    ]) {
      expectStateError(
        () =>
          claimReplayJob(
            first.job,
            claimOptions({ ...expiredOptions, currentAttempt: currentAttempt as ReplayAttempt }),
          ),
        "invalid_attempt_state",
      );
    }
  });

  it("rejects terminal jobs and exhausted monotonic counters", () => {
    const cancelled = requestReplayCancellation(queuedJob(), {
      input: {
        cancellationId: "can_state_001",
        reason: "Stop before execution.",
        reasonCode: "operator_request",
      },
      now: "2026-08-29T00:00:01.000Z",
      requestedByPrincipalId: "usr_state",
    }).job;
    expectStateError(() => claimReplayJob(cancelled, claimOptions()), "state_conflict");

    const first = initialClaim();
    const exhausted: ReplayJob = {
      ...first.job,
      currentLease: {
        ...first.lease,
        mutationFence: {
          ...first.lease.mutationFence,
          fencingToken: Number.MAX_SAFE_INTEGER,
        },
      },
      lastFencingToken: Number.MAX_SAFE_INTEGER,
    };
    const exhaustedAttempt: ReplayAttempt = {
      ...first.attempt,
      mutationFence: {
        ...first.attempt.mutationFence,
        fencingToken: Number.MAX_SAFE_INTEGER,
      },
    };
    expectStateError(
      () =>
        claimReplayJob(
          exhausted,
          claimOptions({
            attemptId: "att_state_002",
            currentAttempt: exhaustedAttempt,
            expiredEffectCertainty: "none",
            leaseId: "lea_state_002",
            now: first.lease.expiresAt,
          }),
        ),
      "counter_exhausted",
    );
  });
});

describe("durable replay heartbeat and terminal commit", () => {
  it("heartbeats only the current unexpired lease using server time", () => {
    const first = initialClaim();
    const heartbeat = heartbeatReplayJob(
      first.job,
      first.lease.mutationFence,
      "2026-08-29T00:00:10.000Z",
      30_000,
    );
    expect(heartbeat).toMatchObject({
      currentLease: {
        expiresAt: "2026-08-29T00:00:40.000Z",
        heartbeatAt: "2026-08-29T00:00:10.000Z",
      },
      stateVersion: 3,
    });
  });

  it.each([
    ["jobId", "job_state_other"],
    ["attemptId", "att_state_other"],
    ["leaseId", "lea_state_other"],
    ["workerId", "wrk_state_other"],
    ["fencingToken", 2],
    ["recoveryEpoch", 1],
  ] as const)("rejects a stale %s fence", (key, value) => {
    const first = initialClaim();
    expectStateError(
      () =>
        heartbeatReplayJob(
          first.job,
          { ...first.lease.mutationFence, [key]: value },
          "2026-08-29T00:00:10.000Z",
          30_000,
        ),
      "stale_fence",
    );
  });

  it("rejects heartbeat after expiry, on queued state, and with invalid duration", () => {
    const first = initialClaim();
    expectStateError(
      () => heartbeatReplayJob(first.job, first.lease.mutationFence, first.lease.expiresAt, 30_000),
      "lease_expired",
    );
    expectStateError(
      () =>
        heartbeatReplayJob(queuedJob(), first.lease.mutationFence, first.lease.acquiredAt, 30_000),
      "state_conflict",
    );
    expectStateError(
      () => heartbeatReplayJob(first.job, first.lease.mutationFence, first.lease.acquiredAt, 0),
      "invalid_lease_duration",
    );
  });

  it("commits success once and removes mutation authority", () => {
    const first = initialClaim();
    const completed = completeReplayAttempt(first.job, first.attempt, first.lease.mutationFence, {
      cancellationRequested: false,
      code: "completed",
      now: "2026-08-29T00:00:20.000Z",
      result: resultArtifact(),
      status: "succeeded",
    });
    expect(completed.attempt).toMatchObject({
      endedAt: "2026-08-29T00:00:20.000Z",
      result: resultArtifact(),
      status: "succeeded",
    });
    expect(completed.job).toMatchObject({
      currentLease: undefined,
      lastFencingToken: 1,
      stateVersion: 3,
      status: "succeeded",
      terminal: { attemptId: "att_state_001", code: "completed" },
    });
    expectStateError(
      () =>
        completeReplayAttempt(completed.job, completed.attempt, first.lease.mutationFence, {
          cancellationRequested: false,
          code: "completed",
          now: "2026-08-29T00:00:21.000Z",
          result: resultArtifact(),
          status: "succeeded",
        }),
      "state_conflict",
    );
  });

  it("commits typed failure and cancellation without a result", () => {
    const first = initialClaim();
    const failed = completeReplayAttempt(first.job, first.attempt, first.lease.mutationFence, {
      cancellationRequested: false,
      code: "execution_failed",
      error: {
        code: "worker_internal_error",
        effectCertainty: "none",
        message: "The bounded worker failed.",
      },
      now: "2026-08-29T00:00:20.000Z",
      status: "failed",
    });
    expect(failed.attempt).toMatchObject({
      error: { code: "worker_internal_error" },
      status: "failed",
    });

    const second = initialClaim();
    const cancelled = completeReplayAttempt(
      second.job,
      second.attempt,
      second.lease.mutationFence,
      {
        cancellationRequested: true,
        code: "cancellation_committed",
        error: {
          code: "cancelled",
          effectCertainty: "none",
          message: "Cancellation stopped the bounded worker.",
        },
        now: "2026-08-29T00:00:20.000Z",
        status: "cancelled",
      },
    );
    expect(cancelled.job.status).toBe("cancelled");
  });

  it("prevents success after cancellation and late terminal responses", () => {
    const first = initialClaim();
    expectStateError(
      () =>
        completeReplayAttempt(first.job, first.attempt, first.lease.mutationFence, {
          cancellationRequested: true,
          code: "completed",
          now: "2026-08-29T00:00:20.000Z",
          result: resultArtifact(),
          status: "succeeded",
        }),
      "cancellation_required",
    );
    expectStateError(
      () =>
        completeReplayAttempt(first.job, first.attempt, first.lease.mutationFence, {
          cancellationRequested: false,
          code: "completed",
          now: first.lease.expiresAt,
          result: resultArtifact(),
          status: "succeeded",
        }),
      "lease_expired",
    );
  });
});

describe("durable replay cancellation", () => {
  const input = {
    cancellationId: "can_state_001",
    reason: "Stop the bounded replay.",
    reasonCode: "operator_request" as const,
  };

  it("cancels a queued job atomically without creating an attempt", () => {
    const cancelled = requestReplayCancellation(queuedJob(), {
      input,
      now: "2026-08-29T00:00:01.000Z",
      requestedByPrincipalId: "usr_state",
    });
    expect(cancelled).toMatchObject({
      created: true,
      job: { lastFencingToken: 0, status: "cancelled" },
      request: { cancellationId: "can_state_001", requestedByPrincipalId: "usr_state" },
    });
    expect(cancelled.job.terminal).not.toHaveProperty("attemptId");
  });

  it("records a running request without prematurely claiming that execution stopped", () => {
    const first = initialClaim();
    const requested = requestReplayCancellation(first.job, {
      input,
      now: "2026-08-29T00:00:10.000Z",
      requestedByPrincipalId: "usr_state",
    });
    expect(requested.created).toBe(true);
    expect(requested.job).toEqual(first.job);
  });

  it("returns an identical durable retry and rejects conflicting reuse", () => {
    const first = requestReplayCancellation(queuedJob(), {
      input,
      now: "2026-08-29T00:00:01.000Z",
      requestedByPrincipalId: "usr_state",
    });
    const retry = requestReplayCancellation(first.job, {
      existing: first.request,
      input,
      now: "2026-08-29T00:00:02.000Z",
      requestedByPrincipalId: "usr_state",
    });
    expect(retry).toEqual({ created: false, job: first.job, request: first.request });

    const conflictingInputs = [
      { ...input, cancellationId: "can_state_002" },
      { ...input, reason: "Different reason." },
      { ...input, reasonCode: "safety_intervention" as const },
    ];
    for (const conflicting of conflictingInputs) {
      expectStateError(
        () =>
          requestReplayCancellation(first.job, {
            existing: first.request,
            input: conflicting,
            now: "2026-08-29T00:00:02.000Z",
            requestedByPrincipalId: "usr_state",
          }),
        "cancellation_conflict",
      );
    }
    for (const existing of [
      { ...first.request, jobId: "job_state_other" },
      { ...first.request, scope: { ...scope, tenantId: "ten_other" } },
      { ...first.request, scope: { ...scope, projectId: "prj_other" } },
      { ...first.request, scope: { ...scope, environmentId: "env_other" } },
    ]) {
      expectStateError(
        () =>
          requestReplayCancellation(first.job, {
            existing,
            input,
            now: "2026-08-29T00:00:02.000Z",
            requestedByPrincipalId: "usr_state",
          }),
        "cancellation_conflict",
      );
    }
  });

  it("rejects a new cancellation after a terminal transition", () => {
    const terminal = requestReplayCancellation(queuedJob(), {
      input,
      now: "2026-08-29T00:00:01.000Z",
      requestedByPrincipalId: "usr_state",
    }).job;
    expectStateError(
      () =>
        requestReplayCancellation(terminal, {
          input: { ...input, cancellationId: "can_state_002" },
          now: "2026-08-29T00:00:02.000Z",
          requestedByPrincipalId: "usr_state",
        }),
      "state_conflict",
    );
  });

  it("acknowledges cancellation only under the current fence and durable order", () => {
    const first = initialClaim();
    const requested = requestReplayCancellation(first.job, {
      input,
      now: "2026-08-29T00:00:10.000Z",
      requestedByPrincipalId: "usr_state",
    });
    const acknowledgement = acknowledgeReplayCancellation(
      first.job,
      requested.request,
      first.lease.mutationFence,
      {
        acknowledgementId: "ack_state_001",
        action: "stop_requested",
        now: "2026-08-29T00:00:11.000Z",
      },
    );
    expect(acknowledgement).toMatchObject({
      acknowledgementId: "ack_state_001",
      cancellationId: "can_state_001",
      mutationFence: first.lease.mutationFence,
    });

    expectStateError(
      () =>
        acknowledgeReplayCancellation(first.job, requested.request, first.lease.mutationFence, {
          acknowledgementId: "ack_state_002",
          action: "stop_requested",
          now: "2026-08-29T00:00:09.000Z",
        }),
      "cancellation_conflict",
    );
    expectStateError(
      () =>
        acknowledgeReplayCancellation(
          first.job,
          { ...requested.request, jobId: "job_state_other" },
          first.lease.mutationFence,
          {
            acknowledgementId: "ack_state_003",
            action: "stop_requested",
            now: "2026-08-29T00:00:11.000Z",
          },
        ),
      "cancellation_conflict",
    );
    const staleFence: ReplayWorkerMutationFence = {
      ...first.lease.mutationFence,
      fencingToken: 2,
    };
    expectStateError(
      () =>
        acknowledgeReplayCancellation(first.job, requested.request, staleFence, {
          acknowledgementId: "ack_state_004",
          action: "stop_requested",
          now: "2026-08-29T00:00:11.000Z",
        }),
      "stale_fence",
    );
  });
});
