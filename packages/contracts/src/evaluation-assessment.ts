import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import {
  CriterionReferenceSchema,
  CriterionSetStatusReferenceSchema,
  EvaluationRiskTierSchema,
  EvidenceClassSchema,
} from "./evaluation-criteria.js";
import {
  EvaluationAggregationPolicyReferenceSchema,
  EvaluationDatasetVersionReferenceSchema,
  EvaluationEvidenceReferenceSchema,
  type EvaluationRun,
  EvaluationRunReferenceSchema,
  EvaluationRunResultReferenceSchema,
  EvaluationRunResultSchema,
  EvaluationRunSchema,
  EvaluationVerdictSchema,
  RawObservationReferenceSchema,
} from "./evaluation-run.js";
import {
  AssuranceRationaleSchema,
  AssuranceSummarySchema,
  SourceReviewReferenceSchema,
} from "./evaluation-source.js";
import { IndependenceGroupSchema, QualificationReportReferenceSchema } from "./evaluation-spec.js";
import { EvidenceScopeSchema, evidenceTimestampOrderKey } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";

export const EVALUATION_AGGREGATION_POLICY_SCHEMA_VERSION = "0.1" as const;
export const EVALUATION_AGGREGATE_SCHEMA_VERSION = "0.1" as const;
export const ASSESSMENT_SCHEMA_VERSION = "0.1" as const;
export const MAX_EVALUATION_AGGREGATE_MEMBERS = 10_000;
export const WILSON_INTERVAL_METHOD_VERSION = "1.0.0" as const;

const SafeCountSchema = z.number().int().nonnegative().max(MAX_EVALUATION_AGGREGATE_MEMBERS);

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function sortedUniqueText(maximum: number, label: string) {
  return z
    .array(AssuranceSummarySchema)
    .max(maximum)
    .refine(isStrictlySortedUnique, {
      message: `${label} must be unique and ordered`,
    });
}

function exactArtifacts(minimum: number, maximum: number, label: string) {
  return z
    .array(ArtifactContentReferenceSchema)
    .min(minimum)
    .max(maximum)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(({ artifactId, sha256 }) => `${artifactId}:${sha256}`),
        ),
      { message: `${label} must be unique and ordered by exact artifact reference` },
    );
}

function exactSourceReviews(label: string) {
  return z
    .array(SourceReviewReferenceSchema)
    .min(1)
    .max(64)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(
            ({ sourceReviewId, definitionSha256 }) => `${sourceReviewId}:${definitionSha256}`,
          ),
        ),
      { message: `${label} must be unique and ordered by exact review reference` },
    );
}

function evidenceReferenceKey(
  reference: z.infer<typeof EvaluationEvidenceReferenceSchema>,
): string {
  if (reference.kind === "artifact") {
    return `artifact:${reference.artifact.artifactId}:${reference.artifact.sha256}`;
  }
  if (reference.kind === "source_snapshot") {
    return `source_snapshot:${reference.source.sourceSnapshotId}:${reference.source.definitionSha256}`;
  }
  return `replay_result:${reference.replay.jobId}:${reference.replay.attemptId}:${reference.replay.result.sha256}`;
}

function exactEvidenceReferences(minimum: number, maximum: number, label: string) {
  return z
    .array(EvaluationEvidenceReferenceSchema)
    .min(minimum)
    .max(maximum)
    .refine((references) => isStrictlySortedUnique(references.map(evidenceReferenceKey)), {
      message: `${label} must be unique and ordered by exact evidence reference`,
    });
}

function unitIntervalDecimal() {
  return z.string().regex(/^(?:0(?:\.[0-9]{1,18})?|1(?:\.0{1,18})?)$/);
}

function compareUnitDecimals(left: string, right: string): number {
  const scale = 18;
  const scaled = (value: string): bigint => {
    const [whole = "0", fraction = ""] = value.split(".");
    return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0"));
  };
  const difference = scaled(left) - scaled(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

const aggregationMethodSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("descriptive_counts") }).strict(),
  z
    .object({
      confidenceLevelBasisPoints: z.number().int().min(5_000).max(9_999),
      method: z.literal("wilson_score_interval"),
      methodVersion: z.literal(WILSON_INTERVAL_METHOD_VERSION),
    })
    .strict(),
]);

const aggregationPolicyDefinitionShape = {
  changeRationale: AssuranceRationaleSchema,
  dataset: EvaluationDatasetVersionReferenceSchema,
  knownLimitations: sortedUniqueText(64, "Aggregation policy limitations"),
  maximumAbstentionRateBasisPoints: z.number().int().min(0).max(10_000),
  maximumErrorRateBasisPoints: z.number().int().min(0).max(10_000),
  method: aggregationMethodSchema,
  minimumApplicableCount: SafeCountSchema,
  minimumCoverageBasisPoints: z.number().int().min(0).max(10_000),
  minimumDecidedCount: SafeCountSchema,
  policyId: OpaqueIdSchema,
  policyVersionId: OpaqueIdSchema,
  selectionSha256: Sha256Schema,
};

