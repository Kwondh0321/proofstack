import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { RegressionFixtureVersionReferenceSchema } from "./dataset.js";
import {
  AssessmentEligibilityReasonSchema,
  AssessmentReferenceSchema,
} from "./evaluation-assessment.js";
import { CriterionReferenceSchema, ExactDecimalSchema } from "./evaluation-criteria.js";
import {
  ModelAssuranceAssessmentReferenceSchema,
  ModelAssuranceIneligibilityReasonSchema,
} from "./evaluation-model-assessment.js";
import {
  EvaluationDatasetVersionReferenceSchema,
  EvaluationReplayResultReferenceSchema,
  EvaluationVerdictSchema,
  RawObservationReferenceSchema,
} from "./evaluation-run.js";
import { AssuranceSummarySchema } from "./evaluation-source.js";
import {
  EvidenceKindSchema,
  EvidenceScopeSchema,
  EvidenceStatusSchema,
  evidenceTimestampOrderKey,
} from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { ReplayBudgetDimensionSchema } from "./replay-accounting.js";

export const COMPARISON_DEFINITION_SCHEMA_VERSION = "0.7" as const;
export const COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION = "0.3" as const;
export const MAX_COMPARISON_SUBJECT_FIXTURES = 500;
export const MAX_COMPARISON_SUBJECT_ASSESSMENTS = 128;
export const MAX_COMPARISON_STRATA = 64;
export const MAX_COMPARISON_METRICS = 128;
export const MAX_COMPARISON_NUMERIC_OBSERVATIONS = 8_000;
export const MAX_COMPARISON_ARTIFACTS = 4_000;
export const MAX_COMPARISON_SAFETY_EVENTS = 4_000;
export const MAX_COMPARISON_OMISSIONS = 4_000;
export const MAX_COMPARISON_EXACT_INTEGER_CHARACTERS = 128;
const MAX_COMPARISON_COUNT = Number.MAX_SAFE_INTEGER;

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function exactAssessmentReferences(label: string) {
  return z
    .array(AssessmentReferenceSchema)
    .max(MAX_COMPARISON_SUBJECT_ASSESSMENTS)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(
            ({ assessmentId, definitionSha256 }) => `${assessmentId}:${definitionSha256}`,
          ),
        ),
      { message: `${label} must be unique and ordered by exact assessment reference` },
    );
}

function exactModelAssuranceReferences(label: string) {
  return z
    .array(ModelAssuranceAssessmentReferenceSchema)
    .max(MAX_COMPARISON_SUBJECT_ASSESSMENTS)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(
            ({ assessmentExtensionId, definitionSha256 }) =>
              `${assessmentExtensionId}:${definitionSha256}`,
          ),
        ),
      { message: `${label} must be unique and ordered by exact model-assurance reference` },
    );
}

export const ComparisonDefinitionReferenceSchema = z
  .object({
    comparisonId: OpaqueIdSchema,
    comparisonVersionId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

export const ComparisonDefinitionPredecessorSchema = z
  .object({
    comparisonVersionId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

export const ComparisonSubjectFixtureSchema = z
  .object({
    assessments: exactAssessmentReferences("Fixture assessments"),
    fixture: RegressionFixtureVersionReferenceSchema,
    modelAssuranceAssessments: exactModelAssuranceReferences("Fixture model-assurance assessments"),
    replay: EvaluationReplayResultReferenceSchema,
  })
  .strict();

function subjectFixtureKey(fixture: z.infer<typeof ComparisonSubjectFixtureSchema>): string {
  return `${fixture.fixture.fixtureId}:${fixture.fixture.fixtureVersionId}`;
}

export const ComparisonSubjectSchema = z
  .object({
    dataset: EvaluationDatasetVersionReferenceSchema,
    fixtures: z
      .array(ComparisonSubjectFixtureSchema)
      .min(1)
      .max(MAX_COMPARISON_SUBJECT_FIXTURES)
      .refine((fixtures) => isStrictlySortedUnique(fixtures.map(subjectFixtureKey)), {
        message: "Comparison subject fixtures must be unique and ordered by exact fixture identity",
      }),
  })
  .strict();

const NumericAggregationSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.enum(["maximum", "mean", "median", "minimum", "sum"]),
      methodVersion: z.literal("1.0.0"),
    })
    .strict(),
  z
    .object({
      basisPoints: z.number().int().min(1).max(10_000),
      method: z.literal("nearest_rank_quantile"),
      methodVersion: z.literal("1.0.0"),
    })
    .strict(),
]);

const comparisonMetricIdentityShape = {
  label: AssuranceSummarySchema,
  metricId: OpaqueIdSchema,
  stratumId: OpaqueIdSchema,
};

export const COMPARISON_METRIC_KINDS = [
  "artifact_set",
  "assurance_state_count",
  "coverage_count",
  "evaluation_verdict_count",
  "numeric_measurement",
  "replay_usage",
  "safety_event_count",
  "trace_event_count",
] as const;

