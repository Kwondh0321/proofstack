import {
  PolicyEvaluationJobSnapshotSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  OpaqueIdSchema,
  PolicyEvaluationWorkerMutationFenceSchema,
  POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationWorkerMutationFence,
} from "@proofstack/contracts";
import { addPolicyEvaluationMillisecondsUpTo } from "./policy-evaluation-scheduler-time.js";

export class PolicyEvaluationSchedulerTransitionError extends Error {
  readonly code = "policy_evaluation_scheduler_transition_rejected";
  constructor(
    readonly reason:
      | "state_conflict"
      | "deadline_reached"
      | "retry_not_ready"
      | "retries_exhausted"
      | "stale_fence"
      | "lease_expired"
      | "identifier_reused"
      | "counter_exhausted"
      | "heartbeat_not_ready"
      | "empty_reservation"
      | "budget_exhausted",
  ) {
    super(`Policy scheduler transition: ${reason}`);
    this.name = "PolicyEvaluationSchedulerTransitionError";
  }
}
function reject(reason: PolicyEvaluationSchedulerTransitionError["reason"]): never {
  throw new PolicyEvaluationSchedulerTransitionError(reason);
}
function increment(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) reject("counter_exhausted");
  return value + 1;
}
/** Pure fixed transition. Store supplies serialized current graph, native clock and current epoch. */
export function claimPolicyEvaluationJob(input: {
  readonly snapshot: PolicyEvaluationJobSnapshot;
  readonly now: string;
  readonly recoveryEpoch: number;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly workerId: string;
}): PolicyEvaluationJobSnapshot {
  const result = PolicyEvaluationJobSnapshotSchema.parse(input.snapshot);
  const now = PolicyEvaluationTimeSchema.parse(input.now);
  const { job, request, attempts, usage } = result;
  const epoch = input.recoveryEpoch;
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch !== job.recoveryEpoch)
    reject("stale_fence");
  if (job.status !== "queued" && job.status !== "retry_ready") reject("state_conflict");
  if (policyEvaluationTimestampOrderKey(now) < policyEvaluationTimestampOrderKey(job.updatedAt))
    reject("state_conflict");
  if (policyEvaluationTimestampOrderKey(now) >= policyEvaluationTimestampOrderKey(job.deadlineAt))
    reject("deadline_reached");
  if (
    job.retryAt !== null &&
    policyEvaluationTimestampOrderKey(now) < policyEvaluationTimestampOrderKey(job.retryAt)
  )
    reject("retry_not_ready");
  if (attempts.length >= request.limits.maxAttempts) reject("retries_exhausted");
  const attemptId = OpaqueIdSchema.parse(input.attemptId);
  const leaseId = OpaqueIdSchema.parse(input.leaseId);
  const workerId = OpaqueIdSchema.parse(input.workerId);
  if (
    attempts.some(
      (attempt) =>
        attempt.mutationFence.attemptId === attemptId || attempt.mutationFence.leaseId === leaseId,
    )
  )
    reject("identifier_reused");
  const fence: PolicyEvaluationWorkerMutationFence = {
    jobId: job.jobId,
    attemptId,
    leaseId,
    workerId,
    recoveryEpoch: epoch,
    fencingToken: increment(job.lastFencingToken),
  };
  const attemptDeadline = addPolicyEvaluationMillisecondsUpTo(
    now,
    request.limits.perAttemptTimeoutMilliseconds,
    job.deadlineAt,
  );
  const expiry = addPolicyEvaluationMillisecondsUpTo(
    now,
    request.limits.leaseDurationMilliseconds,
    attemptDeadline,
  );
  attempts.push({
    schemaVersion: "0.1",
    scope: job.scope,
    mutationFence: fence,
    attemptSequence: attempts.length,
    startedAt: now,
    deadlineAt: attemptDeadline,
    phase: job.snapshot === null ? "acquiring" : "computing",
    snapshot: job.snapshot,
    usageAtStart: { ...usage },
    usageAtClose: null,
    closure: null,
  });
  job.currentLease = {
    schemaVersion: "0.1",
    scope: job.scope,
    mutationFence: fence,
    attemptSequence: attempts.length - 1,
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: expiry,
    attemptDeadlineAt: attemptDeadline,
    jobDeadlineAt: job.deadlineAt,
  };
  job.status = job.snapshot === null ? "acquiring" : "running";
  job.attemptCount = attempts.length;
  job.lastFencingToken = fence.fencingToken;
  job.stateVersion = increment(job.stateVersion);
  job.updatedAt = now;
  job.retryAt = null;
  return PolicyEvaluationJobSnapshotSchema.parse(result);
}

/** Shape consistency alone cannot authorize this operation: serialized store verifies its fence. */
export function heartbeatPolicyEvaluationJob(input: {
  readonly snapshot: PolicyEvaluationJobSnapshot;
  readonly now: string;
  readonly recoveryEpoch: number;
  readonly fence: PolicyEvaluationWorkerMutationFence;
}): PolicyEvaluationJobSnapshot {
  const result = PolicyEvaluationJobSnapshotSchema.parse(input.snapshot);
  const now = PolicyEvaluationTimeSchema.parse(input.now);
  const { job, request } = result;
  const lease = job.currentLease;
  const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(input.fence);
  if (!lease || !["acquiring", "sealed", "running"].includes(job.status)) reject("state_conflict");
  if (
    input.recoveryEpoch !== job.recoveryEpoch ||
    Object.keys(lease.mutationFence).some(
      (key) =>
        lease.mutationFence[key as keyof typeof lease.mutationFence] !==
        fence[key as keyof typeof fence],
    )
  )
    reject("stale_fence");
  const time = policyEvaluationTimestampOrderKey;
  if (time(now) < time(job.updatedAt)) reject("state_conflict");
  if (time(now) >= time(lease.expiresAt)) reject("lease_expired");
  if (time(now) >= time(lease.attemptDeadlineAt) || time(now) >= time(job.deadlineAt))
    reject("deadline_reached");
  if (
    time(now) <
    time(lease.heartbeatAt) +
      BigInt(request.limits.heartbeatIntervalMilliseconds) *
        POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND
  )
    reject("heartbeat_not_ready");
  lease.heartbeatAt = now;
  lease.expiresAt = addPolicyEvaluationMillisecondsUpTo(
    now,
    request.limits.leaseDurationMilliseconds,
    lease.attemptDeadlineAt,
  );
  job.updatedAt = now;
  job.stateVersion = increment(job.stateVersion);
  return PolicyEvaluationJobSnapshotSchema.parse(result);
}
