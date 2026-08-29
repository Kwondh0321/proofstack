import { describe, expect, it } from "vitest";
import {
  CreateReplayJobRequestSchema,
  REPLAY_ATTEMPT_SCHEMA_VERSION,
  REPLAY_CANCELLATION_SCHEMA_VERSION,
  REPLAY_JOB_SCHEMA_VERSION,
  REPLAY_LEASE_SCHEMA_VERSION,
  ReplayAttemptSchema,
  ReplayCancellationAcknowledgementSchema,
  ReplayCancellationRequestSchema,
  ReplayJobSchema,
  ReplayJobTerminalRecordSchema,
  ReplayLeaseSchema,
  ReplayWorkerMutationFenceSchema,
  RequestReplayCancellationSchema,
} from "./replay-job.js";

const sha = (digit: string): string => digit.repeat(64);

const scope = {
  environmentId: "env_reference",
  projectId: "prj_reference",
  tenantId: "ten_reference",
};

const plan = {
  definitionSha256: sha("1"),
  planId: "plan_reference",
  planVersionId: "plv_reference_001",
};

const workerProtocol = { name: "proofstack.replay-worker", version: "1.0.0" };

const targetRelease = {
  definitionSha256: sha("2"),
  targetAdapter: {
    name: "proofstack.reference_target",
    protocolVersion: "1.0.0",
    version: "1.2.0",
  },
  targetId: "target_reference",
  targetReleaseId: "trg_reference_001",
  workerProtocol,
};

function mutationFence() {
  return {
    attemptId: "att_reference_001",
    fencingToken: 1,
    jobId: "job_reference_001",
    leaseId: "lea_reference_001",
    recoveryEpoch: 0,
    workerId: "wrk_reference_001",
  };
}

function lease() {
  return {
    acquiredAt: "2026-08-29T00:00:01.000Z",
    attemptSequence: 0,
    expiresAt: "2026-08-29T00:00:31.000Z",
    heartbeatAt: "2026-08-29T00:00:11.000Z",
    mutationFence: mutationFence(),
    schemaVersion: REPLAY_LEASE_SCHEMA_VERSION,
    scope,
  };
}

function queuedJob() {
  return {
    createdAt: "2026-08-29T00:00:00.000Z",
    createdByPrincipalId: "usr_operator",
    jobId: "job_reference_001",
    lastFencingToken: 0,
    plan,
    recoveryEpoch: 0,
    schemaVersion: REPLAY_JOB_SCHEMA_VERSION,
    scope,
    stateVersion: 1,
    status: "queued" as const,
  };
}

function runningJob() {
  return {
    ...queuedJob(),
    currentLease: lease(),
    lastFencingToken: 1,
    latestAttemptSequence: 0,
    startedAt: "2026-08-29T00:00:01.000Z",
    stateVersion: 2,
    status: "running" as const,
  };
}

function terminalJob(
  status: "budget_exhausted" | "cancelled" | "failed" | "succeeded" | "timed_out",
) {
  const code = {
    budget_exhausted: "budget_limit_reached",
    cancelled: "cancellation_committed",
    failed: "execution_failed",
    succeeded: "completed",
    timed_out: "deadline_reached",
  } as const;
  const { currentLease: _lease, ...started } = runningJob();
  return {
    ...started,
    stateVersion: 3,
    status,
    terminal: {
      attemptId: "att_reference_001",
      code: code[status],
      committedAt: "2026-08-29T00:00:20.000Z",
      status,
    },
  };
}

function runningAttempt() {
  return {
    attemptId: "att_reference_001",
    attemptSequence: 0,
    isolationProfile: {
      definitionSha256: sha("3"),
      id: "iso_local_child",
      kind: "local_child_process" as const,
      version: "1.0.0",
    },
    jobId: "job_reference_001",
    mutationFence: mutationFence(),
    plan,
    runtimeProfile: {
      definitionSha256: sha("4"),
      family: "node",
      id: "run_node_24",
      version: "1.0.0",
    },
    schemaVersion: REPLAY_ATTEMPT_SCHEMA_VERSION,
    scope,
    startedAt: "2026-08-29T00:00:01.000Z",
    status: "running" as const,
    targetRelease,
    workerBuildSha256: sha("5"),
    workerProtocol,
  };
}