export const EvaluationAggregationPolicyDefinitionSchema = z
  .object(aggregationPolicyDefinitionShape)
  .strict();

export const EvaluationAggregationPolicySchema = z
  .object({
    ...aggregationPolicyDefinitionShape,
    definitionSha256: Sha256Schema,
    publishedAt: UtcMillisecondTimestampSchema,
    publishedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(EVALUATION_AGGREGATION_POLICY_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict();

export const ExactCountRatioSchema = z.discriminatedUnion("status", [
  z
    .object({
      reason: z.literal("zero_denominator"),
      status: z.literal("unavailable"),
    })
    .strict(),
  z
    .object({
      denominator: SafeCountSchema.refine((value) => value > 0, {
        message: "An available ratio requires a positive denominator",
      }),
      numerator: SafeCountSchema,
      status: z.literal("available"),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.numerator > value.denominator) {
        context.addIssue({
          code: "custom",
          message: "A count ratio numerator cannot exceed its denominator",
          path: ["numerator"],
        });
      }
    }),
]);

export const EvaluationAggregateCountsSchema = z
  .object({
    abstainCount: SafeCountSchema,
    applicableCount: SafeCountSchema,
    attemptedCount: SafeCountSchema,
    decidedCount: SafeCountSchema,
    errorCount: SafeCountSchema,
    failCount: SafeCountSchema,
    notApplicableCount: SafeCountSchema,
    passCount: SafeCountSchema,
    selectedCount: SafeCountSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const selected =
      value.passCount +
      value.failCount +
      value.abstainCount +
      value.notApplicableCount +
      value.errorCount;
    if (value.selectedCount !== selected || value.attemptedCount !== selected) {
      context.addIssue({
        code: "custom",
        message: "Selected and attempted counts must equal all five verdict counts",
        path: ["selectedCount"],
      });
    }
    if (
      value.applicableCount !==
      value.passCount + value.failCount + value.abstainCount + value.errorCount
    ) {
      context.addIssue({
        code: "custom",
        message: "Applicable count must include pass, fail, abstain, and error only",
        path: ["applicableCount"],
      });
    }
    if (value.decidedCount !== value.passCount + value.failCount) {
      context.addIssue({
        code: "custom",
        message: "Decided count must include pass and fail only",
        path: ["decidedCount"],
      });
    }
  });

export const EvaluationSamplingAssumptionSchema = z.discriminatedUnion("status", [
  z
    .object({
      evidence: exactArtifacts(1, 16, "Sampling-assumption evidence"),
      status: z.literal("supported"),
    })
    .strict(),
  z
    .object({
      limitations: sortedUniqueText(16, "Sampling-assumption limitations").min(1),
      status: z.literal("unsupported"),
    })
    .strict(),
  z.object({ status: z.literal("not_required") }).strict(),
]);

export const WilsonIntervalSchema = z
  .object({
    confidenceLevelBasisPoints: z.number().int().min(5_000).max(9_999),
    lowerBound: unitIntervalDecimal(),
    method: z.literal("wilson_score_interval"),
    methodVersion: z.literal(WILSON_INTERVAL_METHOD_VERSION),
    successCount: SafeCountSchema,
    trialCount: SafeCountSchema.refine((value) => value > 0, {
      message: "A Wilson interval requires a positive trial count",
    }),
    upperBound: unitIntervalDecimal(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.successCount > value.trialCount) {
      context.addIssue({
        code: "custom",
        message: "Wilson successes cannot exceed trials",
        path: ["successCount"],
      });
    }
    if (compareUnitDecimals(value.lowerBound, value.upperBound) > 0) {
      context.addIssue({
        code: "custom",
        message: "Wilson lower bound cannot exceed its upper bound",
        path: ["lowerBound"],
      });
    }
  });

export const EvaluationPassIntervalSchema = z.discriminatedUnion("status", [
  z
    .object({
      interval: WilsonIntervalSchema,
      status: z.literal("reported"),
    })
    .strict(),
  z
    .object({
      reason: z.enum(["method_not_requested", "no_decided_cases", "unsupported_assumption"]),
      status: z.literal("not_reported"),
    })
    .strict(),
]);

export const EvaluationAggregateMemberSchema = z
  .object({
    independenceGroupId: OpaqueIdSchema,
    result: EvaluationRunResultReferenceSchema,
    run: EvaluationRunReferenceSchema,
    verdict: EvaluationVerdictSchema,
  })
  .strict();

export const EvaluationAggregateReferenceSchema = z
  .object({
    aggregateId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

const evaluationAggregateShape = {
  abstentionRate: ExactCountRatioSchema,
  aggregateId: OpaqueIdSchema,
  aggregationPolicy: EvaluationAggregationPolicyReferenceSchema,
  counts: EvaluationAggregateCountsSchema,
  coverage: ExactCountRatioSchema,
  criterion: CriterionReferenceSchema,
  errorRate: ExactCountRatioSchema,
  knownLimitations: sortedUniqueText(64, "Aggregate limitations"),
  members: z.array(EvaluationAggregateMemberSchema).max(MAX_EVALUATION_AGGREGATE_MEMBERS),
  passInterval: EvaluationPassIntervalSchema,
  passProportion: ExactCountRatioSchema,
  samplingAssumption: EvaluationSamplingAssumptionSchema,
};

function expectedRatio(numerator: number, denominator: number) {
  return denominator === 0
    ? ({ reason: "zero_denominator", status: "unavailable" } as const)
    : ({ denominator, numerator, status: "available" } as const);
}

function ratiosEqual(
  left: z.infer<typeof ExactCountRatioSchema>,
  right: z.infer<typeof ExactCountRatioSchema>,
): boolean {
  return (
    left.status === right.status &&
    (left.status === "unavailable" ||
      (right.status === "available" &&
        left.numerator === right.numerator &&
        left.denominator === right.denominator))
  );
}

function refineEvaluationAggregate(
  value: z.infer<z.ZodObject<typeof evaluationAggregateShape>>,
  context: z.RefinementCtx,
): void {
  const memberKeys = value.members.map(
    ({ run, result }) => `${run.evaluationRunId}:${result.resultId}`,
  );
  if (!isStrictlySortedUnique(memberKeys)) {
    context.addIssue({
      code: "custom",
      message: "Aggregate members must be unique and ordered by exact run result",
      path: ["members"],
    });
  }
  const expectedCounts = {
    abstainCount: value.members.filter(({ verdict }) => verdict === "abstain").length,
    errorCount: value.members.filter(({ verdict }) => verdict === "error").length,
    failCount: value.members.filter(({ verdict }) => verdict === "fail").length,
    notApplicableCount: value.members.filter(({ verdict }) => verdict === "not_applicable").length,
    passCount: value.members.filter(({ verdict }) => verdict === "pass").length,
  };
  const applicableCount =
    expectedCounts.passCount +
    expectedCounts.failCount +
    expectedCounts.abstainCount +
    expectedCounts.errorCount;
  const decidedCount = expectedCounts.passCount + expectedCounts.failCount;
  if (
    value.counts.selectedCount !== value.members.length ||
    value.counts.attemptedCount !== value.members.length ||
    value.counts.applicableCount !== applicableCount ||
    value.counts.decidedCount !== decidedCount ||
    Object.entries(expectedCounts).some(
      ([key, count]) => value.counts[key as keyof typeof expectedCounts] !== count,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Aggregate counts must reconstruct exactly from all member verdicts",
      path: ["counts"],
    });
  }
  const expectedCoverage = expectedRatio(decidedCount, applicableCount);
  const expectedAbstention = expectedRatio(expectedCounts.abstainCount, applicableCount);
  const expectedError = expectedRatio(expectedCounts.errorCount, applicableCount);
  const expectedPass = expectedRatio(expectedCounts.passCount, decidedCount);
  if (
    !ratiosEqual(value.coverage, expectedCoverage) ||
    !ratiosEqual(value.abstentionRate, expectedAbstention) ||
    !ratiosEqual(value.errorRate, expectedError) ||
    !ratiosEqual(value.passProportion, expectedPass)
  ) {
    context.addIssue({
      code: "custom",
      message: "Aggregate ratios must use the declared applicable and decided denominators",
      path: ["coverage"],
    });
  }
}

export const EvaluationAggregateDefinitionSchema = z
  .object(evaluationAggregateShape)
  .strict()
  .superRefine(refineEvaluationAggregate);

export const EvaluationAggregateSchema = z
  .object({
    ...evaluationAggregateShape,
    createdAt: UtcMillisecondTimestampSchema,
    createdByPrincipalId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    schemaVersion: z.literal(EVALUATION_AGGREGATE_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineEvaluationAggregate);

function scopesEqual(
  left: z.infer<typeof EvidenceScopeSchema>,
  right: z.infer<typeof EvidenceScopeSchema>,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function policyReferencesEqual(
  left: z.infer<typeof EvaluationAggregationPolicyReferenceSchema>,
  right: z.infer<typeof EvaluationAggregationPolicyReferenceSchema>,
): boolean {
  return (
    left.policyId === right.policyId &&
    left.policyVersionId === right.policyVersionId &&
    left.definitionSha256 === right.definitionSha256
  );
}

function criterionReferencesEqual(
  left: z.infer<typeof CriterionReferenceSchema>,
  right: z.infer<typeof CriterionReferenceSchema>,
): boolean {
  return (
    left.criterionId === right.criterionId &&
    left.criterionSet.criterionSetId === right.criterionSet.criterionSetId &&
    left.criterionSet.criterionSetVersionId === right.criterionSet.criterionSetVersionId &&
    left.criterionSet.definitionSha256 === right.criterionSet.definitionSha256
  );
}

function datasetReferencesEqual(
  left: z.infer<typeof EvaluationDatasetVersionReferenceSchema>,
  right: z.infer<typeof EvaluationDatasetVersionReferenceSchema>,
): boolean {
  return (
    left.datasetId === right.datasetId &&
    left.datasetVersionId === right.datasetVersionId &&
    left.definitionSha256 === right.definitionSha256
  );
}

export const EvaluationAggregateSnapshotSchema = z
  .object({
    aggregate: EvaluationAggregateSchema,
    policy: EvaluationAggregationPolicySchema,
    results: z.array(EvaluationRunResultSchema).max(MAX_EVALUATION_AGGREGATE_MEMBERS),
    runs: z.array(EvaluationRunSchema).max(MAX_EVALUATION_AGGREGATE_MEMBERS),
  })
  .strict()
  .superRefine((value, context) => {
    const { aggregate, policy, results, runs } = value;
    const policyReference = {
      definitionSha256: policy.definitionSha256,
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
    };
    if (
      !policyReferencesEqual(aggregate.aggregationPolicy, policyReference) ||
      !scopesEqual(aggregate.scope, policy.scope)
    ) {
      context.addIssue({
        code: "custom",
        message: "Aggregate must bind the exact policy in the same scope",
        path: ["aggregate", "aggregationPolicy"],
      });
    }
    if (runs.length !== aggregate.members.length || results.length !== aggregate.members.length) {
      context.addIssue({
        code: "custom",
        message: "Aggregate snapshots require every exact run and result",
        path: ["runs"],
      });
    }
    const fixtureVersions = new Set<string>();
    aggregate.members.forEach((member, index) => {
      const run = runs[index];
      const result = results[index];
      if (
        !run ||
        !result ||
        member.run.evaluationRunId !== run.evaluationRunId ||
        member.run.definitionSha256 !== run.definitionSha256 ||
        member.result.evaluationRunId !== result.evaluationRunId ||
        member.result.resultId !== result.resultId ||
        member.result.definitionSha256 !== result.definitionSha256 ||
        member.verdict !== result.verdict ||
        !policyReferencesEqual(run.aggregationPolicy, aggregate.aggregationPolicy) ||
        !datasetReferencesEqual(run.dataset, policy.dataset) ||
        !criterionReferencesEqual(run.criterion, aggregate.criterion) ||
        !scopesEqual(run.scope, aggregate.scope) ||
        !scopesEqual(result.scope, aggregate.scope) ||
        (run.applicability.result === "not_applicable" &&
          (result.verdict !== "not_applicable" || result.observations.length !== 0)) ||
        (run.applicability.result === "applicable" && result.verdict === "not_applicable")
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Each aggregate member must preserve exact run, result, policy, criterion, and scope",
          path: ["members", index],
        });
      }
      if (run) {
        if (fixtureVersions.has(run.fixture.fixtureVersionId)) {
          context.addIssue({
            code: "custom",
            message: "An aggregate cannot count the same exact fixture version twice",
            path: ["runs", index, "fixture", "fixtureVersionId"],
          });
        }
        fixtureVersions.add(run.fixture.fixtureVersionId);
      }
    });
    const latestResultTime = results.reduce(
      (latest, result) =>
        evidenceTimestampOrderKey(result.completedAt) > evidenceTimestampOrderKey(latest)
          ? result.completedAt
          : latest,
      policy.publishedAt,
    );
    if (
      evidenceTimestampOrderKey(aggregate.createdAt) < evidenceTimestampOrderKey(latestResultTime)
    ) {
      context.addIssue({
        code: "custom",
        message: "Aggregate creation cannot precede its policy or run-result evidence",
        path: ["aggregate", "createdAt"],
      });
    }

    if (policy.method.method === "descriptive_counts") {
      if (
        aggregate.samplingAssumption.status !== "not_required" ||
        aggregate.passInterval.status !== "not_reported" ||
        aggregate.passInterval.reason !== "method_not_requested"
      ) {
        context.addIssue({
          code: "custom",
          message: "Descriptive aggregation cannot report a statistical interval",
          path: ["aggregate", "passInterval"],
        });
      }
      return;
    }

    if (aggregate.counts.decidedCount === 0) {
      if (
        aggregate.passInterval.status !== "not_reported" ||
        aggregate.passInterval.reason !== "no_decided_cases"
      ) {
        context.addIssue({
          code: "custom",
          message: "Wilson aggregation with no decisions cannot report an interval",
          path: ["aggregate", "passInterval"],
        });
      }
      return;
    }
    if (aggregate.samplingAssumption.status !== "supported") {
      if (
        aggregate.passInterval.status !== "not_reported" ||
        aggregate.passInterval.reason !== "unsupported_assumption"
      ) {
        context.addIssue({
          code: "custom",
          message: "Wilson aggregation requires supported independence before reporting",
          path: ["aggregate", "passInterval"],
        });
      }
      return;
    }
    if (
      aggregate.passInterval.status !== "reported" ||
      aggregate.passInterval.interval.confidenceLevelBasisPoints !==
        policy.method.confidenceLevelBasisPoints ||
      aggregate.passInterval.interval.successCount !== aggregate.counts.passCount ||
      aggregate.passInterval.interval.trialCount !== aggregate.counts.decidedCount
    ) {
      context.addIssue({
        code: "custom",
        message: "Reported Wilson interval must bind the policy and exact decided counts",
        path: ["aggregate", "passInterval"],
      });
    }
  });

const ObservedEvidenceClassSchema = z.enum([
  "artifact",
  "deterministic_oracle",
  "replay_result",
  "source_snapshot",
  "statistical_aggregate",
]);

export const AssessmentEligibilityReasonSchema = z.enum([
  "criterion_not_approved",
  "criterion_not_applicable",
  "critical_counterevidence",
  "digest_mismatch",
  "human_review_required",
  "insufficient_coverage",
  "insufficient_evidence_classes",
  "insufficient_independent_quorum",
  "invalid_provenance",
  "missing_non_model_evidence",
  "qualification_not_current",
  "source_identity_not_verified",
  "source_review_not_current",
  "unresolved_disagreement",
  "unsupported_statistical_assumptions",
]);

const AssessmentEligibilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("eligible") }).strict(),
  z
    .object({
      reasons: z
        .array(AssessmentEligibilityReasonSchema)
        .min(1)
        .max(AssessmentEligibilityReasonSchema.options.length)
        .refine(isStrictlySortedUnique, {
          message: "Assessment ineligibility reasons must be unique and ordered",
        }),
      status: z.literal("ineligible"),
    })
    .strict(),
]);

