import {
  OpaqueIdSchema,
  PolicyEvaluationJobSnapshotSchema,
  PolicyEvaluationAcquisitionUsageSchema,
  serializeEvaluationCanonicalJson,
  type PolicyEvaluationAcquisitionUsage,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationWorkerMutationFence,
} from "@proofstack/contracts";
import { requirePolicyEvaluationLiveFence } from "./policy-evaluation-live-fence.js";
import { PolicyEvaluationSchedulerTransitionError } from "./policy-evaluation-scheduler-claim.js";

export function policyEvaluationMetadataUsage(
  snapshot: PolicyEvaluationJobSnapshot,
): PolicyEvaluationAcquisitionUsage {
  const { reads, records, references, recordBytes, referenceBytes } = snapshot.usage;
  return { reads, records, references, recordBytes, referenceBytes };
}
/** Logical grant only: owning stores must commit it before exposing any acquisition ports. */
export function reservePolicyEvaluationAcquisition(input: {
  readonly snapshot: PolicyEvaluationJobSnapshot;
  readonly now: string;
  readonly recoveryEpoch: number;
  readonly fence: PolicyEvaluationWorkerMutationFence;
  readonly allowanceId: string;
}): PolicyEvaluationJobSnapshot {
  const snapshot = PolicyEvaluationJobSnapshotSchema.parse(input.snapshot);
  requirePolicyEvaluationLiveFence({ ...input, snapshot });
  if (
    snapshot.job.status !== "acquiring" ||
    snapshot.job.snapshot !== null ||
    snapshot.acquisitionAllowance
  )
    throw new PolicyEvaluationSchedulerTransitionError("state_conflict");
  const usage = policyEvaluationMetadataUsage(snapshot);
  const request = snapshot.request;
  const limits = {
    reads: request.limits.maxAcquisitionRecords - usage.reads,
    records: request.limits.maxAcquisitionRecords - usage.records,
    references: request.limits.maxAcquisitionRecords - usage.references,
    recordAndReferenceBytes:
      request.limits.maxAcquisitionRecordBytes - usage.recordBytes - usage.referenceBytes,
  };
  if (limits.reads < 1 || limits.records < 1 || limits.recordAndReferenceBytes < 1)
    throw new PolicyEvaluationSchedulerTransitionError("budget_exhausted");
  if (snapshot.job.stateVersion >= Number.MAX_SAFE_INTEGER)
    throw new PolicyEvaluationSchedulerTransitionError("counter_exhausted");
  snapshot.acquisitionAllowance = {
    schemaVersion: "0.1",
    allowanceId: OpaqueIdSchema.parse(input.allowanceId),
    mutationFence: { ...input.fence },
    reservedAt: input.now,
    usageAtReservation: usage,
    limits,
  };
  snapshot.job.updatedAt = input.now;
  snapshot.job.stateVersion++;
  return PolicyEvaluationJobSnapshotSchema.parse(snapshot);
}
function fullAllowanceUsage(
  snapshot: PolicyEvaluationJobSnapshot,
): PolicyEvaluationAcquisitionUsage {
  const allowance = snapshot.acquisitionAllowance;
  if (!allowance) throw new PolicyEvaluationSchedulerTransitionError("state_conflict");
  return {
    reads: allowance.limits.reads,
    records: allowance.limits.records,
    references: allowance.limits.references,
    recordBytes: allowance.limits.recordAndReferenceBytes,
    referenceBytes: 0,
  };
}
function charge(snapshot: PolicyEvaluationJobSnapshot, usage: PolicyEvaluationAcquisitionUsage) {
  for (const key of ["reads", "records", "references", "recordBytes", "referenceBytes"] as const)
    snapshot.usage[key] += usage[key];
  snapshot.acquisitionAllowance = null;
}
/**
 * Store-controlled cancellation/expiry/recovery boundary on an already validated graph.
 * Unknown in-flight work consumes the full outstanding allowance, never a caller's lower guess.
 */
export function chargeUncertainPolicyEvaluationAcquisition(
  snapshot: PolicyEvaluationJobSnapshot,
): boolean {
  if (!snapshot.acquisitionAllowance) return false;
  charge(snapshot, fullAllowanceUsage(snapshot));
  return true;
}
/** Settle server-observed drained work; null represents unknown work and burns the full allowance. */
export function settlePolicyEvaluationAcquisition(input: {
  readonly snapshot: PolicyEvaluationJobSnapshot;
  readonly now: string;
  readonly recoveryEpoch: number;
  readonly fence: PolicyEvaluationWorkerMutationFence;
  readonly allowanceId: string;
  readonly usage: PolicyEvaluationAcquisitionUsage | null;
}): PolicyEvaluationJobSnapshot {
  const snapshot = PolicyEvaluationJobSnapshotSchema.parse(input.snapshot);
  requirePolicyEvaluationLiveFence({ ...input, snapshot });
  const allowance = snapshot.acquisitionAllowance;
  if (
    !allowance ||
    allowance.allowanceId !== OpaqueIdSchema.parse(input.allowanceId) ||
    serializeEvaluationCanonicalJson(allowance.mutationFence) !==
      serializeEvaluationCanonicalJson(input.fence)
  )
    throw new PolicyEvaluationSchedulerTransitionError("state_conflict");
  const usage =
    input.usage === null
      ? fullAllowanceUsage(snapshot)
      : PolicyEvaluationAcquisitionUsageSchema.parse(input.usage);
  if (
    usage.reads > allowance.limits.reads ||
    usage.records > allowance.limits.records ||
    usage.references > allowance.limits.references ||
    usage.recordBytes + usage.referenceBytes > allowance.limits.recordAndReferenceBytes
  )
    throw new PolicyEvaluationSchedulerTransitionError("budget_exhausted");
  if (snapshot.job.stateVersion >= Number.MAX_SAFE_INTEGER)
    throw new PolicyEvaluationSchedulerTransitionError("counter_exhausted");
  charge(snapshot, usage);
  snapshot.job.updatedAt = input.now;
  snapshot.job.stateVersion++;
  if (input.usage === null) {
    const latest = snapshot.attempts.at(-1);
    if (!latest || latest.closure !== null)
      throw new PolicyEvaluationSchedulerTransitionError("state_conflict");
    latest.closure = {
      status: "budget_exhausted",
      reason: "budget_limit_reached",
      committedAt: input.now,
    };
    latest.usageAtClose = { ...snapshot.usage };
    snapshot.job.status = "budget_exhausted";
    snapshot.job.currentLease = null;
    snapshot.job.retryAt = null;
    snapshot.job.terminal = {
      status: "budget_exhausted",
      code: "budget_limit_reached",
      attemptId: latest.mutationFence.attemptId,
      committedAt: input.now,
    };
  }
  return PolicyEvaluationJobSnapshotSchema.parse(snapshot);
}
