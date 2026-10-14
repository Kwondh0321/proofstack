import {
  MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES,
  PolicyEvaluationJobSnapshotSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  type PolicyEvaluationJobSnapshot,
} from "@proofstack/contracts";
import { PolicyEvaluationJobHistoryError } from "./policy-evaluation-job-history.js";

/** Last fixed history slot is reserved for an operational terminal receipt, never an outcome. */
export function exhaustPolicyEvaluationJobHistory(
  snapshotInput: PolicyEvaluationJobSnapshot,
  nowInput: string,
): PolicyEvaluationJobSnapshot {
  const snapshot = PolicyEvaluationJobSnapshotSchema.parse(snapshotInput);
  const now = PolicyEvaluationTimeSchema.parse(nowInput);
  const { job } = snapshot;
  if (
    job.terminal !== null ||
    job.stateVersion !== MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES - 1 ||
    policyEvaluationTimestampOrderKey(now) < policyEvaluationTimestampOrderKey(job.updatedAt)
  )
    throw new PolicyEvaluationJobHistoryError(
      "History exhaustion requires the exact final reserved slot and forward native receipt",
    );
  const latest = snapshot.attempts.at(-1);
  if (latest?.closure === null) {
    latest.closure = {
      status: "budget_exhausted",
      reason: "budget_limit_reached",
      committedAt: now,
    };
    latest.usageAtClose = { ...snapshot.usage };
  }
  job.status = "budget_exhausted";
  job.currentLease = null;
  job.retryAt = null;
  job.updatedAt = now;
  job.stateVersion++;
  job.terminal = {
    status: "budget_exhausted",
    code: "budget_limit_reached",
    attemptId: latest?.mutationFence.attemptId ?? null,
    committedAt: now,
  };
  return PolicyEvaluationJobSnapshotSchema.parse(snapshot);
}
