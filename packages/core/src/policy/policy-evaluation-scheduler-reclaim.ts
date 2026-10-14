import {
  PolicyEvaluationJobSnapshotSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  type PolicyEvaluationJobSnapshot,
} from "@proofstack/contracts";
import { PolicyEvaluationSchedulerTransitionError } from "./policy-evaluation-scheduler-claim.js";
import { addPolicyEvaluationMillisecondsUpTo } from "./policy-evaluation-scheduler-time.js";
import { chargeUncertainPolicyEvaluationAcquisition } from "./policy-evaluation-acquisition-allowance.js";

/** Store-controlled expiry observation. An expired worker cannot invoke its old mutation fence. */
export function reclaimPolicyEvaluationJob(input: {
  readonly snapshot: PolicyEvaluationJobSnapshot;
  readonly now: string;
  readonly recoveryEpoch: number;
}): PolicyEvaluationJobSnapshot {
  const result = PolicyEvaluationJobSnapshotSchema.parse(input.snapshot);
  const now = PolicyEvaluationTimeSchema.parse(input.now);
  const time = policyEvaluationTimestampOrderKey;
  const { job, request } = result;
  const latest = result.attempts.at(-1);
  function fail(reason: PolicyEvaluationSchedulerTransitionError["reason"]): never {
    throw new PolicyEvaluationSchedulerTransitionError(reason);
  }
  if (input.recoveryEpoch !== job.recoveryEpoch) fail("stale_fence");
  if (job.terminal !== null) return result;
  if (time(now) < time(job.updatedAt)) fail("state_conflict");
  const deadlineReached = time(now) >= time(job.deadlineAt);
  const expired = job.currentLease !== null && time(now) >= time(job.currentLease.expiresAt);
  if (expired && !latest) fail("state_conflict");
  if (!deadlineReached && !expired) fail("state_conflict");
  if (job.stateVersion >= Number.MAX_SAFE_INTEGER) fail("counter_exhausted");
  const acquisitionExhausted = chargeUncertainPolicyEvaluationAcquisition(result);
  if (latest?.closure === null) {
    latest.closure = deadlineReached
      ? { status: "timed_out", reason: "deadline_reached", committedAt: now }
      : { status: "interrupted", reason: "lease_expired", committedAt: now };
    latest.usageAtClose = { ...result.usage };
  }
  job.currentLease = null;
  job.updatedAt = now;
  job.stateVersion++;
  job.retryAt = null;
  if (deadlineReached || acquisitionExhausted) {
    job.status = deadlineReached ? "timed_out" : "budget_exhausted";
    job.terminal = {
      status: job.status,
      code: deadlineReached ? "deadline_reached" : "budget_limit_reached",
      attemptId: latest?.mutationFence.attemptId ?? null,
      committedAt: now,
    };
  } else {
    const retryAt = addPolicyEvaluationMillisecondsUpTo(
      now,
      request.limits.retryBackoffMilliseconds,
      job.deadlineAt,
    );
    if (
      time(retryAt) >= time(job.deadlineAt) ||
      result.attempts.length >= request.limits.maxAttempts ||
      !request.limits.retryableErrors.includes("lease_expired")
    ) {
      job.status = "failed";
      job.terminal = {
        status: "failed",
        code: "retries_exhausted",
        attemptId: latest?.mutationFence.attemptId ?? null,
        committedAt: now,
      };
    } else {
      job.status = "retry_ready";
      job.retryAt = retryAt;
    }
  }
  return PolicyEvaluationJobSnapshotSchema.parse(result);
}
