import { z } from "zod";
import { ArtifactContentReferenceSchema, ArtifactOwnershipSchema } from "./artifact.js";
import {
  AssessmentSchema,
  EvaluationAggregateCountsSchema,
  EvaluationAggregationPolicySchema,
  EvaluationPassIntervalSchema,
  EvaluationSamplingAssumptionSchema,
} from "./evaluation-assessment.js";
import {
  ComparisonCalculationPolicySchema,
  ComparisonMetricSchema,
  ComparisonStratumSchema,
  MAX_COMPARISON_METRICS,
  MAX_COMPARISON_STRATA,
} from "./evaluation-comparison.js";
import {
  ComparisonComparabilitySchema,
  ComparisonMetricResultSchema,
  ComparisonPairingSummarySchema,
} from "./evaluation-comparison-result.js";
import { ModelAssuranceAssessmentSchema } from "./evaluation-model-assessment.js";
import { EvidenceScopeSchema } from "./evidence.js";
import { serializeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { PolicyEvaluationComparisonResolutionSchema } from "./policy-evaluation-comparison-selection.js";
import { PolicyEvaluationSourceObservationSchema } from "./policy-evaluation-manifest.js";
import { PolicyEvaluationRequestReferenceSchema } from "./policy-evaluation-request.js";
import { PolicyEvaluationSourceReferenceSchema } from "./policy-evaluation-source-reference.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { MAX_POLICY_RULES, ReleasePolicyRuleSchema } from "./release-policy.js";

export const POLICY_EVALUATION_SNAPSHOT_RULES_SCHEMA_VERSION = "0.1" as const;
const MetricIndexSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_COMPARISON_METRICS - 1);

const WitnessSchema = z
  .object({ source: PolicyEvaluationSourceReferenceSchema, recordSha256: Sha256Schema })
  .strict();
const UnavailableObservationSchema = z.union([
  PolicyEvaluationSourceObservationSchema.options[1],
  PolicyEvaluationSourceObservationSchema.options[2],
]);

function retained<T extends z.ZodTypeAny>(projection: T) {
  return z.union([
    z.object({ status: z.literal("verified"), witness: WitnessSchema, projection }).strict(),
    z
      .object({
        status: z.literal("unavailable"),
        source: PolicyEvaluationSourceReferenceSchema,
        observation: UnavailableObservationSchema,
      })
      .strict(),
  ]);
}

const AggregateSchema = retained(
  z
    .object({
      counts: EvaluationAggregateCountsSchema,
      samplingAssumption: EvaluationSamplingAssumptionSchema,
      passInterval: EvaluationPassIntervalSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (context.issues.length > 0 || value.passInterval.status !== "reported") return;
      const interval = value.passInterval.interval;
      if (
        value.samplingAssumption.status !== "supported" ||
        interval.successCount !== value.counts.passCount ||
        interval.trialCount !== value.counts.decidedCount
      )
        context.addIssue({
          code: "custom",
          message: "Interval must retain its exact sample basis",
        });
    }),
);
const AggregationPolicySchema = retained(
  z.object({ method: EvaluationAggregationPolicySchema.shape.method }).strict(),
);
const AggregateOperandShape = {
  aggregate: AggregateSchema,
  aggregationPolicy: AggregationPolicySchema,
};
const AssessmentOperandSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...AggregateOperandShape,
        kind: z.literal("coverage_count"),
        field: z.enum(["decidedCount", "attemptedCount"]),
      })
      .strict(),
    z
      .object({
        ...AggregateOperandShape,
        kind: z.literal("uncertainty_interval"),
        field: z.enum(["lowerBound", "upperBound"]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("evaluation_eligibility"),
        eligibility: AssessmentSchema.shape.eligibility,
        dimensions: AssessmentSchema.shape.dimensions,
      })
      .strict(),
    z
      .object({
        kind: z.literal("model_eligibility"),
        eligibility: ModelAssuranceAssessmentSchema.shape.eligibility,
        reasons: ModelAssuranceAssessmentSchema.shape.reasons,
        baseAssessment: ModelAssuranceAssessmentSchema.shape.baseAssessment,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.kind === "model_eligibility" &&
      (value.eligibility === "eligible") !== (value.reasons.length === 0)
    )
      context.addIssue({
        code: "custom",
        message: "Model eligibility must retain its original reasons",
      });
  });

