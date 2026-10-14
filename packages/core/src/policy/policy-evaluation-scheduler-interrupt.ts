import {
  PolicyEvaluationJobSnapshotSchema,
  PolicyEvaluationTimeSchema,
  PolicyEvaluationRetryableErrorSchema,
  PolicyEvaluationWorkerMutationFenceSchema,
  policyEvaluationTimestampOrderKey,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationWorkerMutationFence,
} from "@proofstack/contracts";
import { addPolicyEvaluationMillisecondsUpTo } from "./policy-evaluation-scheduler-time.js";
import { chargeUncertainPolicyEvaluationAcquisition } from "./policy-evaluation-acquisition-allowance.js";
import { PolicyEvaluationSchedulerTransitionError } from "./policy-evaluation-scheduler-claim.js";

/** Operational interruption only; never receives a rule outcome or chooses a new semantic cut. */
export function interruptPolicyEvaluationJob(input: {
  readonly snapshot: PolicyEvaluationJobSnapshot;
  readonly now: string;
  readonly recoveryEpoch: number;
  readonly fence: PolicyEvaluationWorkerMutationFence;
  readonly reason:
    | "lease_expired"
    | "source_revision_changed"
    | "source_temporarily_unavailable"
    | "worker_interrupted";
}): PolicyEvaluationJobSnapshot {
  const result = PolicyEvaluationJobSnapshotSchema.parse(input.snapshot);
  const now = PolicyEvaluationTimeSchema.parse(input.now);
  const reason = PolicyEvaluationRetryableErrorSchema.parse(input.reason);
  const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(input.fence);
  const { job, request } = result;
  const lease = job.currentLease;
  const latest = result.attempts.at(-1);
  function fail(
    why: ConstructorParameters<typeof PolicyEvaluationSchedulerTransitionError>[0],
  ): never {
    throw new PolicyEvaluationSchedulerTransitionError(why);
  }
  if (
    !lease ||
    !latest ||
    latest.closure !== null ||
    !["acquiring", "sealed", "running"].includes(job.status)
  )
    fail("state_conflict");
  if (
    input.recoveryEpoch !== job.recoveryEpoch ||
    Object.keys(fence).some(
      (key) => fence[key as keyof typeof fence] !== lease.mutationFence[key as keyof typeof fence],
    )
  )
    fail("stale_fence");
  const time = policyEvaluationTimestampOrderKey;
  if (time(now) < time(job.updatedAt)) fail("state_conflict");
  // An expired worker cannot close its own lease. Reclaim is a separate store-controlled path.
  if (time(now) >= time(lease.expiresAt)) fail("lease_expired");
  if (reason === "lease_expired") fail("state_conflict");
  if (job.snapshot !== null && reason === "source_revision_changed") fail("state_conflict");
  if (job.stateVersion >= Number.MAX_SAFE_INTEGER) fail("counter_exhausted");
  const acquisitionExhausted = chargeUncertainPolicyEvaluationAcquisition(result);
  latest.closure = { status: "interrupted", reason, committedAt: now };
  latest.usageAtClose = { ...result.usage };
  job.currentLease = null;
  job.updatedAt = now;
  job.stateVersion++;
  if (acquisitionExhausted) {
    job.status = "budget_exhausted";
    job.retryAt = null;
    job.terminal = {
      status: "budget_exhausted",
      code: "budget_limit_reached",
      attemptId: latest.mutationFence.attemptId,
      committedAt: now,
    };
    return PolicyEvaluationJobSnapshotSchema.parse(result);
  }
  const retryAt = addPolicyEvaluationMillisecondsUpTo(
    now,
    request.limits.retryBackoffMilliseconds,
    job.deadlineAt,
  );
  if (
    time(retryAt) >= time(job.deadlineAt) ||
    result.attempts.length >= request.limits.maxAttempts ||
    !request.limits.retryableErrors.includes(reason)
  ) {
    job.status = "failed";
    job.retryAt = null;
    job.terminal = {
      status: "failed",
      code: "retries_exhausted",
      attemptId: latest.mutationFence.attemptId,
      committedAt: now,
    };
  } else {
    job.status = "retry_ready";
    job.retryAt = retryAt;
  }
  return PolicyEvaluationJobSnapshotSchema.parse(result);
}
