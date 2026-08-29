import {
  CreateReplayJobRequestSchema,
  type EvidenceScope,
  REPLAY_ATTEMPT_SCHEMA_VERSION,
  REPLAY_CANCELLATION_SCHEMA_VERSION,
  REPLAY_JOB_SCHEMA_VERSION,
  REPLAY_LEASE_SCHEMA_VERSION,
  type ReplayArtifactContentReference,
  type ReplayAttempt,
  type ReplayAttemptError,
  ReplayAttemptSchema,
  type ReplayCancellationAcknowledgement,
  ReplayCancellationAcknowledgementSchema,
  type ReplayCancellationRequest,
  ReplayCancellationRequestSchema,
  type ReplayIsolationProfileReference,
  type ReplayJob,
  ReplayJobSchema,
  type ReplayJobTerminalCode,
  type ReplayJobTerminalStatus,
  type ReplayLease,
  ReplayLeaseSchema,
  type ReplayRuntimeProfileReference,
  type ReplayWorkerMutationFence,
  RequestReplayCancellationSchema,
  type TargetReleaseReference,
  UtcMillisecondTimestampSchema,
  type WorkerProtocolReference,
} from "@proofstack/contracts";
import { DurableReplayStateError } from "./errors.js";

const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const MAX_LEASE_DURATION_MILLISECONDS = 24 * 60 * 60 * 1_000;

export interface CreateQueuedReplayJobOptions {
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
  readonly request: unknown;
  readonly scope: EvidenceScope;
}

export interface ClaimReplayJobOptions {
  readonly attemptId: string;
  readonly currentAttempt?: ReplayAttempt;
  readonly expiredEffect?: Pick<ReplayAttemptError, "effectCertainty" | "effectRetrySafety">;
  readonly isolationProfile: ReplayIsolationProfileReference;
  readonly leaseDurationMilliseconds: number;
  readonly leaseId: string;
  readonly maxAttempts: number;
  readonly now: string;
  readonly runtimeProfile: ReplayRuntimeProfileReference;
  readonly targetRelease: TargetReleaseReference;
  readonly workerBuildSha256: string;
  readonly workerId: string;
  readonly workerProtocol: WorkerProtocolReference;
}

export interface ClaimReplayJobResult {
  readonly attempt: ReplayAttempt;
  readonly expiredAttempt?: ReplayAttempt;
  readonly job: ReplayJob;
  readonly lease: ReplayLease;
}

export interface CompleteReplayAttemptOptions {
  readonly cancellationRequested: boolean;
  readonly code: ReplayJobTerminalCode;
  readonly error?: ReplayAttemptError;
  readonly now: string;
  readonly result?: ReplayArtifactContentReference;
  readonly status: ReplayJobTerminalStatus;
}

export type CloseExpiredReplayAttemptOptions = {
  readonly effect: Pick<ReplayAttemptError, "effectCertainty" | "effectRetrySafety">;
  readonly now: string;
} & (
  | {
      readonly code: Extract<ReplayJobTerminalCode, "execution_failed" | "retries_exhausted">;
      readonly status: Extract<ReplayJobTerminalStatus, "failed">;
    }
  | {
      readonly code: Extract<ReplayJobTerminalCode, "deadline_reached">;
      readonly status: Extract<ReplayJobTerminalStatus, "timed_out">;
    }
);

export interface RequestReplayCancellationOptions {
  readonly existing?: ReplayCancellationRequest;
  readonly input: unknown;
  readonly now: string;
  readonly requestedByPrincipalId: string;
}

export interface RequestReplayCancellationResult {
  readonly created: boolean;
  readonly job: ReplayJob;
  readonly request: ReplayCancellationRequest;
}

function canonicalTime(value: string): string {
  return UtcMillisecondTimestampSchema.parse(value);
}

function timeValue(value: string): number {
  return Date.parse(value);
}

function assertLeaseDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LEASE_DURATION_MILLISECONDS) {
    throw new DurableReplayStateError("invalid_lease_duration");
  }
}