const ComparisonMetricInputSchema = z
  .object({
    definitionIndex: MetricIndexSchema,
    resultIndex: MetricIndexSchema,
    stratumIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_COMPARISON_STRATA - 1),
    definition: ComparisonMetricSchema,
    result: ComparisonMetricResultSchema,
    stratum: ComparisonStratumSchema,
    provenance: z
      .object({
        calculationPolicy: ComparisonCalculationPolicySchema,
        comparability: ComparisonComparabilitySchema,
        pairing: ComparisonPairingSummarySchema,
        latestSourceCutoff: UtcMillisecondTimestampSchema,
      })
      .strict(),
    witnesses: z
      .object({
        comparison: WitnessSchema,
        result: WitnessSchema,
        baselineSnapshot: WitnessSchema,
        candidateSnapshot: WitnessSchema,
      })
      .strict(),
  })
  .strict();

const ComparisonBindingSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("comparison_unusable"),
      reason: z.enum(["selection_unresolved", "records_unavailable", "lineage_invalid"]),
    })
    .strict(),
  z.object({ status: z.literal("metric_missing") }).strict(),
  z.object({ status: z.literal("metric_bound"), metric: ComparisonMetricInputSchema }).strict(),
]);
const AssessmentBindingSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_declared") }).strict(),
  z
    .object({
      status: z.literal("assessment_unavailable"),
      observation: UnavailableObservationSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("inputs_retained"),
      assessment: WitnessSchema,
      operand: AssessmentOperandSchema,
    })
    .strict(),
]);

export const PolicyEvaluationArtifactObservationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("verified"),
      sha256: Sha256Schema,
      sizeBytes: z.number().int().positive().safe(),
    })
    .strict(),
  z.object({ status: z.literal("missing") }).strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.enum([
        "reference_unsupported",
        "record_invalid",
        "reference_mismatch",
        "not_yet_available",
        "reserved",
        "tombstoned",
        "purged",
        "retention_expired",
        "object_missing",
        "content_integrity_failed",
      ]),
    })
    .strict(),
]);
const ArtifactBindingSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("component_missing") }).strict(),
  z.object({ status: z.literal("model_alias") }).strict(),
  z
    .object({
      status: z.literal("artifact_declared"),
      reference: ArtifactContentReferenceSchema,
      catalog: z
        .object({ recordSha256: Sha256Schema, ownership: ArtifactOwnershipSchema.nullable() })
        .strict()
        .nullable(),
      observation: PolicyEvaluationArtifactObservationSchema,
    })
    .strict(),
]);
const InputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("comparison"),
      selection: PolicyEvaluationComparisonResolutionSchema,
      binding: ComparisonBindingSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("assessment"),
      source: PolicyEvaluationSourceReferenceSchema,
      binding: AssessmentBindingSchema,
    })
    .strict(),
  z.object({ kind: z.literal("artifact"), binding: ArtifactBindingSchema }).strict(),
  z
    .object({
      kind: z.literal("approval"),
      status: z.literal("not_evaluated"),
      reason: z.literal("approval_not_evaluated"),
    })
    .strict(),
]);

function same(left: unknown, right: unknown): boolean {
  return serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
}