export const COMPARISON_REPLAY_USAGE_UNITS = {
  concurrentInteractions: "interactions",
  elapsedMilliseconds: "milliseconds",
  emittedArtifactBytes: "bytes",
  inputTokens: "tokens",
  jobAttempts: "attempts",
  modelRequests: "requests",
  outputTokens: "tokens",
  providerCostMicrounits: "provider_cost_microunits",
  retrievedBytes: "bytes",
  toolCalls: "calls",
} as const satisfies Record<z.infer<typeof ReplayBudgetDimensionSchema>, string>;

export const COMPARISON_COUNT_METRIC_UNITS = {
  artifact_set: "artifacts",
  assurance_state_count: "assurance_records",
  coverage_count: "cases",
  evaluation_verdict_count: "evaluation_outcomes",
  safety_event_count: "events",
  trace_event_count: "events",
} as const;

export const ComparisonAssuranceConditionSchema = z.enum([
  "assessment_eligible",
  "assessment_ineligible",
  "calibration_available",
  "calibration_incompatible",
  "calibration_stale",
  "calibration_unavailable",
  "critical_counterevidence_absent",
  "critical_counterevidence_present",
  "disagreement_absent",
  "human_review_available",
  "human_review_conflicted",
  "human_review_expired",
  "human_review_invalid",
  "human_review_missing",
  "human_review_protocol_mismatch",
  "human_review_quorum_shortfall",
  "model_assurance_eligible",
  "model_assurance_ineligible",
  "order_sensitive_result",
  "unresolved_disagreement",
]);

const comparisonAssuranceConditions = {
  assessment_eligibility: ["assessment_eligible", "assessment_ineligible"],
  calibration_availability: [
    "calibration_available",
    "calibration_incompatible",
    "calibration_stale",
    "calibration_unavailable",
  ],
  counterevidence: ["critical_counterevidence_absent", "critical_counterevidence_present"],
  disagreement: ["disagreement_absent", "order_sensitive_result", "unresolved_disagreement"],
  human_review: [
    "human_review_available",
    "human_review_conflicted",
    "human_review_expired",
    "human_review_invalid",
    "human_review_missing",
    "human_review_protocol_mismatch",
    "human_review_quorum_shortfall",
  ],
  model_assurance_eligibility: ["model_assurance_eligible", "model_assurance_ineligible"],
} as const satisfies Readonly<
  Record<string, readonly z.infer<typeof ComparisonAssuranceConditionSchema>[]>
>;

const ComparisonReplayUsageMetricSchema = z
  .object({
    ...comparisonMetricIdentityShape,
    aggregation: NumericAggregationSchema,
    dimension: ReplayBudgetDimensionSchema,
    kind: z.literal("replay_usage"),
    unit: AssuranceSummarySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.unit !== COMPARISON_REPLAY_USAGE_UNITS[value.dimension]) {
      context.addIssue({
        code: "custom",
        message: "Replay usage metrics must declare the canonical unit for their dimension",
        path: ["unit"],
      });
    }
  });

export const ComparisonStratumSchema = z
  .object({
    fixtureIds: z
      .array(OpaqueIdSchema)
      .min(1)
      .max(MAX_COMPARISON_SUBJECT_FIXTURES)
      .refine(isStrictlySortedUnique, {
        message: "Comparison stratum fixture IDs must be unique and ordered",
      }),
    label: AssuranceSummarySchema,
    stratumId: OpaqueIdSchema,
  })
  .strict();

export const ComparisonMetricSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...comparisonMetricIdentityShape,
      eventKind: EvidenceKindSchema,
      eventStatus: EvidenceStatusSchema.optional(),
      kind: z.literal("trace_event_count"),
      unit: z.literal(COMPARISON_COUNT_METRIC_UNITS.trace_event_count),
    })
    .strict(),
  z
    .object({
      ...comparisonMetricIdentityShape,
      criterion: CriterionReferenceSchema,
      kind: z.literal("evaluation_verdict_count"),
      unit: z.literal(COMPARISON_COUNT_METRIC_UNITS.evaluation_verdict_count),
      verdict: EvaluationVerdictSchema,
    })
    .strict(),
  z
    .object({
      ...comparisonMetricIdentityShape,
      aggregation: NumericAggregationSchema,
      kind: z.literal("numeric_measurement"),
      measurementName: AssuranceSummarySchema,
      unit: AssuranceSummarySchema,
    })
    .strict(),
  ComparisonReplayUsageMetricSchema,
  z
    .object({
      ...comparisonMetricIdentityShape,
      eventKind: z.enum(["guardrail_check", "replay_safety_intervention", "uncertain_side_effect"]),
      kind: z.literal("safety_event_count"),
      unit: z.literal(COMPARISON_COUNT_METRIC_UNITS.safety_event_count),
    })
    .strict(),
  z
    .object({
      ...comparisonMetricIdentityShape,
      kind: z.literal("artifact_set"),
      projection: z.literal("identity_digest_size_classification_availability"),
      unit: z.literal(COMPARISON_COUNT_METRIC_UNITS.artifact_set),
    })
    .strict(),
  z
    .object({
      ...comparisonMetricIdentityShape,
      condition: ComparisonAssuranceConditionSchema,
      dimension: z.enum([
        "assessment_eligibility",
        "calibration_availability",
        "counterevidence",
        "disagreement",
        "human_review",
        "model_assurance_eligibility",
      ]),
      kind: z.literal("assurance_state_count"),
      unit: z.literal(COMPARISON_COUNT_METRIC_UNITS.assurance_state_count),
    })
    .strict()
    .superRefine((value, context) => {
      const allowedConditions = comparisonAssuranceConditions[value.dimension] as readonly string[];
      if (!allowedConditions.includes(value.condition)) {
        context.addIssue({
          code: "custom",
          message: "Assurance condition must belong to the declared dimension",
          path: ["condition"],
        });
      }
    }),
  z
    .object({
      ...comparisonMetricIdentityShape,
      criterion: CriterionReferenceSchema,
      dimension: z.enum(["abstention", "decided", "error", "observed"]),
      kind: z.literal("coverage_count"),
      unit: z.literal(COMPARISON_COUNT_METRIC_UNITS.coverage_count),
    })
    .strict(),
]);

