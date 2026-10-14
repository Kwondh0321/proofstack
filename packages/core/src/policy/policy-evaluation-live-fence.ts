import {
  PolicyEvaluationJobSnapshotSchema,
  PolicyEvaluationTimeSchema,
  PolicyEvaluationWorkerMutationFenceSchema,
  policyEvaluationTimestampOrderKey,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationWorkerMutationFence,
} from "@proofstack/contracts";
import { PolicyEvaluationSchedulerTransitionError } from "./policy-evaluation-scheduler-claim.js";

/** Serialized store observation, not authority from an arbitrary retained lease document. */
export function requirePolicyEvaluationLiveFence(input: {
  readonly snapshot: PolicyEvaluationJobSnapshot;
  readonly now: string;
  readonly recoveryEpoch: number;
  readonly fence: PolicyEvaluationWorkerMutationFence;
}): void {
  const snapshot = PolicyEvaluationJobSnapshotSchema.parse(input.snapshot);
  const now = PolicyEvaluationTimeSchema.parse(input.now);
  const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(input.fence);
  const { job } = snapshot;
  const lease = job.currentLease;
  function fail(reason: PolicyEvaluationSchedulerTransitionError["reason"]): never {
    throw new PolicyEvaluationSchedulerTransitionError(reason);
  }
  if (!lease || !["acquiring", "sealed", "running"].includes(job.status)) fail("state_conflict");
  if (
    input.recoveryEpoch !== job.recoveryEpoch ||
    Object.keys(fence).some(
      (key) => fence[key as keyof typeof fence] !== lease.mutationFence[key as keyof typeof fence],
    )
  )
    fail("stale_fence");
  const time = policyEvaluationTimestampOrderKey;
  if (time(now) < time(job.updatedAt)) fail("state_conflict");
  if (time(now) >= time(lease.expiresAt)) fail("lease_expired");
  if (time(now) >= time(lease.attemptDeadlineAt) || time(now) >= time(job.deadlineAt))
    fail("deadline_reached");
}
