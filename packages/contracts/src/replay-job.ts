import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { EvidenceScopeSchema } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import {
  ReplayIsolationProfileReferenceSchema,
  ReplayRuntimeProfileReferenceSchema,
  TargetReleaseReferenceSchema,
  WorkerProtocolReferenceSchema,
} from "./replay-plan.js";

export const REPLAY_JOB_SCHEMA_VERSION = "0.1" as const;
export const REPLAY_LEASE_SCHEMA_VERSION = "0.1" as const;
export const REPLAY_ATTEMPT_SCHEMA_VERSION = "0.1" as const;
export const REPLAY_CANCELLATION_SCHEMA_VERSION = "0.1" as const;
export const MAX_REPLAY_CANCELLATION_REASON_CHARACTERS = 512;
export const MAX_REPLAY_ATTEMPT_ERROR_MESSAGE_CHARACTERS = 1_024;
export const MAX_REPLAY_STATE_VERSION = Number.MAX_SAFE_INTEGER;

const SafePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

function timestampOrder(value: string): number {
  return Date.parse(value);
}

function containsUnsafeTextControl(value: string): boolean {
  return value.split("").some((character) => {
    const codeUnit = character.charCodeAt(0);
    return (
      codeUnit <= 0x1f ||
      (codeUnit >= 0x7f && codeUnit <= 0x9f) ||
      codeUnit === 0x2028 ||
      codeUnit === 0x2029
    );
  });
}

function canonicalHumanText(maximumCharacters: number, label: string) {
  return z
    .string()
    .min(1)
    .max(maximumCharacters)
    .refine((value) => value.trim() === value, `${label} must not have surrounding whitespace`)
    .refine(
      (value) => !containsUnsafeTextControl(value),
      `${label} must not contain control characters`,
    );
}

export const ReplayPlanJobReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    planId: OpaqueIdSchema,
    planVersionId: OpaqueIdSchema,
  })
  .strict();

export const ReplayJobStatusSchema = z.enum([
  "budget_exhausted",
  "cancelled",
  "failed",
  "queued",
  "running",
  "succeeded",
  "timed_out",
]);

export const ReplayJobTerminalStatusSchema = z.enum([
  "budget_exhausted",
  "cancelled",
  "failed",
  "succeeded",
  "timed_out",
]);

export const ReplayJobTerminalCodeSchema = z.enum([
  "budget_limit_reached",
  "cancellation_committed",
  "completed",
  "contract_rejected",
  "deadline_reached",
  "execution_failed",
  "retries_exhausted",
]);

export const ReplayWorkerMutationFenceSchema = z
  .object({
    attemptId: OpaqueIdSchema,
    fencingToken: SafePositiveIntegerSchema,
    jobId: OpaqueIdSchema,
    leaseId: OpaqueIdSchema,
    recoveryEpoch: SafeNonnegativeIntegerSchema,
    workerId: OpaqueIdSchema,
  })
  .strict();

export const ReplayLeaseSchema = z
  .object({
    acquiredAt: UtcMillisecondTimestampSchema,
    attemptSequence: SafeNonnegativeIntegerSchema,
    expiresAt: UtcMillisecondTimestampSchema,
    heartbeatAt: UtcMillisecondTimestampSchema,
    mutationFence: ReplayWorkerMutationFenceSchema,
    schemaVersion: z.literal(REPLAY_LEASE_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (timestampOrder(value.heartbeatAt) < timestampOrder(value.acquiredAt)) {
      context.addIssue({
        code: "custom",
        message: "Lease heartbeat cannot precede acquisition",
        path: ["heartbeatAt"],
      });
    }
    if (timestampOrder(value.expiresAt) <= timestampOrder(value.heartbeatAt)) {
      context.addIssue({
        code: "custom",
        message: "Lease expiry must follow its latest heartbeat",
        path: ["expiresAt"],
      });
    }
  });

export const ReplayJobTerminalRecordSchema = z
  .object({
    attemptId: OpaqueIdSchema.optional(),
    code: ReplayJobTerminalCodeSchema,
    committedAt: UtcMillisecondTimestampSchema,
    status: ReplayJobTerminalStatusSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "cancelled" && value.attemptId === undefined) {
      context.addIssue({
        code: "custom",
        message: "A non-cancelled terminal job requires the deciding attempt",
        path: ["attemptId"],
      });
    }
    const expectedCodeByStatus = {
      budget_exhausted: new Set(["budget_limit_reached"]),
      cancelled: new Set(["cancellation_committed"]),
      failed: new Set(["contract_rejected", "execution_failed", "retries_exhausted"]),
      succeeded: new Set(["completed"]),
      timed_out: new Set(["deadline_reached"]),
    } as const;
    if (!expectedCodeByStatus[value.status].has(value.code as never)) {
      context.addIssue({
        code: "custom",
        message: "Terminal code must match the terminal status",
        path: ["code"],
      });
    }
  });

