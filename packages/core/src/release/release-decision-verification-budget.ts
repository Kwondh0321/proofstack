import {
  encodeEvaluationCanonicalJson,
  ReleaseDecisionVerificationLimitsSchema,
  type ReleaseDecisionVerificationLimits,
} from "@proofstack/contracts";

export interface ReleaseDecisionVerificationUsage {
  readonly records: number;
  readonly recordBytes: number;
  readonly approvalRecords: number;
}
export class ReleaseDecisionVerificationBudgetError extends Error {
  readonly code:
    | "release_decision_verification_budget_exhausted"
    | "release_decision_verification_observation_invalid";
  constructor(
    readonly reason: "record_limit" | "byte_limit" | "approval_limit" | "invalid_observation",
    options?: ErrorOptions,
  ) {
    super(
      reason === "invalid_observation"
        ? "Invalid canonical decision verification observation"
        : "Decision verification exceeded its original aggregate admission",
      options,
    );
    this.code =
      reason === "invalid_observation"
        ? "release_decision_verification_observation_invalid"
        : "release_decision_verification_budget_exhausted";
    this.name = "ReleaseDecisionVerificationBudgetError";
  }
}

/** One server-owned meter for the complete cut, including repeated/unavailable observations. */
export class ReleaseDecisionVerificationBudget {
  private readonly limits: ReleaseDecisionVerificationLimits;
  private usage: ReleaseDecisionVerificationUsage = {
    records: 0,
    recordBytes: 0,
    approvalRecords: 0,
  };
  private failed: ReleaseDecisionVerificationBudgetError | undefined;

  constructor(limits: ReleaseDecisionVerificationLimits) {
    this.limits = ReleaseDecisionVerificationLimitsSchema.parse(limits);
  }

  /** Admit each normalized captured observation before validating or discarding it. */
  observe(record: unknown, kind: "metadata" | "approval" = "metadata"): void {
    if (this.failed) throw this.failed;
    try {
      if (kind !== "metadata" && kind !== "approval")
        throw new TypeError("Invalid observation kind");
      const bytes = encodeEvaluationCanonicalJson(record).byteLength;
      const next = {
        records: this.usage.records + 1,
        recordBytes: this.usage.recordBytes + bytes,
        approvalRecords: this.usage.approvalRecords + (kind === "approval" ? 1 : 0),
      };
      if (next.records > this.limits.maxAcquisitionRecords)
        throw new ReleaseDecisionVerificationBudgetError("record_limit");
      if (next.recordBytes > this.limits.maxAcquisitionRecordBytes)
        throw new ReleaseDecisionVerificationBudgetError("byte_limit");
      if (next.approvalRecords > this.limits.maxApprovalRecords)
        throw new ReleaseDecisionVerificationBudgetError("approval_limit");
      this.usage = next;
    } catch (cause) {
      this.failed =
        cause instanceof ReleaseDecisionVerificationBudgetError
          ? cause
          : new ReleaseDecisionVerificationBudgetError("invalid_observation", { cause });
      throw this.failed;
    }
  }

  /** A caught admission failure taints the whole cut; it cannot expose a publishable usage report. */
  snapshot(): ReleaseDecisionVerificationUsage {
    if (this.failed) throw this.failed;
    return { ...this.usage };
  }
}