export const ComparisonCalculationPolicySchema = z
  .object({
    confidenceIntervals: z.literal("source_only"),
    decimalArithmetic: z.literal("exact_decimal_v1"),
    denominators: z.literal("role_fixture_membership_and_paired_observations"),
    fixturePairing: z.literal("logical_fixture_id"),
    invalidCases: z.literal("preserve_and_exclude_from_aggregation"),
    mean: z.literal("exact_rational_v1"),
    minimumPairedCoverageBasisPoints: z.number().int().min(1).max(10_000),
    missingness: z.literal("preserve_all"),
    numericObservationMultiplicity: z.literal("at_most_one_per_fixture"),
    quantile: z.literal("nearest_rank_v1"),
  })
  .strict();

const comparisonDefinitionShape = {
  baseline: ComparisonSubjectSchema,
  calculationPolicy: ComparisonCalculationPolicySchema,
  candidate: ComparisonSubjectSchema,
  classifiedContentProjection: z.literal("metadata_only"),
  comparisonId: OpaqueIdSchema,
  comparisonVersionId: OpaqueIdSchema,
  description: AssuranceSummarySchema.optional(),
  metrics: z
    .array(ComparisonMetricSchema)
    .min(1)
    .max(MAX_COMPARISON_METRICS)
    .refine((metrics) => isStrictlySortedUnique(metrics.map(({ metricId }) => metricId)), {
      message: "Comparison metrics must be unique and ordered by metricId",
    }),
  name: AssuranceSummarySchema,
  predecessor: ComparisonDefinitionPredecessorSchema.optional(),
  strata: z
    .array(ComparisonStratumSchema)
    .min(1)
    .max(MAX_COMPARISON_STRATA)
    .refine((strata) => isStrictlySortedUnique(strata.map(({ stratumId }) => stratumId)), {
      message: "Comparison strata must be unique and ordered by stratumId",
    }),
};