const replayJobShape = {
  createdAt: UtcMillisecondTimestampSchema,
  createdByPrincipalId: OpaqueIdSchema,
  currentLease: ReplayLeaseSchema.optional(),
  jobId: OpaqueIdSchema,
  lastFencingToken: SafeNonnegativeIntegerSchema,
  latestAttemptSequence: SafeNonnegativeIntegerSchema.optional(),
  plan: ReplayPlanJobReferenceSchema,
  recoveryEpoch: SafeNonnegativeIntegerSchema,
  schemaVersion: z.literal(REPLAY_JOB_SCHEMA_VERSION),
  scope: EvidenceScopeSchema,
  startedAt: UtcMillisecondTimestampSchema.optional(),
  stateVersion: SafePositiveIntegerSchema,
  status: ReplayJobStatusSchema,
  terminal: ReplayJobTerminalRecordSchema.optional(),
};

function refineReplayJob(
  value: z.infer<z.ZodObject<typeof replayJobShape>>,
  context: z.RefinementCtx,
): void {
  if (value.status === "queued") {
    if (
      value.lastFencingToken !== 0 ||
      value.currentLease !== undefined ||
      value.latestAttemptSequence !== undefined ||
      value.startedAt !== undefined ||
      value.terminal !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Queued jobs cannot contain lease, attempt, start, or terminal state",
        path: ["status"],
      });
    }
    return;
  }

  const queuedCancellation =
    value.status === "cancelled" &&
    value.terminal !== undefined &&
    value.terminal.attemptId === undefined;
  if (queuedCancellation) {
    if (
      value.lastFencingToken !== 0 ||
      value.currentLease !== undefined ||
      value.latestAttemptSequence !== undefined ||
      value.startedAt !== undefined ||
      value.terminal?.status !== "cancelled"
    ) {
      context.addIssue({
        code: "custom",
        message: "A queued cancellation cannot contain execution state",
        path: ["status"],
      });
    }
    if (
      value.terminal !== undefined &&
      timestampOrder(value.terminal.committedAt) < timestampOrder(value.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Queued cancellation cannot precede job creation",
        path: ["terminal", "committedAt"],
      });
    }
    return;
  }

  if (value.startedAt === undefined || value.latestAttemptSequence === undefined) {
    context.addIssue({
      code: "custom",
      message: "Started jobs require start time and latest attempt sequence",
      path: ["startedAt"],
    });
  }
  if (value.lastFencingToken === 0) {
    context.addIssue({
      code: "custom",
      message: "Started jobs must retain their latest positive fencing token",
      path: ["lastFencingToken"],
    });
  }
  if (
    value.startedAt !== undefined &&
    timestampOrder(value.startedAt) < timestampOrder(value.createdAt)
  ) {
    context.addIssue({
      code: "custom",
      message: "Job start cannot precede creation",
      path: ["startedAt"],
    });
  }

  if (value.status === "running") {
    if (value.currentLease === undefined || value.terminal !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Running jobs require one current lease and no terminal record",
        path: ["status"],
      });
      return;
    }
    const fence = value.currentLease.mutationFence;
    if (
      fence.jobId !== value.jobId ||
      fence.fencingToken !== value.lastFencingToken ||
      fence.recoveryEpoch !== value.recoveryEpoch ||
      value.currentLease.attemptSequence !== value.latestAttemptSequence ||
      value.currentLease.scope.tenantId !== value.scope.tenantId ||
      value.currentLease.scope.projectId !== value.scope.projectId ||
      value.currentLease.scope.environmentId !== value.scope.environmentId
    ) {
      context.addIssue({
        code: "custom",
        message: "Current lease must match the job, recovery epoch, and latest attempt",
        path: ["currentLease"],
      });
    }
    return;
  }

  if (value.currentLease !== undefined || value.terminal === undefined) {
    context.addIssue({
      code: "custom",
      message: "Terminal jobs require one terminal record and no current lease",
      path: ["status"],
    });
    return;
  }
  if (value.terminal.status !== value.status) {
    context.addIssue({
      code: "custom",
      message: "Terminal record status must equal job status",
      path: ["terminal", "status"],
    });
  }
  if (
    timestampOrder(value.terminal.committedAt) < timestampOrder(value.startedAt ?? value.createdAt)
  ) {
    context.addIssue({
      code: "custom",
      message: "Terminal transition cannot precede job execution",
      path: ["terminal", "committedAt"],
    });
  }
}