/** Bounded semantic inputs. Owning capture must prove full source bodies before projection. */
export const PolicyEvaluationRuleProjectionSchema = z
  .object({
    ruleIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_POLICY_RULES - 1),
    rule: ReleasePolicyRuleSchema,
    input: InputSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const predicate = value.rule.predicate;
    const input = value.input;
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message, path: ["input"] });
    const expected =
      predicate.kind === "approval_required"
        ? "approval"
        : predicate.kind === "artifact_required"
          ? "artifact"
          : "comparison" in predicate
            ? "comparison"
            : "assessment";
    if (input.kind !== expected) return issue("Every rule must retain its owning input family");
    if (input.kind === "comparison" && "comparison" in predicate) {
      if (!same(input.selection.comparison, predicate.comparison))
        issue("Comparison identity must match the original predicate");
      const binding = input.binding;
      if (binding.status === "comparison_unusable" && binding.reason === "selection_unresolved") {
        if (input.selection.status === "unique") issue("Unresolved selection cannot become unique");
      } else if (input.selection.status !== "unique")
        issue("Usable or retained comparison requires unique selection");
      if (binding.status === "metric_bound") {
        const metric = binding.metric;
        if (
          metric.definition.metricId !== predicate.metricId ||
          metric.result.metricId !== predicate.metricId ||
          metric.definition.kind !== metric.result.kind ||
          metric.definition.unit !== metric.result.unit ||
          metric.definition.stratumId !== metric.stratum.stratumId
        )
          issue("Metric identity, kind, unit and stratum must agree");
        const { comparison, result, baselineSnapshot, candidateSnapshot } = metric.witnesses;
        if (
          comparison.source.kind !== "comparison_definition" ||
          !same(comparison.source.reference, predicate.comparison) ||
          result.source.kind !== "comparison_result" ||
          input.selection.status !== "unique" ||
          !same(result.source.reference, input.selection.result) ||
          baselineSnapshot.source.kind !== "comparison_snapshot" ||
          baselineSnapshot.source.reference.role !== "baseline" ||
          candidateSnapshot.source.kind !== "comparison_snapshot" ||
          candidateSnapshot.source.reference.role !== "candidate"
        )
          issue("Comparison source witnesses must retain exact result and snapshot roles");
      }
    } else if (input.kind === "assessment" && "assessment" in predicate) {
      const model =
        predicate.kind === "eligibility_required" &&
        predicate.assessmentClass === "model_assurance";
      if (
        input.source.kind !== (model ? "model_assurance_assessment" : "assessment") ||
        !same(input.source.reference, predicate.assessment)
      )
        issue("Assessment source must match its declared class and identity");
      const binding = input.binding;
      if (binding.status === "inputs_retained") {
        if (!same(binding.assessment.source, input.source))
          issue("Assessment witness cannot substitute another source");
        const operand = binding.operand;
        if (predicate.kind === "coverage_floor") {
          if (
            operand.kind !== "coverage_count" ||
            operand.field !==
              (predicate.sampleClass === "decided" ? "decidedCount" : "attemptedCount")
          )
            issue("Coverage must preserve the declared sample class");
        } else if (predicate.kind === "uncertainty_bound") {
          if (
            operand.kind !== "uncertainty_interval" ||
            operand.field !== (predicate.bound === "lower" ? "lowerBound" : "upperBound")
          )
            issue("Uncertainty must preserve the declared bound");
        } else if (operand.kind !== (model ? "model_eligibility" : "evaluation_eligibility"))
          issue("Eligibility cannot change assessment class");
        if (operand.kind === "coverage_count" || operand.kind === "uncertainty_interval") {
          for (const [captured, kind] of [
            [operand.aggregate, "evaluation_aggregate"],
            [operand.aggregationPolicy, "aggregation_policy"],
          ] as const) {
            const source =
              captured.status === "verified" ? captured.witness.source : captured.source;
            if (source.kind !== kind)
              issue("Aggregate and policy must preserve owning source kinds");
          }
        }
      }
    } else if (input.kind === "artifact") {
      const binding = input.binding;
      if (binding.status === "artifact_declared") {
        const observation = binding.observation;
        const hasValidCatalog =
          observation.status === "verified" ||
          (observation.status === "unavailable" &&
            !["reference_unsupported", "record_invalid", "reference_mismatch"].includes(
              observation.reason,
            ));
        if (hasValidCatalog !== (binding.catalog !== null))
          issue("Artifact catalog presence must match the owning observation class");
      }
      if (
        binding.status === "artifact_declared" &&
        binding.observation.status === "verified" &&
        (binding.catalog === null ||
          binding.observation.sha256 !== binding.reference.sha256 ||
          binding.observation.sizeBytes !== binding.reference.sizeBytes)
      )
        issue("Verified content must retain its exact catalog, digest and size");
      if (
        binding.status === "model_alias" &&
        predicate.kind === "artifact_required" &&
        predicate.componentKind !== "model_resolution"
      )
        issue("Only model resolution can retain an alias-only component");
    }
  });

