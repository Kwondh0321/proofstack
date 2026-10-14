import {
  MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES,
  type PolicyEvaluationJobSnapshot,
  PolicyEvaluationJobSnapshotSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "@proofstack/contracts";
import { PolicyEvaluationJobHistoryError } from "./policy-evaluation-job-history.js";
import { addPolicyEvaluationMillisecondsUpTo } from "./policy-evaluation-scheduler-time.js";
import { chargeUncertainPolicyEvaluationAcquisition } from "./policy-evaluation-acquisition-allowance.js";

/** Trusted recovery transition. Global store epoch must advance before any restored worker runs. */
export function recoverPolicyEvaluationJob(input: {
  readonly snapshot: PolicyEvaluationJobSnapshot;
  readonly now: string;
  readonly recoveryEpoch: number;
}): PolicyEvaluationJobSnapshot {
  const result = PolicyEvaluationJobSnapshotSchema.parse(input.snapshot);
  const now = PolicyEvaluationTimeSchema.parse(input.now);
  const { job, request } = result;
  const time = policyEvaluationTimestampOrderKey;
  if (
    !Number.isSafeInteger(input.recoveryEpoch) ||
    input.recoveryEpoch <= job.recoveryEpoch ||
    time(now) < time(job.updatedAt)
  )
    throw new PolicyEvaluationJobHistoryError(
      "Recovery requires a forward trusted epoch and native receipt",
    );
  if (job.terminal !== null) return result;
  if (job.stateVersion >= MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES)
    throw new PolicyEvaluationJobHistoryError("Recovery history capacity is exhausted");
  const latest = result.attempts.at(-1);
  const acquisitionExhausted = chargeUncertainPolicyEvaluationAcquisition(result);
  const wasActive = job.currentLease !== null;
  const deadlineReached = time(now) >= time(job.deadlineAt);
  const historyReached = job.stateVersion === MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES - 1;
  if (latest?.closure === null) {
    latest.closure = deadlineReached
      ? { status: "timed_out", reason: "deadline_reached", committedAt: now }
      : historyReached
        ? { status: "budget_exhausted", reason: "budget_limit_reached", committedAt: now }
        : { status: "interrupted", reason: "worker_interrupted", committedAt: now };
    latest.usageAtClose = { ...result.usage };
  }
  job.recoveryEpoch = input.recoveryEpoch;
  job.currentLease = null;
  job.updatedAt = now;
  job.stateVersion++;
  if (deadlineReached || historyReached || acquisitionExhausted) {
    job.status = deadlineReached ? "timed_out" : "budget_exhausted";
    job.retryAt = null;
    job.terminal = {
      status: job.status,
      code: deadlineReached ? "deadline_reached" : "budget_limit_reached",
      attemptId: latest?.mutationFence.attemptId ?? null,
      committedAt: now,
    };
  } else if (wasActive) {
    const retryAt = addPolicyEvaluationMillisecondsUpTo(
      now,
      request.limits.retryBackoffMilliseconds,
      job.deadlineAt,
    );
    if (
      time(retryAt) >= time(job.deadlineAt) ||
      result.attempts.length >= request.limits.maxAttempts ||
      !request.limits.retryableErrors.includes("worker_interrupted")
    ) {
      job.status = "failed";
      job.retryAt = null;
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
  } else if (job.status === "retry_ready" && job.retryAt !== null && time(job.retryAt) < time(now))
    job.retryAt = now;
  return PolicyEvaluationJobSnapshotSchema.parse(result);
}