function subjectsEqual(
  left: z.infer<typeof ComparisonSubjectSchema>,
  right: z.infer<typeof ComparisonSubjectSchema>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function refineComparisonPopulation(
  value: {
    readonly baseline: z.infer<typeof ComparisonSubjectSchema>;
    readonly candidate: z.infer<typeof ComparisonSubjectSchema>;
    readonly metrics: readonly z.infer<typeof ComparisonMetricSchema>[];
    readonly strata: readonly z.infer<typeof ComparisonStratumSchema>[];
  },
  context: z.RefinementCtx,
): void {
  const fixtureIds = new Set([
    ...value.baseline.fixtures.map(({ fixture }) => fixture.fixtureId),
    ...value.candidate.fixtures.map(({ fixture }) => fixture.fixtureId),
  ]);
  const stratumIds = new Set(value.strata.map(({ stratumId }) => stratumId));
  for (const [stratumIndex, stratum] of value.strata.entries()) {
    for (const [fixtureIndex, fixtureId] of stratum.fixtureIds.entries()) {
      if (!fixtureIds.has(fixtureId)) {
        context.addIssue({
          code: "custom",
          message: "Comparison strata may reference only fixtures bound by either exact subject",
          path: ["strata", stratumIndex, "fixtureIds", fixtureIndex],
        });
      }
    }
  }
  for (const [metricIndex, metric] of value.metrics.entries()) {
    if (!stratumIds.has(metric.stratumId)) {
      context.addIssue({
        code: "custom",
        message: "Every comparison metric must reference a declared exact stratum",
        path: ["metrics", metricIndex, "stratumId"],
      });
    }
  }
}

function refineComparisonDefinition(
  value: z.infer<z.ZodObject<typeof comparisonDefinitionShape>>,
  context: z.RefinementCtx,
): void {
  if (value.predecessor?.comparisonVersionId === value.comparisonVersionId) {
    context.addIssue({
      code: "custom",
      message: "A comparison version cannot name itself as its predecessor",
      path: ["predecessor", "comparisonVersionId"],
    });
  }
  if (subjectsEqual(value.baseline, value.candidate)) {
    context.addIssue({
      code: "custom",
      message: "Baseline and candidate subjects must not be identical",
      path: ["candidate"],
    });
  }
  refineComparisonPopulation(value, context);
}

export const ComparisonDefinitionSchema = z
  .object(comparisonDefinitionShape)
  .strict()
  .superRefine(refineComparisonDefinition);

export const ComparisonDefinitionRecordSchema = z
  .object({
    ...comparisonDefinitionShape,
    createdAt: UtcMillisecondTimestampSchema,
    createdByPrincipalId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    schemaVersion: z.literal(COMPARISON_DEFINITION_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineComparisonDefinition);

export const PublishComparisonDefinitionRequestSchema = z
  .object({
    baseline: ComparisonSubjectSchema,
    calculationPolicy: ComparisonCalculationPolicySchema,
    candidate: ComparisonSubjectSchema,
    classifiedContentProjection: z.literal("metadata_only"),
    comparisonVersionId: OpaqueIdSchema,
    description: AssuranceSummarySchema.optional(),
    metrics: z
      .array(ComparisonMetricSchema)
      .min(1)
      .max(MAX_COMPARISON_METRICS)
      .refine((metrics) => isStrictlySortedUnique(metrics.map(({ metricId }) => metricId)), {
        message: "Comparison metrics must be unique and ordered by metricId",
      }),
    name: AssuranceSummarySchema,
    predecessorVersionId: OpaqueIdSchema.optional(),
    strata: z
      .array(ComparisonStratumSchema)
      .min(1)
      .max(MAX_COMPARISON_STRATA)
      .refine((strata) => isStrictlySortedUnique(strata.map(({ stratumId }) => stratumId)), {
        message: "Comparison strata must be unique and ordered by stratumId",
      }),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.predecessorVersionId === value.comparisonVersionId) {
      context.addIssue({
        code: "custom",
        message: "A comparison version cannot name itself as its predecessor",
        path: ["predecessorVersionId"],
      });
    }
    if (subjectsEqual(value.baseline, value.candidate)) {
      context.addIssue({
        code: "custom",
        message: "Baseline and candidate subjects must not be identical",
        path: ["candidate"],
      });
    }
    refineComparisonPopulation(value, context);
  });

const ExactIntegerSchema = z
  .string()
  .max(MAX_COMPARISON_EXACT_INTEGER_CHARACTERS)
  .regex(/^-?(?:0|[1-9][0-9]*)$/);
const ExactPositiveIntegerSchema = z
  .string()
  .max(MAX_COMPARISON_EXACT_INTEGER_CHARACTERS)
  .regex(/^[1-9][0-9]*$/);

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

export const ComparisonExactValueSchema = z.discriminatedUnion("representation", [
  z
    .object({
      representation: z.literal("decimal"),
      unit: AssuranceSummarySchema,
      value: ExactDecimalSchema,
    })
    .strict(),
  z
    .object({
      denominator: ExactPositiveIntegerSchema,
      numerator: ExactIntegerSchema,
      representation: z.literal("rational"),
      unit: AssuranceSummarySchema,
    })
    .strict()
    .superRefine((value, context) => {
      const numerator = BigInt(value.numerator);
      const denominator = BigInt(value.denominator);
      if (
        (numerator === 0n && denominator !== 1n) ||
        greatestCommonDivisor(numerator, denominator) !== 1n
      ) {
        context.addIssue({
          code: "custom",
          message: "Exact rational values must use a positive denominator and lowest terms",
          path: ["denominator"],
        });
      }
    }),
]);

export const ComparisonRoleSchema = z.enum(["baseline", "candidate"]);

export const ComparisonEvidenceSnapshotReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    role: ComparisonRoleSchema,
    snapshotId: OpaqueIdSchema,
  })
  .strict();

const SafeComparisonCountSchema = z.number().int().nonnegative().max(MAX_COMPARISON_COUNT);
const PositiveComparisonCountSchema = z.number().int().positive().max(MAX_COMPARISON_COUNT);

const TraceKindCountSchema = z
  .object({ count: PositiveComparisonCountSchema, kind: EvidenceKindSchema })
  .strict();
const TraceKindStatusCountSchema = z
  .object({
    count: PositiveComparisonCountSchema,
    kind: EvidenceKindSchema,
    status: EvidenceStatusSchema,
  })
  .strict();
const TraceStatusCountSchema = z
  .object({ count: PositiveComparisonCountSchema, status: EvidenceStatusSchema })
  .strict();