const AssessmentDimensionsSchema = z
  .object({
    applicability: z.enum(["applicable", "not_applicable", "undetermined"]),
    coverage: z.enum(["sufficient", "insufficient", "unavailable"]),
    independence: z.enum(["insufficient", "sufficient"]),
    integrity: z.enum(["invalid", "unverified", "verified"]),
    qualification: z.enum(["current", "invalid", "not_current"]),
    sourceFreshness: z.enum(["current", "not_current", "unknown"]),
    sourceIdentity: z.enum(["disputed", "unverified", "verified"]),
    statisticalAssumptions: z.enum(["not_required", "supported", "unsupported"]),
  })
  .strict();

const AssessmentConflictSchema = z
  .object({
    conflictId: OpaqueIdSchema,
    evidence: exactEvidenceReferences(2, 16, "Assessment conflict evidence"),
    severity: z.enum(["critical", "noncritical"]),
    status: z.enum(["resolved", "unresolved"]),
    summary: AssuranceSummarySchema,
  })
  .strict();

const AssessmentDisagreementSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }).strict(),
  z
    .object({
      evidence: exactEvidenceReferences(1, 16, "Assessment disagreement evidence"),
      rationale: AssuranceRationaleSchema,
      status: z.enum(["resolved", "unresolved"]),
    })
    .strict(),
]);