export const ReplayJobSchema = z.object(replayJobShape).strict().superRefine(refineReplayJob);

export const CreateReplayJobRequestSchema = z
  .object({
    jobId: OpaqueIdSchema,
    plan: ReplayPlanJobReferenceSchema,
  })
  .strict();

export const ReplayAttemptStatusSchema = z.enum([
  "budget_exhausted",
  "cancelled",
  "failed",
  "lease_expired",
  "running",
  "succeeded",
  "timed_out",
]);

export const ReplayEffectCertaintySchema = z.enum(["confirmed", "may_have_occurred", "none"]);

export const ReplayAttemptErrorCodeSchema = z.enum([
  "accounting_violation",
  "authority_denied",
  "boundary_rate_limited",
  "boundary_temporarily_unavailable",
  "budget_exhausted",
  "cancelled",
  "contract_mismatch",
  "credential_unavailable",
  "deadline_exceeded",
  "effect_uncertain",
  "fixture_unavailable",
  "isolation_failed",
  "lease_expired",
  "target_content_unavailable",
  "target_process_interrupted",
  "target_temporary_failure",
  "worker_internal_error",
]);

export const ReplayAttemptErrorSchema = z
  .object({
    code: ReplayAttemptErrorCodeSchema,
    detailsSha256: Sha256Schema.optional(),
    effectCertainty: ReplayEffectCertaintySchema,
    message: canonicalHumanText(
      MAX_REPLAY_ATTEMPT_ERROR_MESSAGE_CHARACTERS,
      "Attempt error message",
    ),
  })
  .strict();

export const ReplayAttemptRetryDispositionSchema = z.enum([
  "not_retryable",
  "retry_eligible",
  "retry_scheduled",
]);

const replayAttemptShape = {
  attemptId: OpaqueIdSchema,
  attemptSequence: SafeNonnegativeIntegerSchema,
  endedAt: UtcMillisecondTimestampSchema.optional(),
  error: ReplayAttemptErrorSchema.optional(),
  jobId: OpaqueIdSchema,
  mutationFence: ReplayWorkerMutationFenceSchema,
  plan: ReplayPlanJobReferenceSchema,
  result: ArtifactContentReferenceSchema.optional(),
  retryDisposition: ReplayAttemptRetryDispositionSchema.optional(),
  runtimeProfile: ReplayRuntimeProfileReferenceSchema,
  isolationProfile: ReplayIsolationProfileReferenceSchema,
  schemaVersion: z.literal(REPLAY_ATTEMPT_SCHEMA_VERSION),
  scope: EvidenceScopeSchema,
  startedAt: UtcMillisecondTimestampSchema,
  status: ReplayAttemptStatusSchema,
  targetRelease: TargetReleaseReferenceSchema,
  workerBuildSha256: Sha256Schema,
  workerProtocol: WorkerProtocolReferenceSchema,
};

