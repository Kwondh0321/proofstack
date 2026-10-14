import { createHash } from "node:crypto";
import {
  encodePolicyEvaluationDefinition,
  PolicyEvaluationSchema,
  PolicyEvaluationSnapshotSchema,
  policyEvaluationTimestampOrderKey,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PolicyEvaluationDefinition,
  type PolicyEvaluation,
  type PolicyEvaluationResultReference,
  type PolicyEvaluationWorkerMutationFence,
  type PolicyEvaluationSnapshotPageSet,
} from "@proofstack/contracts";
import { computeSealedPolicyEvaluation } from "./compute-sealed-policy-evaluation.js";

export class PolicyEvaluationResultIntegrityError extends Error {
  readonly code = "policy_evaluation_result_invalid";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PolicyEvaluationResultIntegrityError";
  }
}
export function digestPolicyEvaluationDefinition(
  scope: EvidenceScope,
  definition: PolicyEvaluationDefinition,
): string {
  return createHash("sha256")
    .update(encodePolicyEvaluationDefinition({ scope, definition }))
    .digest("hex");
}
/** Recompute historical evidence from the owning immutable seal; this never revives execution authority. */
export function validatePolicyEvaluationResultRecord(input: {
  readonly expected: Parameters<typeof computeSealedPolicyEvaluation>[0]["expected"] & {
    readonly result: PolicyEvaluationResultReference;
    readonly fence: PolicyEvaluationWorkerMutationFence;
    /** Original terminal-job receipt; not a new observation clock. */
    readonly completedAt: string;
  };
  readonly record: unknown;
  readonly snapshotRecord: unknown;
  readonly pageSet: PolicyEvaluationSnapshotPageSet;
}): PolicyEvaluation {
  try {
    const record = PolicyEvaluationSchema.parse(input.record);
    const snapshotRecord = PolicyEvaluationSnapshotSchema.parse(input.snapshotRecord);
    const same = (a: unknown, b: unknown) =>
      serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
    const fence = input.expected.fence;
    if (
      !same(record.scope, input.expected.scope) ||
      record.jobId !== input.expected.jobId ||
      fence.jobId !== input.expected.jobId ||
      record.evaluationId !== input.expected.result.evaluationId ||
      record.definitionSha256 !== input.expected.result.definitionSha256 ||
      record.recordedAt !== input.expected.completedAt ||
      record.recordedByPrincipalId !== fence.workerId ||
      record.attemptId !== fence.attemptId ||
      record.workerId !== fence.workerId ||
      record.leaseId !== fence.leaseId ||
      record.fencingToken !== fence.fencingToken ||
      record.recoveryEpoch !== fence.recoveryEpoch
    )
      throw new Error("Stored result substituted owning scope, receipt or execution identity");
    const {
      scope,
      schemaVersion: _version,
      definitionSha256: _digest,
      recordedAt: _at,
      recordedByPrincipalId: _principal,
      jobId: _job,
      attemptId: _attempt,
      workerId: _worker,
      leaseId: _lease,
      fencingToken: _fence,
      recoveryEpoch: _epoch,
      ...definition
    } = record;
    if (digestPolicyEvaluationDefinition(scope, definition) !== record.definitionSha256)
      throw new Error("Result canonical definition digest mismatch");
    const expected = computeSealedPolicyEvaluation({
      evaluationId: record.evaluationId,
      expected: input.expected,
      record: snapshotRecord,
      pageSet: input.pageSet,
    });
    if (!same(definition, expected))
      throw new Error("Result differs from deterministic sealed evidence");
    if (
      policyEvaluationTimestampOrderKey(record.recordedAt) <
      policyEvaluationTimestampOrderKey(snapshotRecord.sealedAt)
    )
      throw new Error("Result receipt precedes its owning seal");
    return record;
  } catch (cause) {
    throw new PolicyEvaluationResultIntegrityError("Invalid owning policy result", { cause });
  }
}