function addMilliseconds(value: string, duration: number): string {
  return UtcMillisecondTimestampSchema.parse(new Date(timeValue(value) + duration).toISOString());
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function sameFence(left: ReplayWorkerMutationFence, right: ReplayWorkerMutationFence): boolean {
  return (
    left.jobId === right.jobId &&
    left.attemptId === right.attemptId &&
    left.leaseId === right.leaseId &&
    left.workerId === right.workerId &&
    left.fencingToken === right.fencingToken &&
    left.recoveryEpoch === right.recoveryEpoch
  );
}

function nextCounter(value: number): number {
  if (value >= MAX_COUNTER) {
    throw new DurableReplayStateError("counter_exhausted");
  }
  return value + 1;
}

function assertCurrentFence(
  job: ReplayJob,
  fence: ReplayWorkerMutationFence,
  now: string,
): ReplayLease {
  if (job.status !== "running") {
    throw new DurableReplayStateError("state_conflict");
  }
  const currentLease = ReplayLeaseSchema.parse(job.currentLease);
  if (!sameFence(currentLease.mutationFence, fence)) {
    throw new DurableReplayStateError("stale_fence");
  }
  if (timeValue(now) >= timeValue(currentLease.expiresAt)) {
    throw new DurableReplayStateError("lease_expired");
  }
  return currentLease;
}

function assertCurrentAttempt(job: ReplayJob, attempt: ReplayAttempt | undefined): ReplayAttempt {
  const currentLease = ReplayLeaseSchema.parse(job.currentLease);
  if (
    attempt?.status !== "running" ||
    !sameFence(attempt.mutationFence, currentLease.mutationFence) ||
    !sameScope(attempt.scope, job.scope) ||
    attempt.attemptSequence !== currentLease.attemptSequence
  ) {
    throw new DurableReplayStateError("invalid_attempt_state");
  }
  return attempt;
}

export function createQueuedReplayJob(options: CreateQueuedReplayJobOptions): ReplayJob {
  const request = CreateReplayJobRequestSchema.parse(options.request);
  return ReplayJobSchema.parse({
    createdAt: canonicalTime(options.createdAt),
    createdByPrincipalId: options.createdByPrincipalId,
    jobId: request.jobId,
    lastFencingToken: 0,
    plan: request.plan,
    recoveryEpoch: 0,
    schemaVersion: REPLAY_JOB_SCHEMA_VERSION,
    scope: options.scope,
    stateVersion: 1,
    status: "queued",
  });
}

export function claimReplayJob(
  jobInput: ReplayJob,
  options: ClaimReplayJobOptions,
): ClaimReplayJobResult {
  const job = ReplayJobSchema.parse(jobInput);
  const now = canonicalTime(options.now);
  assertLeaseDuration(options.leaseDurationMilliseconds);
  if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new DurableReplayStateError("attempt_limit_reached");
  }
  if (job.status !== "queued" && job.status !== "running") {
    throw new DurableReplayStateError("state_conflict");
  }
  if (job.status === "running") {
    const currentLease = ReplayLeaseSchema.parse(job.currentLease);
    if (timeValue(now) < timeValue(currentLease.expiresAt)) {
      throw new DurableReplayStateError("lease_active");
    }
  }

  const previousSequence = job.latestAttemptSequence ?? -1;
  const attemptSequence = nextCounter(previousSequence);
  if (attemptSequence >= options.maxAttempts) {
    throw new DurableReplayStateError("attempt_limit_reached");
  }
  const fencingToken = nextCounter(job.lastFencingToken);
  const stateVersion = nextCounter(job.stateVersion);
  const mutationFence: ReplayWorkerMutationFence = {
    attemptId: options.attemptId,
    fencingToken,
    jobId: job.jobId,
    leaseId: options.leaseId,
    recoveryEpoch: job.recoveryEpoch,
    workerId: options.workerId,
  };
  const lease = ReplayLeaseSchema.parse({
    acquiredAt: now,
    attemptSequence,
    expiresAt: addMilliseconds(now, options.leaseDurationMilliseconds),
    heartbeatAt: now,
    mutationFence,
    schemaVersion: REPLAY_LEASE_SCHEMA_VERSION,
    scope: job.scope,
  });
  const attempt = ReplayAttemptSchema.parse({
    attemptId: options.attemptId,
    attemptSequence,
    isolationProfile: options.isolationProfile,
    jobId: job.jobId,
    mutationFence,
    plan: job.plan,
    runtimeProfile: options.runtimeProfile,
    schemaVersion: REPLAY_ATTEMPT_SCHEMA_VERSION,
    scope: job.scope,
    startedAt: now,
    status: "running",
    targetRelease: options.targetRelease,
    workerBuildSha256: options.workerBuildSha256,
    workerProtocol: options.workerProtocol,
  });

  let expiredAttempt: ReplayAttempt | undefined;
  if (job.status === "running") {
    const currentAttempt = assertCurrentAttempt(job, options.currentAttempt);
    const expiredEffect = options.expiredEffect;
    if (
      !expiredEffect ||
      (expiredEffect.effectCertainty !== "none" &&
        expiredEffect.effectRetrySafety?.kind !== "read_only" &&
        expiredEffect.effectRetrySafety?.kind !== "destination_idempotency_verified")
    ) {
      throw new DurableReplayStateError("effect_uncertain");
    }
    expiredAttempt = ReplayAttemptSchema.parse({
      ...currentAttempt,
      endedAt: now,
      error: {
        code: "lease_expired",
        ...expiredEffect,
        message: "The worker lease expired before a terminal attempt commit.",
      },
      retryDisposition: "retry_scheduled",
      status: "lease_expired",
    });
  } else if (options.currentAttempt !== undefined) {
    throw new DurableReplayStateError("invalid_attempt_state");
  }

  return {
    attempt,
    ...(expiredAttempt ? { expiredAttempt } : {}),
    job: ReplayJobSchema.parse({
      ...job,
      currentLease: lease,
      lastFencingToken: fencingToken,
      latestAttemptSequence: attemptSequence,
      startedAt: job.startedAt ?? now,
      stateVersion,
      status: "running",
    }),
    lease,
  };
}

