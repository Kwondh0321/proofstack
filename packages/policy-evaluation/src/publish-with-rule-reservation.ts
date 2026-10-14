import {
  OpaqueIdSchema,
  EvidenceScopeSchema,
  PrincipalContextSchema,
  PolicyEvaluationJobSnapshotSchema,
  PolicyEvaluationWorkerMutationFenceSchema,
  POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND,
  policyEvaluationTimestampOrderKey,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PrincipalContext,
  type PolicyEvaluationSnapshotPageSet,
  type PolicyEvaluationWorkerMutationFence,
} from "@proofstack/contracts";
import {
  ForbiddenError,
  digestPolicyEvaluationJobGraph,
  replayPolicyEvaluationJobHistoryEntry,
  requirePolicyEvaluationExecution,
  validatePolicyEvaluationJobHistoryEntry,
  validatePolicyEvaluationJobSnapshotRecord,
  validatePolicyEvaluationResultRecord,
  validatePolicyEvaluationSnapshotRecord,
  type PolicyEvaluationJobWorkerRepository,
  type PolicyEvaluationResultPublisher,
} from "@proofstack/core";

export class PolicyRuleReservationError extends Error {
  readonly code = "policy_rule_reservation_invalid";
  constructor(message: string) {
    super(message);
    this.name = "PolicyRuleReservationError";
  }
}

