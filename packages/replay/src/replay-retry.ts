import {
  type ReplayAttemptError,
  ReplayAttemptErrorSchema,
  type ReplayRetryPolicy,
  ReplayRetryPolicySchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";

export type ReplayRetryBlockedReason =
  | "attempt_limit_reached"
  | "automatic_retry_disabled"
  | "deadline_insufficient"
  | "effect_not_retry_safe"
  | "error_not_declared";

export type ReplayRetryDecision =
  | {
      readonly eligible: false;
      readonly reason: ReplayRetryBlockedReason;
    }
  | {
      readonly delayMilliseconds: number;
      readonly eligible: true;
      readonly notBefore: string;
    };

export interface DecideReplayRetryOptions {
  readonly attemptSequence: number;
  readonly error: ReplayAttemptError;
  readonly evaluatedAt?: string;
  readonly failedAt: string;
  readonly jobStartedAt: string;
  readonly policy: ReplayRetryPolicy;
}

function blocked(reason: ReplayRetryBlockedReason): ReplayRetryDecision {
  return { eligible: false, reason };
}

function retryDelay(policy: ReplayRetryPolicy, attemptSequence: number): number {
  if (policy.backoff.kind === "none") return 0;
  if (policy.backoff.kind === "fixed") return policy.backoff.delayMilliseconds;
  let delay = policy.backoff.initialDelayMilliseconds;
  for (let index = 0; index < attemptSequence; index += 1) {
    delay = Math.min(delay * policy.backoff.multiplier, policy.backoff.maximumDelayMilliseconds);
  }
  return delay;
}

function errorDeclared(policy: ReplayRetryPolicy, error: ReplayAttemptError): boolean {
  const declaredCode = error.code === "lease_expired" ? "target_process_interrupted" : error.code;
  return policy.retryableErrors.some((code) => code === declaredCode);
}

function effectRetrySafe(error: ReplayAttemptError): boolean {
  return (
    error.effectCertainty === "none" ||
    error.effectRetrySafety?.kind === "read_only" ||
    error.effectRetrySafety?.kind === "destination_idempotency_verified"
  );
}

function timestamp(value: string): number {
  return Date.parse(UtcMillisecondTimestampSchema.parse(value));
}

export function decideReplayRetry(options: DecideReplayRetryOptions): ReplayRetryDecision {
  const policy = ReplayRetryPolicySchema.parse(options.policy);
  const error = ReplayAttemptErrorSchema.parse(options.error);
  if (!Number.isSafeInteger(options.attemptSequence) || options.attemptSequence < 0) {
    return blocked("attempt_limit_reached");
  }
  if (!policy.automatic) return blocked("automatic_retry_disabled");
  if (options.attemptSequence + 1 >= policy.maxAttempts) {
    return blocked("attempt_limit_reached");
  }
  if (!errorDeclared(policy, error)) return blocked("error_not_declared");
  if (!effectRetrySafe(error)) return blocked("effect_not_retry_safe");

  const failedAt = timestamp(options.failedAt);
  const startedAt = timestamp(options.jobStartedAt);
  const evaluatedAt = options.evaluatedAt === undefined ? failedAt : timestamp(options.evaluatedAt);
  const delayMilliseconds = retryDelay(policy, options.attemptSequence);
  const notBeforeValue = failedAt + delayMilliseconds;
  const deadlineValue = startedAt + policy.totalDeadlineMilliseconds;
  const nextAttemptStartsAt = Math.max(notBeforeValue, evaluatedAt);
  const nextAttemptCompletesAt = nextAttemptStartsAt + policy.perAttemptTimeoutMilliseconds;
  if (
    failedAt < startedAt ||
    evaluatedAt < failedAt ||
    !Number.isSafeInteger(notBeforeValue) ||
    !Number.isSafeInteger(deadlineValue) ||
    !Number.isSafeInteger(nextAttemptStartsAt) ||
    !Number.isSafeInteger(nextAttemptCompletesAt) ||
    nextAttemptCompletesAt > deadlineValue
  ) {
    return blocked("deadline_insufficient");
  }
  return {
    delayMilliseconds,
    eligible: true,
    notBefore: UtcMillisecondTimestampSchema.parse(new Date(notBeforeValue).toISOString()),
  };
}
