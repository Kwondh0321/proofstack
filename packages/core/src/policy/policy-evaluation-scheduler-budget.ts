import {
  PolicyEvaluationJobSnapshotSchema,
  PolicyEvaluationTimeSchema,
  PolicyEvaluationWorkerMutationFenceSchema,
  PolicyEvaluationUsageSchema,
  policyEvaluationTimestampOrderKey,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationWorkerMutationFence,
  type PolicyEvaluationUsage,
} from "@proofstack/contracts";
import { PolicyEvaluationSchedulerTransitionError } from "./policy-evaluation-scheduler-claim.js";

/** Store calls before I/O with authenticated worker and its current locked epoch/graph. */
export function reservePolicyEvaluationUsage(input: {
  readonly snapshot: PolicyEvaluationJobSnapshot;
  readonly now: string;
  readonly recoveryEpoch: number;
  readonly fence: PolicyEvaluationWorkerMutationFence;
  readonly delta: PolicyEvaluationUsage;
}): PolicyEvaluationJobSnapshot {
  const result = PolicyEvaluationJobSnapshotSchema.parse(input.snapshot);
  const now = PolicyEvaluationTimeSchema.parse(input.now);
  const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(input.fence);
  const delta = PolicyEvaluationUsageSchema.parse(input.delta);
  const { job, request } = result;
  const lease = job.currentLease;
  function fail(
    reason: ConstructorParameters<typeof PolicyEvaluationSchedulerTransitionError>[0],
  ): never {
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
  if (Object.values(delta).every((value) => value === 0)) fail("empty_reservation");
  if (
    result.acquisitionAllowance &&
    [delta.reads, delta.records, delta.references, delta.recordBytes, delta.referenceBytes].some(
      (value) => value !== 0,
    )
  )
    fail("state_conflict");
  if (delta.ruleEvaluations > 0 && job.status !== "running") fail("state_conflict");
  const next = { ...result.usage };
  for (const key of Object.keys(next) as (keyof typeof next)[]) next[key] += delta[key];
  if (
    next.records > request.limits.maxAcquisitionRecords ||
    next.reads > request.limits.maxAcquisitionRecords ||
    next.references > request.limits.maxAcquisitionRecords ||
    next.recordBytes + next.referenceBytes > request.limits.maxAcquisitionRecordBytes ||
    next.artifactReadBytes > request.limits.maxArtifactReadBytes ||
    next.ruleEvaluations > request.limits.maxRuleEvaluations
  )
    fail("budget_exhausted");
  if (job.stateVersion >= Number.MAX_SAFE_INTEGER) fail("counter_exhausted");
  result.usage = next;
  job.updatedAt = now;
  job.stateVersion++;
  return PolicyEvaluationJobSnapshotSchema.parse(result);
}
