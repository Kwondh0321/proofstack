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
    | "release_decision_verification_observation_invalid"
    | "release_decision_verification_source_read_failed";
  constructor(
    readonly reason:
      | "record_limit"
      | "byte_limit"
      | "approval_limit"
      | "invalid_observation"
      | "source_read_failed",
    options?: ErrorOptions,
  ) {
    super(
      reason === "source_read_failed"
        ? "An owning decision verification source read failed"
        : reason === "invalid_observation"
          ? "Invalid canonical decision verification observation"
          : "Decision verification exceeded its original aggregate admission",
      options,
    );
    this.code =
      reason === "source_read_failed"
        ? "release_decision_verification_source_read_failed"
        : reason === "invalid_observation"
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

  /** Admit before discarding; packed histories count every normalized row and encode bytes once. */
  observe(
    record: unknown,
    kind: "metadata" | "approval" = "metadata",
    normalizedRecords = 1,
  ): void {
    if (this.failed) throw this.failed;
    try {
      if (kind !== "metadata" && kind !== "approval")
        throw new TypeError("Invalid observation kind");
      if (
        !Number.isSafeInteger(normalizedRecords) ||
        normalizedRecords < 1 ||
        (kind === "approval" && normalizedRecords !== 1)
      )
        throw new TypeError("Invalid normalized observation count");
      const bytes = encodeEvaluationCanonicalJson(record).byteLength;
      const next = {
        records: this.usage.records + normalizedRecords,
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

  /** A caught owning-port failure taints the cut while preserving its original cause. */
  rejectSourceRead(cause: unknown): never {
    this.failed ??= new ReleaseDecisionVerificationBudgetError("source_read_failed", { cause });
    throw this.failed;
  }

  /** A caught admission or owning-read failure cannot expose a publishable usage report. */
  snapshot(): ReleaseDecisionVerificationUsage {
    if (this.failed) throw this.failed;
    return { ...this.usage };
  }
}