export function heartbeatReplayJob(
  jobInput: ReplayJob,
  fence: ReplayWorkerMutationFence,
  nowInput: string,
  leaseDurationMilliseconds: number,
): ReplayJob {
  const job = ReplayJobSchema.parse(jobInput);
  const now = canonicalTime(nowInput);
  assertLeaseDuration(leaseDurationMilliseconds);
  const currentLease = assertCurrentFence(job, fence, now);
  const lease = ReplayLeaseSchema.parse({
    ...currentLease,
    expiresAt: addMilliseconds(now, leaseDurationMilliseconds),
    heartbeatAt: now,
  });
  return ReplayJobSchema.parse({
    ...job,
    currentLease: lease,
    stateVersion: nextCounter(job.stateVersion),
  });
}

export function closeExpiredReplayAttempt(
  jobInput: ReplayJob,
  attemptInput: ReplayAttempt,
  options: CloseExpiredReplayAttemptOptions,
): { readonly attempt: ReplayAttempt; readonly job: ReplayJob } {
  const job = ReplayJobSchema.parse(jobInput);
  const attempt = ReplayAttemptSchema.parse(attemptInput);
  const now = canonicalTime(options.now);
  if (job.status !== "running") throw new DurableReplayStateError("state_conflict");
  const lease = ReplayLeaseSchema.parse(job.currentLease);
  assertCurrentAttempt(job, attempt);
  if (timeValue(now) < timeValue(lease.expiresAt)) {
    throw new DurableReplayStateError("lease_active");
  }
  const expiredAttempt = ReplayAttemptSchema.parse({
    ...attempt,
    endedAt: lease.expiresAt,
    error: {
      code: "lease_expired",
      ...options.effect,
      message: "The worker lease expired before a terminal attempt commit.",
    },
    retryDisposition: "not_retryable",
    status: "lease_expired",
  });
  const terminalJob = ReplayJobSchema.parse({
    ...job,
    currentLease: undefined,
    stateVersion: nextCounter(job.stateVersion),
    status: options.status,
    terminal: {
      attemptId: attempt.attemptId,
      code: options.code,
      committedAt: now,
      status: options.status,
    },
  });
  return { attempt: expiredAttempt, job: terminalJob };
}