/** Trusted worker composition. Original snapshot data is read by the server, not an API caller. */
export async function publishPolicyEvaluationWithReservedRules(
  command: {
    readonly principal: PrincipalContext;
    readonly scope: EvidenceScope;
    readonly fence: PolicyEvaluationWorkerMutationFence;
    readonly evaluationId: string;
  },
  dependencies: {
    readonly repository: Pick<PolicyEvaluationJobWorkerRepository, "findJob" | "reserveWork">;
    readonly publisher: PolicyEvaluationResultPublisher;
    readonly snapshotRecord: unknown;
    readonly pageSet: PolicyEvaluationSnapshotPageSet;
    nextReservationId(): string;
  },
) {
  // Non-delegable execution precedes payload parsing and every dependency call.
  const principal = PrincipalContextSchema.parse(command.principal);
  requirePolicyEvaluationExecution(principal, command.scope);
  const scope = EvidenceScopeSchema.parse(command.scope);
  const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(command.fence);
  if (fence.workerId !== principal.principalId)
    throw new ForbiddenError("Policy computation fence must identify its authenticated worker");
  const evaluationId = OpaqueIdSchema.parse(command.evaluationId);
  const previous = PolicyEvaluationJobSnapshotSchema.parse(
    await dependencies.repository.findJob(scope, fence.jobId),
  );
  const jobReference = {
    jobId: fence.jobId,
    definitionSha256: previous.job.definitionSha256,
  };
  validatePolicyEvaluationJobSnapshotRecord({
    expected: { scope, job: jobReference },
    snapshot: previous,
  });
  const same = (left: unknown, right: unknown) =>
    serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
  if (
    previous.job.status !== "running" ||
    !previous.job.snapshot ||
    !same(previous.job.currentLease?.mutationFence, fence)
  )
    throw new PolicyRuleReservationError("New computation requires its original running attempt");
  const original = validatePolicyEvaluationSnapshotRecord({
    expected: {
      scope,
      jobId: fence.jobId,
      request: previous.job.request,
      snapshot: previous.job.snapshot,
    },
    record: dependencies.snapshotRecord,
    pageSet: dependencies.pageSet,
  });
  const ruleCount = original.inputs.rules.ruleCount;
  const reservationId = OpaqueIdSchema.parse(dependencies.nextReservationId());
  const delta = {
    reads: 0,
    records: 0,
    recordBytes: 0,
    references: 0,
    referenceBytes: 0,
    artifactReadBytes: 0,
    ruleEvaluations: ruleCount,
  };
  const invokedAt = performance.now();
  // This mutation commits independently BEFORE the publisher calculates or starts its transaction.
  // Failure, cancellation, ambiguous receipts and publication rollback never refund this work.
  const receipt = await dependencies.repository.reserveWork({
    scope,
    fence,
    reservationId,
    delta,
  });
  if (receipt.created !== true || receipt.reservation === null)
    throw new PolicyRuleReservationError("Computation requires one fresh reservation occurrence");
  const paid = validatePolicyEvaluationJobSnapshotRecord({
    expected: { scope, job: jobReference },
    snapshot: receipt.snapshot,
  });
  const entry = validatePolicyEvaluationJobHistoryEntry(receipt.reservation);
  if (
    !same(entry.definition.scope, scope) ||
    !same(entry.definition.job, jobReference) ||
    !same(entry.definition.operation, { kind: "reserve", fence, reservationId, delta }) ||
    entry.definition.previousGraphSha256 !== digestPolicyEvaluationJobGraph(previous) ||
    entry.definition.graphSha256 !== digestPolicyEvaluationJobGraph(paid) ||
    !same(replayPolicyEvaluationJobHistoryEntry(previous, entry), paid) ||
    !same(paid.request, previous.request) ||
    !same(paid.job.snapshot, previous.job.snapshot) ||
    !same(paid.job.currentLease?.mutationFence, fence) ||
    paid.job.status !== "running" ||
    paid.usage.ruleEvaluations !== previous.usage.ruleEvaluations + ruleCount
  )
    throw new PolicyRuleReservationError(
      "Rule payment does not bind its complete owning transition",
    );
  const lease = paid.job.currentLease;
  if (!lease) throw new PolicyRuleReservationError("Rule payment omitted its original lease");
  const time = policyEvaluationTimestampOrderKey;
  const expiry = [lease.expiresAt, lease.attemptDeadlineAt, paid.job.deadlineAt]
    .map(time)
    .reduce((left, right) => (left < right ? left : right));
  const milliseconds = Number(
    (expiry - time(entry.definition.committedAt)) / POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND,
  );
  if (
    milliseconds < 1 ||
    milliseconds > paid.request.limits.leaseDurationMilliseconds ||
    performance.now() - invokedAt >= milliseconds
  )
    throw new PolicyRuleReservationError("Rule payment expired before computation began");

  const result = await dependencies.publisher.publishResult({
    scope,
    fence,
    evaluationId,
    pageSet: dependencies.pageSet,
  });
  const completed = validatePolicyEvaluationJobSnapshotRecord({
    expected: { scope, job: jobReference },
    snapshot: result.snapshot,
  });
  const terminal = completed.job.terminal;
  const attempt = completed.attempts.at(-1);
  const reference = completed.job.result;
  if (
    typeof result.created !== "boolean" ||
    completed.job.status !== "completed" ||
    !reference ||
    reference.evaluationId !== evaluationId ||
    !terminal ||
    terminal.code !== "evaluation_completed" ||
    !attempt ||
    attempt.closure?.status !== "completed" ||
    attempt.closure.committedAt !== terminal.committedAt ||
    !same(attempt.mutationFence, fence) ||
    !same(completed.job.snapshot, previous.job.snapshot) ||
    Object.entries(paid.usage).some(
      ([key, value]) => completed.usage[key as keyof typeof paid.usage] < value,
    ) ||
    !same(completed.request, paid.request)
  )
    throw new PolicyRuleReservationError("Completion did not retain its original paid invocation");
  const evaluation = validatePolicyEvaluationResultRecord({
    expected: {
      scope,
      jobId: fence.jobId,
      request: paid.job.request,
      snapshot: previous.job.snapshot,
      result: reference,
      fence,
      completedAt: terminal.committedAt,
    },
    record: result.evaluation,
    snapshotRecord: original.record,
    pageSet: dependencies.pageSet,
  });
  return { created: result.created, evaluation, snapshot: completed };
}