function refineReplayAttempt(
  value: z.infer<z.ZodObject<typeof replayAttemptShape>>,
  context: z.RefinementCtx,
): void {
  const fence = value.mutationFence;
  if (
    fence.attemptId !== value.attemptId ||
    fence.jobId !== value.jobId ||
    value.targetRelease.workerProtocol.name !== value.workerProtocol.name ||
    value.targetRelease.workerProtocol.version !== value.workerProtocol.version
  ) {
    context.addIssue({
      code: "custom",
      message: "Attempt identity and worker protocol must match its fence and target release",
      path: ["mutationFence"],
    });
  }

  if (value.status === "running") {
    if (
      value.endedAt !== undefined ||
      value.error !== undefined ||
      value.result !== undefined ||
      value.retryDisposition !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Running attempts cannot contain terminal outcome fields",
        path: ["status"],
      });
    }
    return;
  }

  if (value.endedAt === undefined || value.retryDisposition === undefined) {
    context.addIssue({
      code: "custom",
      message: "Terminal attempts require end time and retry disposition",
      path: ["endedAt"],
    });
  }
  if (
    value.endedAt !== undefined &&
    timestampOrder(value.endedAt) < timestampOrder(value.startedAt)
  ) {
    context.addIssue({
      code: "custom",
      message: "Attempt end cannot precede its start",
      path: ["endedAt"],
    });
  }

  if (value.status === "succeeded") {
    if (
      value.result === undefined ||
      value.error !== undefined ||
      value.retryDisposition !== "not_retryable"
    ) {
      context.addIssue({
        code: "custom",
        message: "Successful attempts require a result and no error or retry",
        path: ["status"],
      });
    }
    return;
  }

  if (value.error === undefined || value.result !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Unsuccessful attempts require an error and cannot publish a result",
      path: ["status"],
    });
  }
  const requiredErrorCodes = {
    budget_exhausted: new Set(["accounting_violation", "budget_exhausted"]),
    cancelled: new Set(["cancelled"]),
    failed: new Set([
      "authority_denied",
      "boundary_rate_limited",
      "boundary_temporarily_unavailable",
      "contract_mismatch",
      "credential_unavailable",
      "effect_uncertain",
      "fixture_unavailable",
      "isolation_failed",
      "target_content_unavailable",
      "target_process_interrupted",
      "target_temporary_failure",
      "worker_internal_error",
    ]),
    lease_expired: new Set(["lease_expired"]),
    timed_out: new Set(["deadline_exceeded"]),
  } as const;
  if (
    value.error !== undefined &&
    !requiredErrorCodes[value.status].has(value.error.code as never)
  ) {
    context.addIssue({
      code: "custom",
      message: "Attempt error code must match its terminal status",
      path: ["error", "code"],
    });
  }
  if (
    value.error?.effectCertainty === "may_have_occurred" &&
    value.retryDisposition !== "not_retryable"
  ) {
    context.addIssue({
      code: "custom",
      message: "Effect uncertainty blocks automatic retry",
      path: ["retryDisposition"],
    });
  }
  const retryableErrorCodes = new Set([
    "boundary_rate_limited",
    "boundary_temporarily_unavailable",
    "target_process_interrupted",
    "target_temporary_failure",
  ]);
  if (
    value.retryDisposition !== undefined &&
    value.retryDisposition !== "not_retryable" &&
    value.status !== "lease_expired" &&
    (value.error === undefined || !retryableErrorCodes.has(value.error.code))
  ) {
    context.addIssue({
      code: "custom",
      message: "Only predeclared retryable error classes can schedule another attempt",
      path: ["retryDisposition"],
    });
  }
  if (
    ["budget_exhausted", "cancelled", "timed_out"].includes(value.status) &&
    value.retryDisposition !== undefined &&
    value.retryDisposition !== "not_retryable"
  ) {
    context.addIssue({
      code: "custom",
      message: "Terminal control outcomes cannot remain merely retry-eligible",
      path: ["retryDisposition"],
    });
  }
  if (value.status === "lease_expired" && value.retryDisposition === "retry_eligible") {
    context.addIssue({
      code: "custom",
      message: "Lease expiry must record whether a retry was scheduled",
      path: ["retryDisposition"],
    });
  }
}

