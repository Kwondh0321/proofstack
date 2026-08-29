import {
  type ReplayCancellationRequest,
  ReplayCancellationRequestSchema,
  type ReplayJob,
  ReplayJobSchema,
} from "@proofstack/contracts";

export const REPLAY_JOB_OUTBOX_SCHEMA_VERSION = "0.1" as const;
export const REPLAY_JOB_AGGREGATE_TYPE = "replay.job" as const;
export const REPLAY_JOB_CREATED_EVENT_TYPE = "replay.job.created" as const;
export const REPLAY_JOB_CANCELLATION_REQUESTED_EVENT_TYPE =
  "replay.job.cancellation-requested" as const;
export const REPLAY_JOB_TERMINAL_EVENT_TYPE = "replay.job.terminal" as const;

export interface ReplayJobOutboxIntent {
  readonly aggregateId: string;
  readonly aggregateType: typeof REPLAY_JOB_AGGREGATE_TYPE;
  readonly createdAt: string;
  readonly eventType:
    | typeof REPLAY_JOB_CANCELLATION_REQUESTED_EVENT_TYPE
    | typeof REPLAY_JOB_CREATED_EVENT_TYPE
    | typeof REPLAY_JOB_TERMINAL_EVENT_TYPE;
  readonly payload: Readonly<Record<string, boolean | number | string>>;
  readonly schemaVersion: typeof REPLAY_JOB_OUTBOX_SCHEMA_VERSION;
  readonly tenantId: string;
}

function base(job: ReplayJob, createdAt: string, eventType: ReplayJobOutboxIntent["eventType"]) {
  return {
    aggregateId: job.jobId,
    aggregateType: REPLAY_JOB_AGGREGATE_TYPE,
    createdAt,
    eventType,
    schemaVersion: REPLAY_JOB_OUTBOX_SCHEMA_VERSION,
    tenantId: job.scope.tenantId,
  } as const;
}

export function buildReplayJobCreatedOutboxIntent(input: unknown): ReplayJobOutboxIntent {
  const job = ReplayJobSchema.parse(input);
  return {
    ...base(job, job.createdAt, REPLAY_JOB_CREATED_EVENT_TYPE),
    payload: {
      definitionSha256: job.plan.definitionSha256,
      environmentId: job.scope.environmentId,
      jobId: job.jobId,
      planId: job.plan.planId,
      planVersionId: job.plan.planVersionId,
      projectId: job.scope.projectId,
    },
  };
}

export function buildReplayJobCancellationRequestedOutboxIntent(
  jobInput: unknown,
  requestInput: unknown,
): ReplayJobOutboxIntent {
  const job = ReplayJobSchema.parse(jobInput);
  const request: ReplayCancellationRequest = ReplayCancellationRequestSchema.parse(requestInput);
  if (
    request.jobId !== job.jobId ||
    request.scope.tenantId !== job.scope.tenantId ||
    request.scope.projectId !== job.scope.projectId ||
    request.scope.environmentId !== job.scope.environmentId
  ) {
    throw new TypeError("Replay cancellation outbox scope does not match its job");
  }
  return {
    ...base(job, request.requestedAt, REPLAY_JOB_CANCELLATION_REQUESTED_EVENT_TYPE),
    payload: {
      cancellationId: request.cancellationId,
      environmentId: job.scope.environmentId,
      jobId: job.jobId,
      projectId: job.scope.projectId,
      reasonCode: request.reasonCode,
    },
  };
}

export function buildReplayJobTerminalOutboxIntent(input: unknown): ReplayJobOutboxIntent {
  const job = ReplayJobSchema.parse(input);
  if (!job.terminal) throw new TypeError("Replay terminal outbox requires a terminal job");
  return {
    ...base(job, job.terminal.committedAt, REPLAY_JOB_TERMINAL_EVENT_TYPE),
    payload: {
      code: job.terminal.code,
      environmentId: job.scope.environmentId,
      jobId: job.jobId,
      projectId: job.scope.projectId,
      stateVersion: job.stateVersion,
      status: job.status,
    },
  };
}
