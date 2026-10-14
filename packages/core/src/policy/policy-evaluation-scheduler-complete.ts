import {
  MAX_POLICY_RULES,
  PolicyEvaluationJobSnapshotSchema,
  PolicyEvaluationResultReferenceSchema,
  serializeEvaluationCanonicalJson,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationResultReference,
  type PolicyEvaluationWorkerMutationFence,
} from "@proofstack/contracts";
import { requirePolicyEvaluationLiveFence } from "./policy-evaluation-live-fence.js";
import { PolicyEvaluationSchedulerTransitionError } from "./policy-evaluation-scheduler-claim.js";

/** Logical closure only. The owning store must atomically persist the validated result and intent. */
export function completePolicyEvaluationJob(input: {
  readonly snapshot: PolicyEvaluationJobSnapshot;
  readonly now: string;
  readonly recoveryEpoch: number;
  readonly fence: PolicyEvaluationWorkerMutationFence;
  readonly result: PolicyEvaluationResultReference;
  /** Complete rule inventory derived from the owning sealed input, never a caller subset. */
  readonly ruleCount: number;
}): PolicyEvaluationJobSnapshot {
  const snapshot = PolicyEvaluationJobSnapshotSchema.parse(input.snapshot);
  requirePolicyEvaluationLiveFence({ ...input, snapshot });
  const reference = PolicyEvaluationResultReferenceSchema.parse(input.result);
  const { job } = snapshot;
  const latest = snapshot.attempts.at(-1);
  if (
    job.status !== "running" ||
    job.snapshot === null ||
    job.result !== null ||
    !latest ||
    latest.phase !== "computing" ||
    latest.closure !== null ||
    serializeEvaluationCanonicalJson(latest.snapshot) !==
      serializeEvaluationCanonicalJson(job.snapshot) ||
    !Number.isSafeInteger(input.ruleCount) ||
    input.ruleCount < 1 ||
    input.ruleCount > MAX_POLICY_RULES
  )
    throw new PolicyEvaluationSchedulerTransitionError("state_conflict");
  if (snapshot.usage.ruleEvaluations - latest.usageAtStart.ruleEvaluations < input.ruleCount)
    throw new PolicyEvaluationSchedulerTransitionError("budget_exhausted");
  if (job.stateVersion >= Number.MAX_SAFE_INTEGER)
    throw new PolicyEvaluationSchedulerTransitionError("counter_exhausted");
  latest.closure = { status: "completed", committedAt: input.now };
  latest.usageAtClose = { ...snapshot.usage };
  job.result = reference;
  job.currentLease = null;
  job.retryAt = null;
  job.updatedAt = input.now;
  job.stateVersion++;
  job.status = "completed";
  job.terminal = {
    status: "completed",
    code: "evaluation_completed",
    attemptId: latest.mutationFence.attemptId,
    committedAt: input.now,
  };
  return PolicyEvaluationJobSnapshotSchema.parse(snapshot);
}
