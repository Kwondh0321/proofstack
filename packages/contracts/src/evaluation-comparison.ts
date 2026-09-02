import { z } from "zod";
import { RegressionFixtureVersionReferenceSchema } from "./dataset.js";
import { AssessmentReferenceSchema } from "./evaluation-assessment.js";
import { CriterionReferenceSchema, ExactDecimalSchema } from "./evaluation-criteria.js";
import { ModelAssuranceAssessmentReferenceSchema } from "./evaluation-model-assessment.js";
import {
  EvaluationDatasetVersionReferenceSchema,
  EvaluationReplayResultReferenceSchema,
  EvaluationVerdictSchema,
} from "./evaluation-run.js";
import { AssuranceSummarySchema } from "./evaluation-source.js";
import { EvidenceKindSchema, EvidenceScopeSchema, EvidenceStatusSchema } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { ReplayBudgetDimensionSchema } from "./replay-accounting.js";

export const COMPARISON_DEFINITION_SCHEMA_VERSION = "0.1" as const;
export const MAX_COMPARISON_SUBJECT_FIXTURES = 500;
export const MAX_COMPARISON_SUBJECT_ASSESSMENTS = 128;
export const MAX_COMPARISON_METRICS = 128;

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
  z.object({ method: z.enum(["maximum", "mean", "median", "minimum", "sum"]) }).strict(),
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
};

export const ComparisonMetricSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...comparisonMetricIdentityShape,
      eventKind: EvidenceKindSchema,
      eventStatus: EvidenceStatusSchema.optional(),
      kind: z.literal("trace_event_count"),
    })
    .strict(),
  z
    .object({
      ...comparisonMetricIdentityShape,
      criterion: CriterionReferenceSchema,
      kind: z.literal("evaluation_verdict_count"),
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
  z
    .object({
      ...comparisonMetricIdentityShape,
      aggregation: NumericAggregationSchema,
      dimension: ReplayBudgetDimensionSchema,
      kind: z.literal("replay_usage"),
    })
    .strict(),
  z
    .object({
      ...comparisonMetricIdentityShape,
      eventKind: z.enum(["guardrail_check", "replay_safety_intervention", "uncertain_side_effect"]),
      kind: z.literal("safety_event_count"),
    })
    .strict(),
  z
    .object({
      ...comparisonMetricIdentityShape,
      kind: z.literal("artifact_set"),
      projection: z.literal("identity_digest_size_classification_availability"),
    })
    .strict(),
  z
    .object({
      ...comparisonMetricIdentityShape,
      dimension: z.enum([
        "assessment_eligibility",
        "calibration_availability",
        "counterevidence",
        "disagreement",
        "human_review",
        "model_assurance_eligibility",
      ]),
      kind: z.literal("assurance_state_count"),
    })
    .strict(),
  z
    .object({
      ...comparisonMetricIdentityShape,
      dimension: z.enum(["abstention", "decided", "error", "observed", "paired"]),
      kind: z.literal("coverage_count"),
    })
    .strict(),
]);

export const ComparisonCalculationPolicySchema = z
  .object({
    confidenceIntervals: z.literal("source_only"),
    decimalArithmetic: z.literal("exact_decimal_v1"),
    fixturePairing: z.literal("logical_fixture_id"),
    mean: z.literal("exact_rational_v1"),
    missingness: z.literal("preserve_all"),
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
};

function subjectsEqual(
  left: z.infer<typeof ComparisonSubjectSchema>,
  right: z.infer<typeof ComparisonSubjectSchema>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  });

export const ComparisonExactValueSchema = z
  .object({
    unit: AssuranceSummarySchema,
    value: ExactDecimalSchema,
  })
  .strict();

export type ComparisonCalculationPolicy = z.infer<typeof ComparisonCalculationPolicySchema>;
export type ComparisonDefinition = z.infer<typeof ComparisonDefinitionRecordSchema>;
export type ComparisonDefinitionInput = z.infer<typeof ComparisonDefinitionSchema>;
export type ComparisonDefinitionReference = z.infer<typeof ComparisonDefinitionReferenceSchema>;
export type ComparisonMetric = z.infer<typeof ComparisonMetricSchema>;
export type ComparisonSubject = z.infer<typeof ComparisonSubjectSchema>;
export type ComparisonSubjectFixture = z.infer<typeof ComparisonSubjectFixtureSchema>;
export type PublishComparisonDefinitionRequest = z.infer<
  typeof PublishComparisonDefinitionRequestSchema
>;
