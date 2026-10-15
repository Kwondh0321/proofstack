import {
  OpaqueIdSchema,
  POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND,
  policyEvaluationTimestampOrderKey,
  serializeEvaluationCanonicalJson,
  type PolicyEvaluationRequest,
  type PolicyEvaluationWorkerMutationFence,
  type PolicyEvaluationAcquisitionAllowance,
  type PolicyEvaluationAcquisitionUsage,
  type PolicyEvaluationJobSnapshot,
} from "@proofstack/contracts";
import {
  digestPolicyEvaluationJobDefinition,
  policyEvaluationRequestReference,
  reservePolicyEvaluationAcquisition,
  validatePolicyEvaluationJobSnapshotRecord,
  type PolicyEvaluationAcquisitionRepository,
} from "@proofstack/core";

export interface PolicyAcquisitionAdmission {
  readonly repository: Pick<
    PolicyEvaluationAcquisitionRepository,
    "findJob" | "reserveAcquisition" | "settleAcquisition"
  >;
  readonly allowanceId: string;
}
export class PolicyAcquisitionAdmissionError extends Error {
  readonly code = "policy_acquisition_admission_invalid";
  constructor(message = "Policy acquisition admission did not preserve its owning credit") {
    super(message);
    this.name = "PolicyAcquisitionAdmissionError";
  }
}
const same = (a: unknown, b: unknown) =>
  serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);

/** Committed, fresh owning credit only. Call after execution authorization, before source I/O. */
export async function reservePolicyAcquisitionForSnapshot(
  request: PolicyEvaluationRequest,
  fence: PolicyEvaluationWorkerMutationFence,
  admission: PolicyAcquisitionAdmission,
): Promise<{
  allowance: PolicyEvaluationAcquisitionAllowance;
  requireLive(): void;
  validateSettlement(
    snapshot: unknown,
    usage: PolicyEvaluationAcquisitionUsage | null,
  ): PolicyEvaluationJobSnapshot;
}> {
  const allowanceId = OpaqueIdSchema.parse(admission.allowanceId);
  const expected = {
    scope: request.scope,
    job: {
      jobId: fence.jobId,
      definitionSha256: digestPolicyEvaluationJobDefinition(request.scope, {
        jobId: fence.jobId,
        request: policyEvaluationRequestReference(request),
      }),
    },
  };
  const before = validatePolicyEvaluationJobSnapshotRecord({
    expected,
    snapshot: await admission.repository.findJob(request.scope, fence.jobId),
  });
  if (
    !same(before.request, request) ||
    before.job.status !== "acquiring" ||
    !same(before.job.currentLease?.mutationFence, fence) ||
    before.acquisitionAllowance
  )
    throw new PolicyAcquisitionAdmissionError();
  const started = performance.now();
  const receipt = await admission.repository.reserveAcquisition({
    scope: request.scope,
    fence,
    allowanceId,
  });
  const next = validatePolicyEvaluationJobSnapshotRecord({ expected, snapshot: receipt.snapshot });
  const predicted = reservePolicyEvaluationAcquisition({
    snapshot: before,
    now: next.job.updatedAt,
    recoveryEpoch: fence.recoveryEpoch,
    fence,
    allowanceId,
  });
  if (
    receipt.created !== true ||
    !receipt.allowance ||
    !same(next, predicted) ||
    !same(receipt.allowance, next.acquisitionAllowance)
  )
    throw new PolicyAcquisitionAdmissionError();
  const allowance = structuredClone(receipt.allowance);
  const lease = next.job.currentLease!;
  const cut = policyEvaluationTimestampOrderKey(allowance.reservedAt);
  const expiry = [lease.expiresAt, lease.attemptDeadlineAt, next.job.deadlineAt]
    .map(policyEvaluationTimestampOrderKey)
    .reduce((a, b) => (a < b ? a : b));
  const milliseconds = Number((expiry - cut) / POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND);
  if (milliseconds < 1 || milliseconds > request.limits.leaseDurationMilliseconds)
    throw new PolicyAcquisitionAdmissionError();
  const deadline = started + milliseconds;
  const requireLive = () => {
    if (performance.now() >= deadline)
      throw new PolicyAcquisitionAdmissionError(
        "Acquisition credit expired before I/O or publication",
      );
  };
  requireLive();
  return {
    allowance,
    requireLive,
    validateSettlement(value, usage) {
      const settled = validatePolicyEvaluationJobSnapshotRecord({ expected, snapshot: value });
      if (
        !same(settled.request, request) ||
        settled.acquisitionAllowance !== null ||
        settled.job.createdAt !== before.job.createdAt ||
        settled.job.deadlineAt !== before.job.deadlineAt ||
        settled.job.stateVersion <= next.job.stateVersion ||
        settled.job.snapshot !== null ||
        settled.cancellation !== null ||
        policyEvaluationTimestampOrderKey(settled.job.updatedAt) < cut
      )
        throw new PolicyAcquisitionAdmissionError();
      if (usage === null) {
        const latest = settled.attempts.at(-1);
        if (
          settled.job.status !== "budget_exhausted" ||
          settled.job.currentLease !== null ||
          !same(latest?.mutationFence, fence) ||
          latest?.closure?.status !== "budget_exhausted" ||
          latest.closure.reason !== "budget_limit_reached" ||
          !same(latest.usageAtClose, settled.usage)
        )
          throw new PolicyAcquisitionAdmissionError(
            "Unknown acquisition did not retain its whole owning charge",
          );
      } else if (
        settled.job.status !== "acquiring" ||
        !same(settled.job.currentLease?.mutationFence, fence)
      )
        throw new PolicyAcquisitionAdmissionError();
      const observed = usage ?? {
        reads: allowance.limits.reads,
        records: allowance.limits.records,
        references: allowance.limits.references,
        recordBytes: allowance.limits.recordAndReferenceBytes,
        referenceBytes: 0,
      };
      for (const key of [
        "reads",
        "records",
        "references",
        "recordBytes",
        "referenceBytes",
      ] as const)
        if (settled.usage[key] !== allowance.usageAtReservation[key] + observed[key])
          throw new PolicyAcquisitionAdmissionError(
            "Settlement substituted drained metadata costs",
          );
      if (
        settled.usage.artifactReadBytes < next.usage.artifactReadBytes ||
        settled.usage.ruleEvaluations !== next.usage.ruleEvaluations
      )
        throw new PolicyAcquisitionAdmissionError("Settlement refunded independent owning costs");
      return settled;
    },
  };
}