export function completeReplayAttempt(
  jobInput: ReplayJob,
  attemptInput: ReplayAttempt,
  fence: ReplayWorkerMutationFence,
  options: CompleteReplayAttemptOptions,
): { readonly attempt: ReplayAttempt; readonly job: ReplayJob } {
  const job = ReplayJobSchema.parse(jobInput);
  const attempt = ReplayAttemptSchema.parse(attemptInput);
  const now = canonicalTime(options.now);
  assertCurrentFence(job, fence, now);
  assertCurrentAttempt(job, attempt);
  if (options.cancellationRequested && options.status !== "cancelled") {
    throw new DurableReplayStateError("cancellation_required");
  }

  const completedAttempt = ReplayAttemptSchema.parse({
    ...attempt,
    endedAt: now,
    ...(options.error ? { error: options.error } : {}),
    ...(options.result ? { result: options.result } : {}),
    retryDisposition: "not_retryable",
    status: options.status,
  });
  const completedJob = ReplayJobSchema.parse({
    ...job,
    currentLease: undefined,
    stateVersion: nextCounter(job.stateVersion),
    status: options.status,
    terminal: {
      attemptId: attempt.attemptId,
      code: options.code,
      committedAt: now,
      status: options.status,
    },
  });
  return { attempt: completedAttempt, job: completedJob };
}

export function requestReplayCancellation(
  jobInput: ReplayJob,
  options: RequestReplayCancellationOptions,
): RequestReplayCancellationResult {
  const job = ReplayJobSchema.parse(jobInput);
  const input = RequestReplayCancellationSchema.parse(options.input);
  const now = canonicalTime(options.now);
  if (options.existing) {
    const existing = ReplayCancellationRequestSchema.parse(options.existing);
    if (
      existing.jobId !== job.jobId ||
      !sameScope(existing.scope, job.scope) ||
      existing.cancellationId !== input.cancellationId ||
      existing.reasonCode !== input.reasonCode ||
      existing.reason !== input.reason
    ) {
      throw new DurableReplayStateError("cancellation_conflict");
    }
    return { created: false, job, request: existing };
  }
  if (job.status !== "queued" && job.status !== "running") {
    throw new DurableReplayStateError("state_conflict");
  }
  const request = ReplayCancellationRequestSchema.parse({
    ...input,
    jobId: job.jobId,
    requestedAt: now,
    requestedByPrincipalId: options.requestedByPrincipalId,
    schemaVersion: REPLAY_CANCELLATION_SCHEMA_VERSION,
    scope: job.scope,
  });
  if (job.status === "running") return { created: true, job, request };
  return {
    created: true,
    job: ReplayJobSchema.parse({
      ...job,
      stateVersion: nextCounter(job.stateVersion),
      status: "cancelled",
      terminal: {
        code: "cancellation_committed",
        committedAt: now,
        status: "cancelled",
      },
    }),
    request,
  };
}

export function acknowledgeReplayCancellation(
  jobInput: ReplayJob,
  requestInput: ReplayCancellationRequest,
  fence: ReplayWorkerMutationFence,
  options: {
    readonly acknowledgementId: string;
    readonly action: ReplayCancellationAcknowledgement["action"];
    readonly now: string;
  },
): ReplayCancellationAcknowledgement {
  const job = ReplayJobSchema.parse(jobInput);
  const request = ReplayCancellationRequestSchema.parse(requestInput);
  const now = canonicalTime(options.now);
  assertCurrentFence(job, fence, now);
  if (
    request.jobId !== job.jobId ||
    !sameScope(request.scope, job.scope) ||
    timeValue(now) < timeValue(request.requestedAt)
  ) {
    throw new DurableReplayStateError("cancellation_conflict");
  }
  return ReplayCancellationAcknowledgementSchema.parse({
    acknowledgedAt: now,
    acknowledgementId: options.acknowledgementId,
    action: options.action,
    cancellationId: request.cancellationId,
    mutationFence: fence,
    schemaVersion: REPLAY_CANCELLATION_SCHEMA_VERSION,
    scope: job.scope,
  });
}
