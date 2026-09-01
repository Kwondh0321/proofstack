import {
  type EvaluationAggregateDefinition,
  EvaluationAggregateDefinitionSchema,
  type EvaluationAggregationPolicy,
  EvaluationAggregationPolicySchema,
  MAX_EVALUATION_AGGREGATE_MEMBERS,
  WILSON_INTERVAL_METHOD_VERSION,
} from "@proofstack/contracts";

type AggregateMember = EvaluationAggregateDefinition["members"][number];
type SamplingAssumption = EvaluationAggregateDefinition["samplingAssumption"];

export type ReferenceAggregateErrorCode =
  | "incompatible_sampling_assumption"
  | "invalid_aggregate"
  | "invalid_policy"
  | "numerical_failure";

export class ReferenceAggregateError extends Error {
  constructor(
    readonly code: ReferenceAggregateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReferenceAggregateError";
  }
}

export interface ReferenceAggregateRequest {
  readonly aggregateId: EvaluationAggregateDefinition["aggregateId"];
  readonly criterion: EvaluationAggregateDefinition["criterion"];
  readonly knownLimitations: readonly string[];
  readonly members: readonly AggregateMember[];
  readonly policy: EvaluationAggregationPolicy;
  readonly samplingAssumption: SamplingAssumption;
}

function memberKey(member: AggregateMember): string {
  return `${member.run.evaluationRunId}:${member.result.resultId}`;
}

function exactRatio(numerator: number, denominator: number) {
  return denominator === 0
    ? ({ reason: "zero_denominator", status: "unavailable" } as const)
    : ({ denominator, numerator, status: "available" } as const);
}

function countVerdicts(members: readonly AggregateMember[]) {
  const counts = {
    abstainCount: 0,
    errorCount: 0,
    failCount: 0,
    notApplicableCount: 0,
    passCount: 0,
  };
  for (const member of members) {
    switch (member.verdict) {
      case "abstain":
        counts.abstainCount += 1;
        break;
      case "error":
        counts.errorCount += 1;
        break;
      case "fail":
        counts.failCount += 1;
        break;
      case "not_applicable":
        counts.notApplicableCount += 1;
        break;
      case "pass":
        counts.passCount += 1;
        break;
    }
  }
  const applicableCount =
    counts.passCount + counts.failCount + counts.abstainCount + counts.errorCount;
  const decidedCount = counts.passCount + counts.failCount;
  return {
    ...counts,
    applicableCount,
    attemptedCount: members.length,
    decidedCount,
    selectedCount: members.length,
  };
}

// Peter J. Acklam's inverse-normal rational approximation. The input range is
// bounded by the policy contract, so neither endpoint can reach infinity.
function inverseStandardNormal(probability: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ] as const;
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ] as const;
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ] as const;
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
  ] as const;
  const upperTail = 1 - 0.02425;

  // A two-sided confidence level of at least 50% maps to p >= 0.75, so only
  // the central and upper-tail branches are reachable for this public API.
  if (probability > upperTail) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  const q = probability - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

function unitDecimal(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ReferenceAggregateError(
      "numerical_failure",
      "The Wilson calculation produced a non-finite bound",
    );
  }
  const bounded = Math.min(1, Math.max(0, value));
  const fixed = bounded.toFixed(18);
  return fixed.replace(/\.0+$/, "").replace(/(\.[0-9]*?)0+$/, "$1");
}

/**
 * Computes a two-sided Wilson score interval for a binomial pass proportion.
 * Abstentions, errors, and non-applicable cases must never be included in `trialCount`.
 */
export function computeWilsonScoreInterval(
  successCount: number,
  trialCount: number,
  confidenceLevelBasisPoints: number,
): Extract<
  EvaluationAggregateDefinition["passInterval"],
  { readonly status: "reported" }