export const ComparisonTraceStructureSchema = z
  .object({
    eventCount: SafeComparisonCountSchema,
    eventKinds: z
      .array(TraceKindCountSchema)
      .max(EvidenceKindSchema.options.length)
      .refine((values) => isStrictlySortedUnique(values.map(({ kind }) => kind)), {
        message: "Trace event-kind counts must be unique and ordered",
      }),
    eventKindStatuses: z
      .array(TraceKindStatusCountSchema)
      .max(EvidenceKindSchema.options.length * EvidenceStatusSchema.options.length)
      .refine(
        (values) => isStrictlySortedUnique(values.map(({ kind, status }) => `${kind}:${status}`)),
        { message: "Trace kind-status counts must be unique and ordered" },
      ),
    eventStatuses: z
      .array(TraceStatusCountSchema)
      .max(EvidenceStatusSchema.options.length)
      .refine((values) => isStrictlySortedUnique(values.map(({ status }) => status)), {
        message: "Trace event-status counts must be unique and ordered",
      }),
  })
  .strict()
  .superRefine((value, context) => {
    const kindTotal = value.eventKinds.reduce((sum, entry) => sum + entry.count, 0);
    const kindStatusTotal = value.eventKindStatuses.reduce((sum, entry) => sum + entry.count, 0);
    const statusTotal = value.eventStatuses.reduce((sum, entry) => sum + entry.count, 0);
    if (
      !Number.isSafeInteger(kindTotal) ||
      !Number.isSafeInteger(kindStatusTotal) ||
      !Number.isSafeInteger(statusTotal) ||
      kindTotal !== value.eventCount ||
      kindStatusTotal !== value.eventCount ||
      statusTotal !== value.eventCount
    ) {
      context.addIssue({
        code: "custom",
        message: "Trace kind, status, and joint counts must each reconstruct the exact event count",
        path: ["eventCount"],
      });
    }
    const jointKindCounts = new Map<string, number>();
    const jointStatusCounts = new Map<string, number>();
    for (const entry of value.eventKindStatuses) {
      jointKindCounts.set(entry.kind, (jointKindCounts.get(entry.kind) ?? 0) + entry.count);
      jointStatusCounts.set(entry.status, (jointStatusCounts.get(entry.status) ?? 0) + entry.count);
    }
    if (
      value.eventKinds.length !== jointKindCounts.size ||
      value.eventKinds.some(({ count, kind }) => jointKindCounts.get(kind) !== count)
    ) {
      context.addIssue({
        code: "custom",
        message: "Trace kind counts must equal the exact joint kind-status projection",
        path: ["eventKinds"],
      });
    }
    if (
      value.eventStatuses.length !== jointStatusCounts.size ||
      value.eventStatuses.some(({ count, status }) => jointStatusCounts.get(status) !== count)
    ) {
      context.addIssue({
        code: "custom",
        message: "Trace status counts must equal the exact joint kind-status projection",
        path: ["eventStatuses"],
      });
    }
  });

export const ComparisonUsageSourceSchema = z.enum(["estimated", "measured", "provider_reported"]);
export const ComparisonUsageUnavailableReasonSchema = z.enum([
  "measurement_failed",
  "provider_did_not_report",
  "source_unavailable",
]);

const usageSources = z
  .array(ComparisonUsageSourceSchema)
  .min(1)
  .max(ComparisonUsageSourceSchema.options.length)
  .refine(isStrictlySortedUnique, { message: "Usage sources must be unique and ordered" });
const unavailableUsageReasons = z
  .array(ComparisonUsageUnavailableReasonSchema)
  .min(1)
  .max(ComparisonUsageUnavailableReasonSchema.options.length)
  .refine(isStrictlySortedUnique, {
    message: "Unavailable usage reasons must be unique and ordered",
  });

export const ComparisonUsageValueSchema = z.discriminatedUnion("status", [
  z
    .object({
      amount: SafeComparisonCountSchema,
      observedCount: z.number().int().positive().max(MAX_COMPARISON_COUNT),
      sources: usageSources,
      status: z.literal("available"),
      unavailableCount: z.literal(0),
    })
    .strict(),
  z
    .object({
      amount: SafeComparisonCountSchema,
      observedCount: z.number().int().positive().max(MAX_COMPARISON_COUNT),
      sources: usageSources,
      status: z.literal("partial"),
      unavailableCount: z.number().int().positive().max(MAX_COMPARISON_COUNT),
      unavailableReasons: unavailableUsageReasons,
    })
    .strict(),
  z
    .object({
      observedCount: z.literal(0),
      status: z.literal("unavailable"),
      unavailableCount: z.number().int().positive().max(MAX_COMPARISON_COUNT),
      unavailableReasons: unavailableUsageReasons,
    })
    .strict(),
]);

export const ComparisonUsageDimensionSchema = z
  .object({
    dimension: ReplayBudgetDimensionSchema,
    value: ComparisonUsageValueSchema,
  })
  .strict();

export const ComparisonVerdictCountsSchema = z
  .object({
    abstain: SafeComparisonCountSchema,
    error: SafeComparisonCountSchema,
    fail: SafeComparisonCountSchema,
    notApplicable: SafeComparisonCountSchema,
    pass: SafeComparisonCountSchema,
    total: SafeComparisonCountSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const reconstructed =
      value.abstain + value.error + value.fail + value.notApplicable + value.pass;
    if (!Number.isSafeInteger(reconstructed) || reconstructed !== value.total) {
      context.addIssue({
        code: "custom",
        message: "Verdict counts must reconstruct the exact total",
        path: ["total"],
      });
    }
  });

export const ComparisonEvaluationOutcomeSchema = z
  .object({
    assessment: AssessmentReferenceSchema,
    criterion: CriterionReferenceSchema,
    counts: ComparisonVerdictCountsSchema,
  })
  .strict();

export const ComparisonNumericObservationSchema = z
  .object({
    measurementName: AssuranceSummarySchema,
    observation: RawObservationReferenceSchema,
    unit: AssuranceSummarySchema,
    value: ExactDecimalSchema,
  })
  .strict();

