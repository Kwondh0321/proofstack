import {
  PolicyEvaluationJobSnapshotSchema,
  PolicyEvaluationCancellationSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationCancellation,
} from "@proofstack/contracts";
import { PolicyEvaluationSchedulerTransitionError } from "./policy-evaluation-scheduler-claim.js";

/** Serialized store supplies original native receipt and authorized cancellation actor. */
export function cancelPolicyEvaluationJob(input: {
  readonly snapshot: PolicyEvaluationJobSnapshot;
  readonly intent: PolicyEvaluationCancellation;
}): PolicyEvaluationJobSnapshot {
  const result = PolicyEvaluationJobSnapshotSchema.parse(input.snapshot);
  const intent = PolicyEvaluationCancellationSchema.parse(input.intent);
  const { job } = result;
  const fail = (): never => {
    throw new PolicyEvaluationSchedulerTransitionError("state_conflict");
  };
  if (
    intent.jobId !== job.jobId ||
    intent.scope.tenantId !== job.scope.tenantId ||
    intent.scope.projectId !== job.scope.projectId ||
    intent.scope.environmentId !== job.scope.environmentId
  )
    fail();
  if (result.cancellation !== null) {
    const previous = result.cancellation;
    // Retry semantics bind original identity/reason/actor/scope and return its original receipt.
    if (
      previous.cancellationId !== intent.cancellationId ||
      previous.reason !== intent.reason ||
      previous.requestedByPrincipalId !== intent.requestedByPrincipalId
    )
      fail();
    return result;
  }
  if (!["queued", "acquiring", "sealed", "running", "retry_ready"].includes(job.status)) fail();
  const now = PolicyEvaluationTimeSchema.parse(intent.requestedAt);
  if (policyEvaluationTimestampOrderKey(now) < policyEvaluationTimestampOrderKey(job.updatedAt))
    fail();
  if (job.stateVersion >= Number.MAX_SAFE_INTEGER)
    throw new PolicyEvaluationSchedulerTransitionError("counter_exhausted");
  const latest = result.attempts.at(-1);
  if (latest?.closure === null) {
    latest.closure = { status: "cancelled", reason: "cancellation_committed", committedAt: now };
    latest.usageAtClose = { ...result.usage };
  }
  result.cancellation = intent;
  job.status = "cancelled";
  job.currentLease = null;
  job.retryAt = null;
  job.result = null;
  job.terminal = {
    status: "cancelled",
    code: "cancellation_committed",
    attemptId: latest?.mutationFence.attemptId ?? null,
    committedAt: now,
  };
  job.updatedAt = now;
  job.stateVersion++;
  return PolicyEvaluationJobSnapshotSchema.parse(result);
}
