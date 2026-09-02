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

export const COMPARISON_DEFINITION_SCHEMA_VERSION = "0.1" as const;
export const COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION = "0.1" as const;
export const MAX_COMPARISON_SUBJECT_FIXTURES = 500;
export const MAX_COMPARISON_SUBJECT_ASSESSMENTS = 128;
export const MAX_COMPARISON_METRICS = 128;
export const MAX_COMPARISON_NUMERIC_OBSERVATIONS = 8_000;
export const MAX_COMPARISON_ARTIFACTS = 4_000;
export const MAX_COMPARISON_SAFETY_EVENTS = 4_000;
export const MAX_COMPARISON_OMISSIONS = 4_000;
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

export const ComparisonRoleSchema = z.enum(["baseline", "candidate"]);

export const ComparisonEvidenceSnapshotReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    role: ComparisonRoleSchema,
    snapshotId: OpaqueIdSchema,
  })
  .strict();

const SafeComparisonCountSchema = z.number().int().nonnegative().max(MAX_COMPARISON_COUNT);

const TraceKindCountSchema = z
  .object({ count: SafeComparisonCountSchema, kind: EvidenceKindSchema })
  .strict();
const TraceStatusCountSchema = z
  .object({ count: SafeComparisonCountSchema, status: EvidenceStatusSchema })
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
    const statusTotal = value.eventStatuses.reduce((sum, entry) => sum + entry.count, 0);
    if (
      !Number.isSafeInteger(kindTotal) ||
      !Number.isSafeInteger(statusTotal) ||
      kindTotal !== value.eventCount ||
      statusTotal !== value.eventCount
    ) {
      context.addIssue({
        code: "custom",
        message: "Trace kind and status counts must each reconstruct the exact event count",
        path: ["eventCount"],
      });
    }
  });

const ComparisonUsageSourceSchema = z.enum(["estimated", "measured", "provider_reported"]);
const ComparisonUsageUnavailableReasonSchema = z.enum([
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

export const ComparisonArtifactStateSchema = z
  .object({
    artifact: ArtifactContentReferenceSchema,
    availability: z.enum(["available", "revoked", "unavailable"]),
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

export const ComparisonOmissionSchema = z
  .object({
    reason: ComparisonOmissionReasonSchema,
    sourceKey: AssuranceSummarySchema,
  })
  .strict();

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
    .refine((values) => isStrictlySortedUnique(values.map(({ sourceKey }) => sourceKey)), {
      message: "Evidence snapshot omissions must be unique and ordered by sourceKey",
    }),
  role: ComparisonRoleSchema,
  snapshotId: OpaqueIdSchema,
  sourceCutoff: UtcMillisecondTimestampSchema,
};

export const ComparisonEvidenceSnapshotDefinitionSchema = z
  .object(comparisonEvidenceSnapshotDefinitionShape)
  .strict();

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
export type ComparisonRole = z.infer<typeof ComparisonRoleSchema>;
export type ComparisonSubject = z.infer<typeof ComparisonSubjectSchema>;
export type ComparisonSubjectFixture = z.infer<typeof ComparisonSubjectFixtureSchema>;
export type PublishComparisonDefinitionRequest = z.infer<
  typeof PublishComparisonDefinitionRequestSchema
>;