const SnapshotRuleInputsObjectSchema = z
  .object({
    schemaVersion: z.literal(POLICY_EVALUATION_SNAPSHOT_RULES_SCHEMA_VERSION),
    request: PolicyEvaluationRequestReferenceSchema,
    scope: EvidenceScopeSchema,
    evaluationTime: PolicyEvaluationTimeSchema,
    candidate: WitnessSchema,
    policy: WitnessSchema,
    ruleCount: z.number().int().min(1).max(MAX_POLICY_RULES),
    rules: z.array(PolicyEvaluationRuleProjectionSchema).min(1).max(MAX_POLICY_RULES),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    if (value.ruleCount !== value.rules.length)
      context.addIssue({
        code: "custom",
        message: "Rule count must retain the complete original policy inventory",
        path: ["rules"],
      });
    if (
      value.candidate.source.kind !== "release_candidate" ||
      value.policy.source.kind !== "release_policy"
    )
      context.addIssue({
        code: "custom",
        message: "Rule inputs require exact candidate and policy roots",
      });
    let previous = "";
    value.rules.forEach((frame, index) => {
      if (frame.ruleIndex !== index || frame.rule.ruleId <= previous)
        context.addIssue({
          code: "custom",
          message: "Rules must retain complete contiguous original policy order",
          path: ["rules", index],
        });
      previous = frame.rule.ruleId;
      if (
        frame.input.kind === "comparison" &&
        frame.input.binding.status === "metric_bound" &&
        policyEvaluationTimestampOrderKey(
          frame.input.binding.metric.provenance.latestSourceCutoff,
        ) > policyEvaluationTimestampOrderKey(value.evaluationTime)
      )
        context.addIssue({
          code: "custom",
          message: "Comparison source cut cannot follow the original evaluation time",
          path: ["rules", index],
        });
      if (frame.input.kind === "artifact" && frame.input.binding.status === "artifact_declared") {
        const owner = frame.input.binding.catalog?.ownership;
        if (
          owner &&
          (!same(owner.scope, value.scope) ||
            owner.artifactId !== frame.input.binding.reference.artifactId)
        )
          context.addIssue({
            code: "custom",
            message: "Artifact ownership must retain exact scope and identity",
            path: ["rules", index],
          });
      }
    });
  });

/** Admit the fixed rule count before parsing any nested policy or source material. */
export const PolicyEvaluationSnapshotRuleInputsSchema = z.preprocess((raw, context) => {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const rules: unknown = Reflect.get(raw, "rules");
    if (Array.isArray(rules) && rules.length > MAX_POLICY_RULES) {
      context.addIssue({
        code: "custom",
        message: "Rule inputs exceed the fixed policy rule ceiling",
        path: ["rules"],
      });
      return z.NEVER;
    }
  }
  return raw;
}, SnapshotRuleInputsObjectSchema);

export type PolicyEvaluationRuleProjection = z.infer<typeof PolicyEvaluationRuleProjectionSchema>;
export type PolicyEvaluationSnapshotRuleInputs = z.infer<
  typeof PolicyEvaluationSnapshotRuleInputsSchema
>;