export const ComparisonAssuranceStateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      eligibility: z.enum(["eligible", "ineligible"]),
      kind: z.literal("assessment"),
      reasons: z
        .array(AssessmentEligibilityReasonSchema)
        .max(AssessmentEligibilityReasonSchema.options.length)
        .refine(isStrictlySortedUnique, {
          message: "Assessment reasons must be unique and ordered",
        }),
      reference: AssessmentReferenceSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        (value.eligibility === "eligible" && value.reasons.length !== 0) ||
        (value.eligibility === "ineligible" && value.reasons.length === 0)
      ) {
        context.addIssue({
          code: "custom",
          message: "Assessment eligibility and reasons must agree",
          path: ["reasons"],
        });
      }
    }),
  z
    .object({
      eligibility: z.enum(["eligible", "ineligible"]),
      kind: z.literal("model_assurance"),
      reasons: z
        .array(ModelAssuranceIneligibilityReasonSchema)
        .max(ModelAssuranceIneligibilityReasonSchema.options.length)
        .refine(isStrictlySortedUnique, {
          message: "Model-assurance reasons must be unique and ordered",
        }),
      reference: ModelAssuranceAssessmentReferenceSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        (value.eligibility === "eligible" && value.reasons.length !== 0) ||
        (value.eligibility === "ineligible" && value.reasons.length === 0)
      ) {
        context.addIssue({
          code: "custom",
          message: "Model-assurance eligibility and reasons must agree",
          path: ["reasons"],
        });
      }
    }),
]);

export const ComparisonArtifactAvailabilitySchema = z.enum(["available", "revoked", "unavailable"]);

export const ComparisonArtifactStateSchema = z
  .object({
    artifact: ArtifactContentReferenceSchema,
    availability: ComparisonArtifactAvailabilitySchema,
  })
  .strict();

export const ComparisonSafetyEventSchema = z
  .object({
    eventId: OpaqueIdSchema,
    kind: z.enum(["guardrail_check", "replay_safety_intervention", "uncertain_side_effect"]),
    occurredAt: UtcMillisecondTimestampSchema,
    sourceId: OpaqueIdSchema,
    sourceSha256: Sha256Schema,
  })
  .strict();

export const ComparisonOmissionReasonSchema = z.enum([
  "artifact_revoked",
  "artifact_unavailable",
  "classified_content_excluded",
  "measurement_unavailable",
  "optional_assessment_missing",
  "source_over_limit",
]);

export const ComparisonOmissionSchema = z.discriminatedUnion("sourceKind", [
  z
    .object({
      artifactId: OpaqueIdSchema,
      fixtureId: OpaqueIdSchema,
      reason: z.enum(["artifact_revoked", "artifact_unavailable"]),
      sourceKind: z.literal("artifact"),
    })
    .strict(),
  z
    .object({
      assessment: AssessmentReferenceSchema,
      fixtureId: OpaqueIdSchema,
      reason: z.literal("optional_assessment_missing"),
      sourceKind: z.literal("assessment"),
    })
    .strict(),
  z
    .object({
      fixtureId: OpaqueIdSchema,
      projectionKey: AssuranceSummarySchema,
      reason: z.literal("classified_content_excluded"),
      sourceKind: z.literal("classified_content"),
    })
    .strict(),
  z
    .object({
      fixtureId: OpaqueIdSchema,
      measurementName: AssuranceSummarySchema,
      reason: z.enum(["measurement_unavailable", "source_over_limit"]),
      sourceKind: z.literal("numeric_measurement"),
      unit: AssuranceSummarySchema,
    })
    .strict(),
  z
    .object({
      fixtureId: OpaqueIdSchema,
      modelAssuranceAssessment: ModelAssuranceAssessmentReferenceSchema,
      reason: z.literal("optional_assessment_missing"),
      sourceKind: z.literal("model_assurance_assessment"),
    })
    .strict(),
]);

function comparisonOmissionKey(value: z.infer<typeof ComparisonOmissionSchema>): string {
  switch (value.sourceKind) {
    case "artifact":
      return `${value.fixtureId}:artifact:${value.artifactId}`;
    case "assessment":
      return `${value.fixtureId}:assessment:${value.assessment.assessmentId}:${value.assessment.definitionSha256}`;
    case "classified_content":
      return `${value.fixtureId}:classified_content:${value.projectionKey}`;
    case "model_assurance_assessment":
      return `${value.fixtureId}:model_assurance_assessment:${value.modelAssuranceAssessment.assessmentExtensionId}:${value.modelAssuranceAssessment.definitionSha256}`;
    case "numeric_measurement":
      return `${value.fixtureId}:numeric_measurement:${value.measurementName}:${value.unit}`;
  }
}

function exactAssuranceReferenceKey(
  value:
    | z.infer<typeof AssessmentReferenceSchema>
    | z.infer<typeof ModelAssuranceAssessmentReferenceSchema>,
): string {
  return "assessmentId" in value
    ? `${value.assessmentId}:${value.definitionSha256}`
    : `${value.assessmentExtensionId}:${value.definitionSha256}`;
}