const result = {
  artifactId: "art_replay_result",
  classification: "internal" as const,
  mediaType: "application/json",
  sha256: sha("6"),
  sizeBytes: 512,
};

function failedAttempt(
  status: "budget_exhausted" | "cancelled" | "failed" | "lease_expired" | "timed_out",
  code: string,
) {
  return {
    ...runningAttempt(),
    endedAt: "2026-08-29T00:00:20.000Z",
    error: {
      code,
      effectCertainty: "none" as const,
      message: "The bounded attempt did not complete.",
    },
    retryDisposition: "not_retryable" as const,
    status,
  };
}

describe("replay lease and fence contracts", () => {
  it("accepts one exact positive mutation fence and ordered lease", () => {
    expect(ReplayWorkerMutationFenceSchema.parse(mutationFence())).toEqual(mutationFence());
    expect(ReplayLeaseSchema.parse(lease())).toEqual(lease());
  });

  it.each([
    ["zero fence", { mutationFence: { ...mutationFence(), fencingToken: 0 } }],
    ["heartbeat before acquisition", { heartbeatAt: "2026-08-29T00:00:00.000Z" }],
    ["expiry at heartbeat", { expiresAt: "2026-08-29T00:00:11.000Z" }],
    ["unknown lease field", { command: "accept-stale-worker" }],
  ])("rejects %s", (_name, patch) => {
    expect(ReplayLeaseSchema.safeParse({ ...lease(), ...patch }).success).toBe(false);
  });
});