export const AssessmentReferenceSchema = z
  .object({
    assessmentId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

const assessmentShape = {
  aggregate: EvaluationAggregateReferenceSchema,
  aggregationPolicy: EvaluationAggregationPolicyReferenceSchema,
  assessmentId: OpaqueIdSchema,
  assumptions: sortedUniqueText(64, "Assessment assumptions"),
  conflicts: z
    .array(AssessmentConflictSchema)
    .max(64)
    .refine((values) => isStrictlySortedUnique(values.map(({ conflictId }) => conflictId)), {
      message: "Assessment conflicts must be unique and ordered",
    }),
  counterevidence: exactEvidenceReferences(0, 64, "Assessment counterevidence"),
  criterion: CriterionReferenceSchema,
  criterionLifecycleStatus: z.enum([
    "approved",
    "contested",
    "draft",
    "qualified",
    "superseded",
    "withdrawn",
  ]),
  criterionStatus: CriterionSetStatusReferenceSchema,
  dimensions: AssessmentDimensionsSchema,
  disagreement: AssessmentDisagreementSchema,
  eligibility: AssessmentEligibilitySchema,
  exclusions: sortedUniqueText(64, "Assessment exclusions"),
  independenceGroups: z
    .array(IndependenceGroupSchema)
    .max(64)
    .refine((groups) => isStrictlySortedUnique(groups.map(({ groupId }) => groupId)), {
      message: "Assessment independence groups must be unique and ordered",
    }),
  knownLimitations: sortedUniqueText(64, "Assessment limitations"),
  minorityFindings: sortedUniqueText(64, "Assessment minority findings"),
  observations: z.array(RawObservationReferenceSchema).max(MAX_EVALUATION_AGGREGATE_MEMBERS * 16),
  observedEvidenceClasses: z
    .array(ObservedEvidenceClassSchema)
    .min(1)
    .max(ObservedEvidenceClassSchema.options.length)
    .refine(isStrictlySortedUnique, {
      message: "Observed evidence classes must be unique and ordered",
    }),
  qualifications: z
    .array(QualificationReportReferenceSchema)
    .min(1)
    .max(64)
    .refine(
      (values) =>
        isStrictlySortedUnique(
          values.map(
            ({ qualificationReportId, definitionSha256 }) =>
              `${qualificationReportId}:${definitionSha256}`,
          ),
        ),
      { message: "Assessment qualification reports must be unique and ordered" },
    ),
  requiredEvidenceClasses: z
    .array(EvidenceClassSchema)
    .min(1)
    .max(EvidenceClassSchema.options.length)
    .refine(isStrictlySortedUnique, {
      message: "Required evidence classes must be unique and ordered",
    }),
  requiredIndependentGroups: z.number().int().positive().max(64),
  riskTier: EvaluationRiskTierSchema,
  runs: z.array(EvaluationRunReferenceSchema).min(1).max(MAX_EVALUATION_AGGREGATE_MEMBERS),
  sourceReviews: exactSourceReviews("Assessment source reviews"),
  supportRationale: AssuranceRationaleSchema,
  supportStatus: z.enum(["contradicted", "inconclusive", "invalid", "supported"]),
};

function expectedEligibilityReasons(
  value: z.infer<z.ZodObject<typeof assessmentShape>>,
): z.infer<typeof AssessmentEligibilityReasonSchema>[] {
  const reasons = new Set<z.infer<typeof AssessmentEligibilityReasonSchema>>();
  if (value.criterionLifecycleStatus !== "approved") reasons.add("criterion_not_approved");
  if (value.dimensions.applicability !== "applicable") reasons.add("criterion_not_applicable");
  if (value.dimensions.integrity === "invalid") reasons.add("digest_mismatch");
  if (value.dimensions.integrity !== "verified" || value.supportStatus === "invalid") {
    reasons.add("invalid_provenance");
  }
  if (value.dimensions.sourceIdentity !== "verified") {
    reasons.add("source_identity_not_verified");
  }
  if (value.dimensions.sourceFreshness !== "current") reasons.add("source_review_not_current");
  if (value.dimensions.qualification !== "current") reasons.add("qualification_not_current");
  if (value.dimensions.coverage !== "sufficient") reasons.add("insufficient_coverage");
  if (
    value.dimensions.independence !== "sufficient" ||
    value.independenceGroups.length < value.requiredIndependentGroups
  ) {
    reasons.add("insufficient_independent_quorum");
  }
  if (
    value.requiredEvidenceClasses.some(
      (required) => !value.observedEvidenceClasses.includes(required as never),
    )
  ) {
    reasons.add("insufficient_evidence_classes");
  }
  if (
    !value.observedEvidenceClasses.includes("deterministic_oracle") &&
    !value.observedEvidenceClasses.includes("statistical_aggregate")
  ) {
    reasons.add("missing_non_model_evidence");
  }
  if (
    value.conflicts.some(
      ({ severity, status }) => severity === "critical" && status === "unresolved",
    )
  ) {
    reasons.add("critical_counterevidence");
  }
  if (value.disagreement.status === "unresolved") reasons.add("unresolved_disagreement");
  if (value.dimensions.statisticalAssumptions === "unsupported") {
    reasons.add("unsupported_statistical_assumptions");
  }
  if (value.riskTier === "high" || value.riskTier === "critical") {
    reasons.add("human_review_required");
  }
  return [...reasons].sort();
}

function refineAssessment(
  value: z.infer<z.ZodObject<typeof assessmentShape>>,
  context: z.RefinementCtx,
): void {
  const runKeys = value.runs.map(
    ({ evaluationRunId, definitionSha256 }) => `${evaluationRunId}:${definitionSha256}`,
  );
  const observationKeys = value.observations.map(
    ({ observationId, definitionSha256 }) => `${observationId}:${definitionSha256}`,
  );
  if (!isStrictlySortedUnique(runKeys) || !isStrictlySortedUnique(observationKeys)) {
    context.addIssue({
      code: "custom",
      message: "Assessment run and observation references must be unique and ordered",
      path: ["runs"],
    });
  }
  const expected = expectedEligibilityReasons(value);
  if (
    (expected.length === 0 && value.eligibility.status !== "eligible") ||
    (expected.length > 0 &&
      (value.eligibility.status !== "ineligible" ||
        value.eligibility.reasons.length !== expected.length ||
        value.eligibility.reasons.some((reason, index) => reason !== expected[index])))
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Assessment eligibility must reconstruct exactly from preserved assurance dimensions",
      path: ["eligibility"],
    });
  }
}

