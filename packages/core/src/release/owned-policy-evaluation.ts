import {
  EvidenceScopeSchema,
  MAX_POLICY_EVALUATION_ATTEMPTS,
  PolicyEvaluationJobReferenceSchema,
  PolicyEvaluationRequestReferenceSchema,
  PolicyEvaluationSnapshotSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PolicyEvaluationJobReference,
  type PolicyEvaluationRequestReference,
  type PolicyEvaluationSnapshotPageSet,
} from "@proofstack/contracts";
import { inspectValidatedPolicyPrerequisites } from "../policy/compute-sealed-policy-evaluation.js";
import { validatePolicyEvaluationJobSnapshotRecord } from "../policy/policy-evaluation-job-record-validation.js";
import { validatePolicyEvaluationResultRecord } from "../policy/policy-evaluation-result-record-validation.js";
import { validatePolicyEvaluationSnapshotRecord } from "../policy/policy-evaluation-snapshot-record-validation.js";
import { validateReleasePolicyRecord } from "../policy/release-policy-record-validation.js";
import { validateReleaseCandidateRecord } from "./release-candidate-record-validation.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";

export class InvalidOwnedPolicyEvaluationError extends Error {
  readonly code = "owned_policy_evaluation_invalid";
  constructor(options?: ErrorOptions) {
    super("Invalid original owning policy evaluation graph", options);
    this.name = "InvalidOwnedPolicyEvaluationError";
  }
}
function same(left: unknown, right: unknown): boolean {
  return serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
}

/**
 * Recompute one exact original result and its prerequisite facts, including approval-only roots.
 * Expected job identity comes from the owning request selector. This is historical integrity,
 * not proof of current publisher/reviewer authority or a retained native publication guard.
 */
export function inspectOwnedPolicyEvaluation(input: {
  readonly expected: {
    readonly scope: EvidenceScope;
    readonly request: PolicyEvaluationRequestReference;
    readonly job: PolicyEvaluationJobReference;
  };
  readonly jobGraph: unknown;
  readonly snapshot: unknown;
  readonly pageSet: PolicyEvaluationSnapshotPageSet;
  readonly evaluation: unknown;
  readonly capturedAt: string;
  readonly budget: ReleaseDecisionVerificationBudget;
}) {
  try {
    const scope = EvidenceScopeSchema.parse(input.expected.scope);
    const requestReference = PolicyEvaluationRequestReferenceSchema.parse(input.expected.request);
    const jobReference = PolicyEvaluationJobReferenceSchema.parse(input.expected.job);
    const cut = policyEvaluationTimestampOrderKey(
      PolicyEvaluationTimeSchema.parse(input.capturedAt),
    );
    if (!input.jobGraph || typeof input.jobGraph !== "object" || Array.isArray(input.jobGraph))
      throw new InvalidOwnedPolicyEvaluationError();
    const raw = input.jobGraph as Record<string, unknown>;
    input.budget.observe(raw["request"]);
    input.budget.observe(raw["job"]);
    if (!Array.isArray(raw["attempts"]) || raw["attempts"].length > MAX_POLICY_EVALUATION_ATTEMPTS)
      throw new InvalidOwnedPolicyEvaluationError();
    for (const attempt of raw["attempts"]) input.budget.observe(attempt);
    if (raw["cancellation"] !== null) input.budget.observe(raw["cancellation"]);
    if (raw["acquisitionAllowance"]) input.budget.observe(raw["acquisitionAllowance"]);
    input.budget.observe(input.snapshot);
    input.budget.observe(input.evaluation);
    if (!Array.isArray(input.pageSet?.pages)) throw new InvalidOwnedPolicyEvaluationError();
    for (const page of input.pageSet.pages) input.budget.observe(page);
    const graph = validatePolicyEvaluationJobSnapshotRecord({
      expected: { scope, job: jobReference },
      snapshot: input.jobGraph,
    });
    const { job } = graph;
    if (
      !same(job.request, requestReference) ||
      job.status !== "completed" ||
      !job.snapshot ||
      !job.result ||
      job.terminal?.status !== "completed"
    )
      throw new InvalidOwnedPolicyEvaluationError();
    const terminal = job.terminal;
    const deciding = graph.attempts.find(
      (attempt) => attempt.mutationFence.attemptId === terminal.attemptId,
    );
    if (
      !deciding ||
      deciding.closure?.status !== "completed" ||
      deciding.closure.committedAt !== terminal.committedAt ||
      deciding.mutationFence.fencingToken !== job.lastFencingToken
    )
      throw new InvalidOwnedPolicyEvaluationError();
    const snapshot = PolicyEvaluationSnapshotSchema.parse(input.snapshot);
    const sealing = graph.attempts.find(
      (attempt) => attempt.mutationFence.attemptId === snapshot.attemptId,
    );
    if (
      !sealing ||
      sealing.phase !== "computing" ||
      !same(sealing.snapshot, job.snapshot) ||
      !same(sealing.mutationFence, {
        jobId: snapshot.jobId,
        attemptId: snapshot.attemptId,
        workerId: snapshot.workerId,
        leaseId: snapshot.leaseId,
        fencingToken: snapshot.fencingToken,
        recoveryEpoch: snapshot.recoveryEpoch,
      }) ||
      policyEvaluationTimestampOrderKey(snapshot.recordedAt) >
        policyEvaluationTimestampOrderKey(terminal.committedAt) ||
      policyEvaluationTimestampOrderKey(job.updatedAt) > cut ||
      policyEvaluationTimestampOrderKey(terminal.committedAt) > cut
    )
      throw new InvalidOwnedPolicyEvaluationError();
    const expected = {
      scope,
      jobId: job.jobId,
      request: requestReference,
      snapshot: job.snapshot,
      result: job.result,
      fence: deciding.mutationFence,
      completedAt: terminal.committedAt,
    };
    const original = validatePolicyEvaluationSnapshotRecord({
      expected,
      record: snapshot,
      pageSet: input.pageSet,
    });
    if (original.inputs.schemaVersion !== "0.2" || !same(original.inputs.request, graph.request))
      throw new InvalidOwnedPolicyEvaluationError();
    const evaluation = validatePolicyEvaluationResultRecord({
      expected,
      record: input.evaluation,
      snapshotRecord: snapshot,
      pageSet: input.pageSet,
    });
    const candidate = validateReleaseCandidateRecord(original.inputs.roots.candidate);
    const policy = validateReleasePolicyRecord(original.inputs.roots.policy);
    return {
      request: graph.request,
      job,
      decidingAttempt: deciding,
      snapshot,
      evaluation,
      candidate,
      policy,
      prerequisites: inspectValidatedPolicyPrerequisites(original.inputs),
      originalSourceWitnesses: structuredClone(original.inputs.sources.records.records),
    };
  } catch (cause) {
    if (
      cause instanceof InvalidOwnedPolicyEvaluationError ||
      cause instanceof ReleaseDecisionVerificationBudgetError
    )
      throw cause;
    throw new InvalidOwnedPolicyEvaluationError({ cause });
  }
}