export const ReplayAttemptSchema = z
  .object(replayAttemptShape)
  .strict()
  .superRefine(refineReplayAttempt);

export const ReplayCancellationReasonCodeSchema = z.enum([
  "operator_request",
  "policy_intervention",
  "safety_intervention",
  "superseded",
]);

export const RequestReplayCancellationSchema = z
  .object({
    cancellationId: OpaqueIdSchema,
    reason: canonicalHumanText(MAX_REPLAY_CANCELLATION_REASON_CHARACTERS, "Cancellation reason"),
    reasonCode: ReplayCancellationReasonCodeSchema,
  })
  .strict();

export const ReplayCancellationRequestSchema = z
  .object({
    cancellationId: OpaqueIdSchema,
    jobId: OpaqueIdSchema,
    reason: canonicalHumanText(MAX_REPLAY_CANCELLATION_REASON_CHARACTERS, "Cancellation reason"),
    reasonCode: ReplayCancellationReasonCodeSchema,
    requestedAt: UtcMillisecondTimestampSchema,
    requestedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(REPLAY_CANCELLATION_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict();

export const ReplayCancellationAcknowledgementSchema = z
  .object({
    acknowledgedAt: UtcMillisecondTimestampSchema,
    acknowledgementId: OpaqueIdSchema,
    action: z.enum([
      "observed_after_uninterruptible_completion",
      "stop_requested",
      "stopped_before_target_start",
    ]),
    cancellationId: OpaqueIdSchema,
    mutationFence: ReplayWorkerMutationFenceSchema,
    schemaVersion: z.literal(REPLAY_CANCELLATION_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict();

export type CreateReplayJobRequest = z.infer<typeof CreateReplayJobRequestSchema>;
export type ReplayAttempt = z.infer<typeof ReplayAttemptSchema>;
export type ReplayAttemptError = z.infer<typeof ReplayAttemptErrorSchema>;
export type ReplayAttemptErrorCode = z.infer<typeof ReplayAttemptErrorCodeSchema>;
export type ReplayAttemptRetryDisposition = z.infer<typeof ReplayAttemptRetryDispositionSchema>;
export type ReplayAttemptStatus = z.infer<typeof ReplayAttemptStatusSchema>;
export type ReplayCancellationAcknowledgement = z.infer<
  typeof ReplayCancellationAcknowledgementSchema
>;
export type ReplayCancellationRequest = z.infer<typeof ReplayCancellationRequestSchema>;
export type ReplayCancellationReasonCode = z.infer<typeof ReplayCancellationReasonCodeSchema>;
export type ReplayEffectCertainty = z.infer<typeof ReplayEffectCertaintySchema>;
export type ReplayJob = z.infer<typeof ReplayJobSchema>;
export type ReplayJobStatus = z.infer<typeof ReplayJobStatusSchema>;
export type ReplayJobTerminalCode = z.infer<typeof ReplayJobTerminalCodeSchema>;
export type ReplayJobTerminalRecord = z.infer<typeof ReplayJobTerminalRecordSchema>;
export type ReplayJobTerminalStatus = z.infer<typeof ReplayJobTerminalStatusSchema>;
export type ReplayLease = z.infer<typeof ReplayLeaseSchema>;
export type ReplayPlanJobReference = z.infer<typeof ReplayPlanJobReferenceSchema>;
export type ReplayWorkerMutationFence = z.infer<typeof ReplayWorkerMutationFenceSchema>;
export type RequestReplayCancellation = z.infer<typeof RequestReplayCancellationSchema>;
