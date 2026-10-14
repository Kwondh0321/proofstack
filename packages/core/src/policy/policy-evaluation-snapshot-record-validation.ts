import {
  PolicyEvaluationSnapshotSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PolicyEvaluationRequestReference,
  type PolicyEvaluationSnapshot,
  type PolicyEvaluationSnapshotPageSet,
  type PolicyEvaluationSnapshotReference,
} from "@proofstack/contracts";
import {
  PolicyEvaluationSnapshotIntegrityError,
  validatePolicyEvaluationSnapshot,
} from "./policy-evaluation-snapshot.js";

/** Historical owning integrity only. Expected identity must come from the owning job, not a caller. */
export function validatePolicyEvaluationSnapshotRecord(input: {
  readonly expected: {
    readonly scope: EvidenceScope;
    readonly snapshot: PolicyEvaluationSnapshotReference;
    readonly request: PolicyEvaluationRequestReference;
    readonly jobId: string;
  };
  readonly record: unknown;
  readonly pageSet: PolicyEvaluationSnapshotPageSet;
}): {
  readonly record: PolicyEvaluationSnapshot;
  readonly inputs: ReturnType<typeof validatePolicyEvaluationSnapshot>;
} {
  const parsed = PolicyEvaluationSnapshotSchema.safeParse(input.record);
  if (!parsed.success)
    throw new PolicyEvaluationSnapshotIntegrityError("invalid_snapshot", { cause: parsed.error });
  const record = parsed.data;
  const same = (left: unknown, right: unknown) =>
    serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
  if (
    !same(record.scope, input.expected.scope) ||
    !same(record.request, input.expected.request) ||
    record.jobId !== input.expected.jobId ||
    record.snapshotId !== input.expected.snapshot.snapshotId ||
    record.definitionSha256 !== input.expected.snapshot.definitionSha256 ||
    record.sealedByPrincipalId !== record.workerId
  )
    throw new PolicyEvaluationSnapshotIntegrityError("reference_mismatch");
  const inputs = validatePolicyEvaluationSnapshot({
    expected: input.expected,
    pageSet: input.pageSet,
  });
  const {
    scope: _scope,
    schemaVersion: _version,
    definitionSha256: _digest,
    sealedAt: _sealed,
    sealedByPrincipalId: _principal,
    jobId: _job,
    attemptId: _attempt,
    workerId: _worker,
    leaseId: _lease,
    fencingToken: _fence,
    recoveryEpoch: _epoch,
    recordedAt: _recorded,
    ...definition
  } = record;
  if (!same(definition, input.pageSet.definition))
    throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
  return { record, inputs };
}