export const ComparisonEvidenceFixtureSnapshotSchema = z
  .object({
    artifacts: z
      .array(ComparisonArtifactStateSchema)
      .max(MAX_COMPARISON_ARTIFACTS)
      .refine(
        (values) =>
          isStrictlySortedUnique(
            values.map(({ artifact }) => `${artifact.artifactId}:${artifact.sha256}`),
          ),
        { message: "Comparison artifacts must be unique and ordered by exact content reference" },
      )
      .refine(
        (values) => isStrictlySortedUnique(values.map(({ artifact }) => artifact.artifactId)),
        { message: "Comparison artifact identities must be unique and ordered" },
      ),
    assurance: z
      .array(ComparisonAssuranceStateSchema)
      .max(MAX_COMPARISON_SUBJECT_ASSESSMENTS * 2)
      .refine(
        (values) =>
          isStrictlySortedUnique(
            values.map((value) => `${value.kind}:${exactAssuranceReferenceKey(value.reference)}`),
          ),
        { message: "Comparison assurance state must be unique and ordered" },
      ),
    evaluationOutcomes: z
      .array(ComparisonEvaluationOutcomeSchema)
      .max(MAX_COMPARISON_SUBJECT_ASSESSMENTS)
      .refine(
        (values) =>
          isStrictlySortedUnique(
            values.map(
              ({ assessment, criterion }) =>
                `${criterion.criterionId}:${assessment.assessmentId}:${assessment.definitionSha256}`,
            ),
          ),
        { message: "Comparison evaluation outcomes must be unique and ordered" },
      ),
    fixture: RegressionFixtureVersionReferenceSchema,
    numericObservations: z
      .array(ComparisonNumericObservationSchema)
      .max(MAX_COMPARISON_NUMERIC_OBSERVATIONS)
      .refine(
        (values) =>
          isStrictlySortedUnique(
            values.map(
              ({ measurementName, observation, unit }) =>
                `${measurementName}:${unit}:${observation.observationId}:${observation.definitionSha256}`,
            ),
          ),
        { message: "Numeric observations must be unique and ordered by exact source" },
      ),
    replay: EvaluationReplayResultReferenceSchema,
    safetyEvents: z
      .array(ComparisonSafetyEventSchema)
      .max(MAX_COMPARISON_SAFETY_EVENTS)
      .refine((values) => isStrictlySortedUnique(values.map(({ eventId }) => eventId)), {
        message: "Comparison safety events must be unique and ordered by eventId",
      }),
    trace: ComparisonTraceStructureSchema,
    usage: z
      .array(ComparisonUsageDimensionSchema)
      .max(ReplayBudgetDimensionSchema.options.length)
      .refine((values) => isStrictlySortedUnique(values.map(({ dimension }) => dimension)), {
        message: "Comparison usage dimensions must be unique and ordered",
      }),
  })
  .strict();

const comparisonEvidenceSnapshotDefinitionShape = {
  comparison: ComparisonDefinitionReferenceSchema,
  dataset: EvaluationDatasetVersionReferenceSchema,
  fixtures: z
    .array(ComparisonEvidenceFixtureSnapshotSchema)
    .min(1)
    .max(MAX_COMPARISON_SUBJECT_FIXTURES)
    .refine(
      (fixtures) =>
        isStrictlySortedUnique(
          fixtures.map(({ fixture }) => `${fixture.fixtureId}:${fixture.fixtureVersionId}`),
        ),
      { message: "Evidence snapshot fixtures must be unique and ordered" },
    ),
  integrity: z.literal("verified"),
  knownLimitations: z.array(AssuranceSummarySchema).max(64).refine(isStrictlySortedUnique, {
    message: "Evidence snapshot limitations must be unique and ordered",
  }),
  omissions: z
    .array(ComparisonOmissionSchema)
    .max(MAX_COMPARISON_OMISSIONS)
    .refine((values) => isStrictlySortedUnique(values.map(comparisonOmissionKey)), {
      message: "Evidence snapshot omissions must be unique and ordered by exact source identity",
    }),
  role: ComparisonRoleSchema,
  snapshotId: OpaqueIdSchema,
  sourceCutoff: UtcMillisecondTimestampSchema,
};