export const AssessmentDefinitionSchema = z
  .object(assessmentShape)
  .strict()
  .superRefine(refineAssessment);

export const AssessmentSchema = z
  .object({
    ...assessmentShape,
    createdAt: UtcMillisecondTimestampSchema,
    createdByPrincipalId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    schemaVersion: z.literal(ASSESSMENT_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineAssessment);

function ratioMeetsMinimum(
  ratio: z.infer<typeof ExactCountRatioSchema>,
  minimumBasisPoints: number,
): boolean {
  return (
    ratio.status === "available" &&
    ratio.numerator * 10_000 >= minimumBasisPoints * ratio.denominator
  );
}

function ratioMeetsMaximum(
  ratio: z.infer<typeof ExactCountRatioSchema>,
  maximumBasisPoints: number,
): boolean {
  return (
    ratio.status === "available" &&
    ratio.numerator * 10_000 <= maximumBasisPoints * ratio.denominator
  );
}

function runReference(run: EvaluationRun) {
  return {
    definitionSha256: run.definitionSha256,
    evaluationRunId: run.evaluationRunId,
  };
}

function qualificationReferenceKey(
  reference: z.infer<typeof QualificationReportReferenceSchema>,
): string {
  return `${reference.qualificationReportId}:${reference.definitionSha256}`;
}

function sourceReviewReferenceKey(reference: z.infer<typeof SourceReviewReferenceSchema>): string {
  return `${reference.sourceReviewId}:${reference.definitionSha256}`;
}

function criterionStatusReferencesEqual(
  left: z.infer<typeof CriterionSetStatusReferenceSchema>,
  right: z.infer<typeof CriterionSetStatusReferenceSchema>,
): boolean {
  return (
    left.statusRecordId === right.statusRecordId && left.definitionSha256 === right.definitionSha256
  );
}

function exactStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const AssessmentSnapshotSchema = z
  .object({
    aggregateSnapshot: EvaluationAggregateSnapshotSchema,
    assessment: AssessmentSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const { aggregate, policy, results, runs } = value.aggregateSnapshot;
    const { assessment } = value;
    if (
      assessment.aggregate.aggregateId !== aggregate.aggregateId ||
      assessment.aggregate.definitionSha256 !== aggregate.definitionSha256 ||
      !policyReferencesEqual(assessment.aggregationPolicy, aggregate.aggregationPolicy) ||
      !criterionReferencesEqual(assessment.criterion, aggregate.criterion) ||
      !scopesEqual(assessment.scope, aggregate.scope)
    ) {
      context.addIssue({
        code: "custom",
        message: "Assessment must bind the exact aggregate, policy, criterion, and scope",
        path: ["assessment", "aggregate"],
      });
    }
    const expectedRuns = runs.map(runReference);
    const expectedObservations = results.flatMap(({ observations }) => observations);
    if (
      assessment.runs.length !== expectedRuns.length ||
      assessment.runs.some(
        (reference, index) =>
          reference.evaluationRunId !== expectedRuns[index]?.evaluationRunId ||
          reference.definitionSha256 !== expectedRuns[index]?.definitionSha256,
      ) ||
      assessment.observations.length !== expectedObservations.length ||
      assessment.observations.some(
        (reference, index) =>
          reference.observationId !== expectedObservations[index]?.observationId ||
          reference.definitionSha256 !== expectedObservations[index]?.definitionSha256,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Assessment must retain every exact run and raw observation",
        path: ["assessment", "runs"],
      });
    }
    const expectedQualifications = [
      ...new Map(
        runs
          .flatMap(({ evaluatorQualification, oracleQualification }) => [
            evaluatorQualification,
            oracleQualification,
          ])
          .map((reference) => [qualificationReferenceKey(reference), reference]),
      ).values(),
    ].sort((left, right) =>
      qualificationReferenceKey(left).localeCompare(qualificationReferenceKey(right)),
    );
    const expectedSourceReviews = [
      ...new Map(
        runs
          .flatMap(({ sourceReviews }) => sourceReviews)
          .map((reference) => [sourceReviewReferenceKey(reference), reference]),
      ).values(),
    ].sort((left, right) =>
      sourceReviewReferenceKey(left).localeCompare(sourceReviewReferenceKey(right)),
    );
    const expectedIndependenceGroupIds = [
      ...new Set(aggregate.members.map(({ independenceGroupId }) => independenceGroupId)),
    ].sort();
    if (
      !exactStringArraysEqual(
        assessment.qualifications.map(qualificationReferenceKey),
        expectedQualifications.map(qualificationReferenceKey),
      ) ||
      !exactStringArraysEqual(
        assessment.sourceReviews.map(sourceReviewReferenceKey),
        expectedSourceReviews.map(sourceReviewReferenceKey),
      ) ||
      !exactStringArraysEqual(
        assessment.independenceGroups.map(({ groupId }) => groupId),
        expectedIndependenceGroupIds,
      ) ||
      runs.some(
        (run) =>
          !criterionStatusReferencesEqual(run.criterionStatus, assessment.criterionStatus) ||
          run.applicability.context.riskTier !== assessment.riskTier,
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Assessment assurance references and risk tier must reconstruct from exact aggregate runs",
        path: ["assessment", "qualifications"],
      });
    }
    const expectedApplicability = runs.some(
      ({ applicability }) => applicability.result === "applicable",
    )
      ? "applicable"
      : "not_applicable";
    const expectedIndependence =
      expectedIndependenceGroupIds.length >= assessment.requiredIndependentGroups
        ? "sufficient"
        : "insufficient";
    const expectedObservedEvidenceClasses = [
      "artifact",
      "deterministic_oracle",
      "replay_result",
      "source_snapshot",
      "statistical_aggregate",
    ] as const;
    if (
      assessment.dimensions.applicability !== expectedApplicability ||
      assessment.dimensions.independence !== expectedIndependence ||
      !exactStringArraysEqual(assessment.observedEvidenceClasses, expectedObservedEvidenceClasses)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Assessment applicability, independence, and evidence classes must follow exact aggregate evidence",
        path: ["assessment", "dimensions"],
      });
    }
    const coverageSufficient =
      aggregate.counts.applicableCount >= policy.minimumApplicableCount &&
      aggregate.counts.decidedCount >= policy.minimumDecidedCount &&
      ratioMeetsMinimum(aggregate.coverage, policy.minimumCoverageBasisPoints) &&
      ratioMeetsMaximum(aggregate.abstentionRate, policy.maximumAbstentionRateBasisPoints) &&
      ratioMeetsMaximum(aggregate.errorRate, policy.maximumErrorRateBasisPoints);
    const expectedCoverage = coverageSufficient
      ? "sufficient"
      : aggregate.coverage.status === "unavailable"
        ? "unavailable"
        : "insufficient";
    if (assessment.dimensions.coverage !== expectedCoverage) {
      context.addIssue({
        code: "custom",
        message: "Assessment coverage dimension must follow the exact aggregate policy",
        path: ["assessment", "dimensions", "coverage"],
      });
    }
    const expectedAssumption =
      policy.method.method === "descriptive_counts"
        ? "not_required"
        : aggregate.samplingAssumption.status === "supported"
          ? "supported"
          : "unsupported";
    if (assessment.dimensions.statisticalAssumptions !== expectedAssumption) {
      context.addIssue({
        code: "custom",
        message: "Assessment statistical-assumption dimension must preserve aggregate evidence",
        path: ["assessment", "dimensions", "statisticalAssumptions"],
      });
    }
    if (
      evidenceTimestampOrderKey(assessment.createdAt) <
      evidenceTimestampOrderKey(aggregate.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Assessment creation cannot precede aggregate or run-result evidence",
        path: ["assessment", "createdAt"],
      });
    }
  });

export type Assessment = z.infer<typeof AssessmentSchema>;
export type AssessmentDefinition = z.infer<typeof AssessmentDefinitionSchema>;
export type EvaluationAggregate = z.infer<typeof EvaluationAggregateSchema>;
export type EvaluationAggregateDefinition = z.infer<typeof EvaluationAggregateDefinitionSchema>;
export type EvaluationAggregationPolicy = z.infer<typeof EvaluationAggregationPolicySchema>;
export type EvaluationAggregationPolicyDefinition = z.infer<
  typeof EvaluationAggregationPolicyDefinitionSchema
>;