>["interval"] {
  if (
    !Number.isSafeInteger(successCount) ||
    !Number.isSafeInteger(trialCount) ||
    successCount < 0 ||
    trialCount <= 0 ||
    successCount > MAX_EVALUATION_AGGREGATE_MEMBERS ||
    trialCount > MAX_EVALUATION_AGGREGATE_MEMBERS ||
    successCount > trialCount ||
    !Number.isInteger(confidenceLevelBasisPoints) ||
    confidenceLevelBasisPoints < 5_000 ||
    confidenceLevelBasisPoints > 9_999
  ) {
    throw new ReferenceAggregateError(
      "numerical_failure",
      "Wilson counts or confidence level are outside the bounded contract",
    );
  }

  const confidence = confidenceLevelBasisPoints / 10_000;
  const z = inverseStandardNormal((1 + confidence) / 2);
  const zSquared = z * z;
  const proportion = successCount / trialCount;
  const denominator = 1 + zSquared / trialCount;
  const center = (proportion + zSquared / (2 * trialCount)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt(
      (proportion * (1 - proportion)) / trialCount + zSquared / (4 * trialCount * trialCount),
    );

  return {
    confidenceLevelBasisPoints,
    lowerBound: unitDecimal(successCount === 0 ? 0 : center - margin),
    method: "wilson_score_interval",
    methodVersion: WILSON_INTERVAL_METHOD_VERSION,
    successCount,
    trialCount,
    upperBound: unitDecimal(successCount === trialCount ? 1 : center + margin),
  };
}

function passInterval(
  policy: EvaluationAggregationPolicy,
  samplingAssumption: SamplingAssumption,
  passCount: number,
  decidedCount: number,
): EvaluationAggregateDefinition["passInterval"] {
  if (policy.method.method === "descriptive_counts") {
    if (samplingAssumption.status !== "not_required") {
      throw new ReferenceAggregateError(
        "incompatible_sampling_assumption",
        "Descriptive aggregation requires a not-required sampling assumption",
      );
    }
    return { reason: "method_not_requested", status: "not_reported" };
  }
  if (decidedCount === 0) {
    return { reason: "no_decided_cases", status: "not_reported" };
  }
  if (samplingAssumption.status !== "supported") {
    return { reason: "unsupported_assumption", status: "not_reported" };
  }
  return {
    interval: computeWilsonScoreInterval(
      passCount,
      decidedCount,
      policy.method.confidenceLevelBasisPoints,
    ),
    status: "reported",
  };
}

/** Builds a deterministic aggregate definition from exact run-result members. */
export function buildReferenceAggregate(
  request: ReferenceAggregateRequest,
): EvaluationAggregateDefinition {
  const parsedPolicy = EvaluationAggregationPolicySchema.safeParse(request.policy);
  if (!parsedPolicy.success) {
    throw new ReferenceAggregateError("invalid_policy", "The aggregation policy is invalid", {
      cause: parsedPolicy.error,
    });
  }
  const policy = parsedPolicy.data;
  const members = [...request.members].sort((left, right) => {
    const leftKey = memberKey(left);
    const rightKey = memberKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  if (members.some(({ result, run }) => result.evaluationRunId !== run.evaluationRunId)) {
    throw new ReferenceAggregateError(
      "invalid_aggregate",
      "Each aggregate result must reference the same exact evaluation run as its member",
    );
  }
  const counts = countVerdicts(members);
  const candidate = {
    abstentionRate: exactRatio(counts.abstainCount, counts.applicableCount),
    aggregateId: request.aggregateId,
    aggregationPolicy: {
      definitionSha256: policy.definitionSha256,
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
    },
    counts,
    coverage: exactRatio(counts.decidedCount, counts.applicableCount),
    criterion: request.criterion,
    errorRate: exactRatio(counts.errorCount, counts.applicableCount),
    knownLimitations: [...request.knownLimitations].sort(),
    members,
    passInterval: passInterval(
      policy,
      request.samplingAssumption,
      counts.passCount,
      counts.decidedCount,
    ),
    passProportion: exactRatio(counts.passCount, counts.decidedCount),
    samplingAssumption: request.samplingAssumption,
  };
  const parsed = EvaluationAggregateDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ReferenceAggregateError(
      "invalid_aggregate",
      "The aggregate inputs do not satisfy the bounded aggregate contract",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