function refineComparisonEvidenceSnapshot(
  value: z.infer<z.ZodObject<typeof comparisonEvidenceSnapshotDefinitionShape>>,
  context: z.RefinementCtx,
): void {
  const fixtures = new Map(value.fixtures.map((entry) => [entry.fixture.fixtureId, entry]));
  const artifactOwners = new Map<string, string>();
  let retainedArtifactCount = 0;
  for (const [fixtureIndex, fixture] of value.fixtures.entries()) {
    retainedArtifactCount += fixture.artifacts.length;
    for (const [artifactIndex, { artifact }] of fixture.artifacts.entries()) {
      const ownerFixtureId = artifactOwners.get(artifact.artifactId);
      if (ownerFixtureId !== undefined) {
        context.addIssue({
          code: "custom",
          message: `Artifact identity is already retained by fixture ${ownerFixtureId}`,
          path: ["fixtures", fixtureIndex, "artifacts", artifactIndex, "artifact", "artifactId"],
        });
      } else {
        artifactOwners.set(artifact.artifactId, fixture.fixture.fixtureId);
      }
    }
  }
  if (retainedArtifactCount > MAX_COMPARISON_ARTIFACTS) {
    context.addIssue({
      code: "custom",
      message: `Evidence snapshots can retain at most ${MAX_COMPARISON_ARTIFACTS} artifacts in total`,
      path: ["fixtures"],
    });
  }
  for (const [index, omission] of value.omissions.entries()) {
    const fixture = fixtures.get(omission.fixtureId);
    if (!fixture) {
      context.addIssue({
        code: "custom",
        message: "Evidence omissions must reference a retained exact fixture",
        path: ["omissions", index, "fixtureId"],
      });
      continue;
    }
    if (
      omission.sourceKind === "numeric_measurement" &&
      fixture.numericObservations.some(
        (observation) =>
          observation.measurementName === omission.measurementName &&
          observation.unit === omission.unit,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "An omitted measurement cannot also be retained as an exact observation",
        path: ["omissions", index],
      });
    }
    if (
      omission.sourceKind === "assessment" &&
      fixture.assurance.some(
        (assurance) =>
          assurance.kind === "assessment" &&
          assurance.reference.assessmentId === omission.assessment.assessmentId &&
          assurance.reference.definitionSha256 === omission.assessment.definitionSha256,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "An omitted assessment cannot also be retained in assurance evidence",
        path: ["omissions", index],
      });
    }
    if (
      omission.sourceKind === "model_assurance_assessment" &&
      fixture.assurance.some(
        (assurance) =>
          assurance.kind === "model_assurance" &&
          assurance.reference.assessmentExtensionId ===
            omission.modelAssuranceAssessment.assessmentExtensionId &&
          assurance.reference.definitionSha256 ===
            omission.modelAssuranceAssessment.definitionSha256,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "An omitted model-assurance assessment cannot also be retained",
        path: ["omissions", index],
      });
    }
    if (omission.sourceKind === "artifact") {
      const retained = fixture.artifacts.find(
        ({ artifact }) => artifact.artifactId === omission.artifactId,
      );
      const expectedAvailability =
        omission.reason === "artifact_revoked" ? "revoked" : "unavailable";
      if (!retained) {
        context.addIssue({
          code: "custom",
          message: "An artifact omission must retain its exact unavailable artifact state",
          path: ["omissions", index, "artifactId"],
        });
      } else if (retained.availability !== expectedAvailability) {
        context.addIssue({
          code: "custom",
          message: "A retained artifact state must agree with its omission reason",
          path: ["omissions", index, "reason"],
        });
      }
    }
  }
}

export const ComparisonEvidenceSnapshotDefinitionSchema = z
  .object(comparisonEvidenceSnapshotDefinitionShape)
  .strict()
  .superRefine(refineComparisonEvidenceSnapshot);

export const ComparisonEvidenceSnapshotSchema = z
  .object({
    ...comparisonEvidenceSnapshotDefinitionShape,
    createdAt: UtcMillisecondTimestampSchema,
    createdByPrincipalId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    schemaVersion: z.literal(COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    refineComparisonEvidenceSnapshot(value, context);
    if (
      evidenceTimestampOrderKey(value.createdAt) < evidenceTimestampOrderKey(value.sourceCutoff)
    ) {
      context.addIssue({
        code: "custom",
        message: "Evidence snapshot creation cannot precede its source cutoff",
        path: ["createdAt"],
      });
    }
  });

export const CreateComparisonEvidenceSnapshotRequestSchema = z
  .object({
    comparison: ComparisonDefinitionReferenceSchema,
    role: ComparisonRoleSchema,
    snapshotId: OpaqueIdSchema,
  })
  .strict();

export type ComparisonCalculationPolicy = z.infer<typeof ComparisonCalculationPolicySchema>;
export type ComparisonDefinition = z.infer<typeof ComparisonDefinitionRecordSchema>;
export type ComparisonDefinitionInput = z.infer<typeof ComparisonDefinitionSchema>;
export type ComparisonDefinitionReference = z.infer<typeof ComparisonDefinitionReferenceSchema>;
export type ComparisonMetric = z.infer<typeof ComparisonMetricSchema>;
export type ComparisonExactValue = z.infer<typeof ComparisonExactValueSchema>;
export type ComparisonEvidenceFixtureSnapshot = z.infer<
  typeof ComparisonEvidenceFixtureSnapshotSchema
>;
export type ComparisonEvidenceSnapshot = z.infer<typeof ComparisonEvidenceSnapshotSchema>;
export type ComparisonEvidenceSnapshotDefinition = z.infer<
  typeof ComparisonEvidenceSnapshotDefinitionSchema
>;
export type ComparisonEvidenceSnapshotReference = z.infer<
  typeof ComparisonEvidenceSnapshotReferenceSchema
>;
export type ComparisonOmission = z.infer<typeof ComparisonOmissionSchema>;
export type ComparisonRole = z.infer<typeof ComparisonRoleSchema>;
export type ComparisonStratum = z.infer<typeof ComparisonStratumSchema>;
export type ComparisonSubject = z.infer<typeof ComparisonSubjectSchema>;
export type ComparisonSubjectFixture = z.infer<typeof ComparisonSubjectFixtureSchema>;
export type PublishComparisonDefinitionRequest = z.infer<
  typeof PublishComparisonDefinitionRequestSchema
>;