describe("replay job state contracts", () => {
  it("accepts queued, running, and every terminal state", () => {
    expect(ReplayJobSchema.safeParse(queuedJob()).success).toBe(true);
    expect(ReplayJobSchema.safeParse(runningJob()).success).toBe(true);
    for (const status of [
      "budget_exhausted",
      "cancelled",
      "failed",
      "succeeded",
      "timed_out",
    ] as const) {
      expect(ReplayJobSchema.safeParse(terminalJob(status)).success).toBe(true);
    }
  });

  it("accepts an atomic queued cancellation without inventing an attempt", () => {
    const job = {
      ...queuedJob(),
      stateVersion: 2,
      status: "cancelled" as const,
      terminal: {
        code: "cancellation_committed" as const,
        committedAt: "2026-08-29T00:00:01.000Z",
        status: "cancelled" as const,
      },
    };
    expect(ReplayJobSchema.safeParse(job).success).toBe(true);
    expect(
      ReplayJobSchema.safeParse({ ...job, startedAt: "2026-08-29T00:00:01.000Z" }).success,
    ).toBe(false);
    expect(
      ReplayJobSchema.safeParse({
        ...job,
        terminal: { ...job.terminal, committedAt: "2026-08-28T23:59:59.999Z" },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["queued lease", { currentLease: lease() }],
    ["queued historical fence", { ...queuedJob(), lastFencingToken: 1 }],
    ["started without metadata", { status: "running" }],
    [
      "start before creation",
      {
        ...runningJob(),
        startedAt: "2026-08-28T23:59:59.999Z",
      },
    ],
    ["running without lease", { ...runningJob(), currentLease: undefined }],
    ["running zero fence history", { ...runningJob(), lastFencingToken: 0 }],
    [
      "wrong lease job",
      {
        ...runningJob(),
        currentLease: {
          ...lease(),
          mutationFence: { ...mutationFence(), jobId: "job_other" },
        },
      },
    ],
    [
      "wrong lease fence history",
      {
        ...runningJob(),
        lastFencingToken: 2,
      },
    ],
    [
      "wrong lease scope",
      {
        ...runningJob(),
        currentLease: {
          ...lease(),
          scope: { ...scope, tenantId: "ten_other" },
        },
      },
    ],
    ["terminal with lease", { ...terminalJob("succeeded"), currentLease: lease() }],
    [
      "terminal status mismatch",
      {
        ...terminalJob("succeeded"),
        terminal: { ...terminalJob("succeeded").terminal, status: "failed" },
      },
    ],
    [
      "terminal before start",
      {
        ...terminalJob("succeeded"),
        terminal: {
          ...terminalJob("succeeded").terminal,
          committedAt: "2026-08-29T00:00:00.000Z",
        },
      },
    ],
  ])("rejects %s", (_name, candidate) => {
    expect(ReplayJobSchema.safeParse(candidate).success).toBe(false);
  });

  it("requires terminal codes and deciding attempts to agree with status", () => {
    expect(
      ReplayJobTerminalRecordSchema.safeParse({
        ...terminalJob("failed").terminal,
        attemptId: undefined,
      }).success,
    ).toBe(false);
    expect(
      ReplayJobTerminalRecordSchema.safeParse({
        ...terminalJob("failed").terminal,
        code: "completed",
      }).success,
    ).toBe(false);
  });

  it("creates jobs only from an exact plan reference", () => {
    const request = { jobId: "job_reference_001", plan };
    expect(CreateReplayJobRequestSchema.parse(request)).toEqual(request);
    expect(
      CreateReplayJobRequestSchema.safeParse({ ...request, plan: { planId: "latest" } }).success,
    ).toBe(false);
    expect(CreateReplayJobRequestSchema.safeParse({ ...request, execute: true }).success).toBe(
      false,
    );
  });
});

describe("replay attempt contracts", () => {
  it("accepts running and successful attempts with exact execution lineage", () => {
    expect(ReplayAttemptSchema.parse(runningAttempt())).toEqual(runningAttempt());
    const succeeded = {
      ...runningAttempt(),
      endedAt: "2026-08-29T00:00:20.000Z",
      result,
      retryDisposition: "not_retryable" as const,
      status: "succeeded" as const,
    };
    expect(ReplayAttemptSchema.safeParse(succeeded).success).toBe(true);
  });

  it.each([
    ["budget_exhausted", "budget_exhausted"],
    ["cancelled", "cancelled"],
    ["failed", "worker_internal_error"],
    ["lease_expired", "lease_expired"],
    ["timed_out", "deadline_exceeded"],
  ] as const)("accepts the %s terminal attempt with matching error", (status, code) => {
    expect(ReplayAttemptSchema.safeParse(failedAttempt(status, code)).success).toBe(true);
  });

  it.each([
    ["running outcome", { ...runningAttempt(), endedAt: "2026-08-29T00:00:02.000Z" }],
    [
      "fence identity mismatch",
      {
        ...runningAttempt(),
        mutationFence: { ...mutationFence(), attemptId: "att_other" },
      },
    ],
    [
      "worker protocol mismatch",
      {
        ...runningAttempt(),
        workerProtocol: { ...workerProtocol, version: "2.0.0" },
      },
    ],
    [
      "terminal without end",
      {
        ...failedAttempt("failed", "worker_internal_error"),
        endedAt: undefined,
      },
    ],
    [
      "end before start",
      {
        ...failedAttempt("failed", "worker_internal_error"),
        endedAt: "2026-08-29T00:00:00.000Z",
      },
    ],
    [
      "success without result",
      {
        ...runningAttempt(),
        endedAt: "2026-08-29T00:00:20.000Z",
        retryDisposition: "not_retryable",
        status: "succeeded",
      },
    ],
    [
      "failure with result",
      {
        ...failedAttempt("failed", "worker_internal_error"),
        result,
      },
    ],
    ["status and error mismatch", failedAttempt("cancelled", "deadline_exceeded")],
  ])("rejects %s", (_name, candidate) => {
    expect(ReplayAttemptSchema.safeParse(candidate).success).toBe(false);
  });

  it("allows only declared retryable errors to schedule another attempt", () => {
    const retryable = {
      ...failedAttempt("failed", "boundary_rate_limited"),
      retryDisposition: "retry_scheduled" as const,
    };
    expect(ReplayAttemptSchema.safeParse(retryable).success).toBe(true);
    expect(
      ReplayAttemptSchema.safeParse({
        ...failedAttempt("failed", "authority_denied"),
        retryDisposition: "retry_scheduled",
      }).success,
    ).toBe(false);
    expect(
      ReplayAttemptSchema.safeParse({
        ...retryable,
        error: { ...retryable.error, effectCertainty: "may_have_occurred" },
      }).success,
    ).toBe(false);
  });

  it("records a lease-expiry retry decision but never retries control terminal states", () => {
    expect(
      ReplayAttemptSchema.safeParse({
        ...failedAttempt("lease_expired", "lease_expired"),
        retryDisposition: "retry_scheduled",
      }).success,
    ).toBe(true);
    expect(
      ReplayAttemptSchema.safeParse({
        ...failedAttempt("lease_expired", "lease_expired"),
        retryDisposition: "retry_eligible",
      }).success,
    ).toBe(false);
    expect(
      ReplayAttemptSchema.safeParse({
        ...failedAttempt("cancelled", "cancelled"),
        retryDisposition: "retry_scheduled",
      }).success,
    ).toBe(false);
  });

  it("rejects unsafe error text and plaintext detail fields", () => {
    const failed = failedAttempt("failed", "worker_internal_error");
    expect(
      ReplayAttemptSchema.safeParse({
        ...failed,
        error: { ...failed.error, message: " trailing " },
      }).success,
    ).toBe(false);
    expect(
      ReplayAttemptSchema.safeParse({
        ...failed,
        error: { ...failed.error, message: "line\nbreak" },
      }).success,
    ).toBe(false);
    expect(
      ReplayAttemptSchema.safeParse({
        ...failed,
        error: { ...failed.error, secret: "credential-value" },
      }).success,
    ).toBe(false);
  });
});

describe("replay cancellation contracts", () => {
  const requestInput = {
    cancellationId: "can_reference_001",
    reason: "Stop the bounded replay before further work.",
    reasonCode: "operator_request" as const,
  };

  it("separates caller input from immutable server provenance", () => {
    expect(RequestReplayCancellationSchema.parse(requestInput)).toEqual(requestInput);
    const request = {
      ...requestInput,
      jobId: "job_reference_001",
      requestedAt: "2026-08-29T00:00:10.000Z",
      requestedByPrincipalId: "usr_operator",
      schemaVersion: REPLAY_CANCELLATION_SCHEMA_VERSION,
      scope,
    };
    expect(ReplayCancellationRequestSchema.parse(request)).toEqual(request);
  });

  it("requires canonical bounded reasons and rejects caller timestamps", () => {
    expect(
      RequestReplayCancellationSchema.safeParse({ ...requestInput, reason: " stop " }).success,
    ).toBe(false);
    expect(
      RequestReplayCancellationSchema.safeParse({ ...requestInput, reason: "stop\nnow" }).success,
    ).toBe(false);
    expect(
      RequestReplayCancellationSchema.safeParse({
        ...requestInput,
        requestedAt: "2026-08-29T00:00:10.000Z",
      }).success,
    ).toBe(false);
  });

  it("binds a worker acknowledgement to the current mutation fence", () => {
    const acknowledgement = {
      acknowledgedAt: "2026-08-29T00:00:11.000Z",
      acknowledgementId: "ack_reference_001",
      action: "stop_requested" as const,
      cancellationId: "can_reference_001",
      mutationFence: mutationFence(),
      schemaVersion: REPLAY_CANCELLATION_SCHEMA_VERSION,
      scope,
    };
    expect(ReplayCancellationAcknowledgementSchema.parse(acknowledgement)).toEqual(acknowledgement);
    expect(
      ReplayCancellationAcknowledgementSchema.safeParse({
        ...acknowledgement,
        forceKilled: true,
      }).success,
    ).toBe(false);
  });
});
