import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { ComparisonExactValueSchema } from "./evaluation-comparison.js";
import { UnitIntervalDecimalSchema } from "./evaluation-assessment.js";
import { EvidenceScopeSchema } from "./evidence.js";
import {
  encodeEvaluationCanonicalJson,
  serializeEvaluationCanonicalJson,
} from "./evaluation-definition-encoding.js";
import {
  PolicyEvaluationAlgorithmSchema,
  PolicyEvaluationRequestReferenceSchema,
} from "./policy-evaluation-request.js";
import { PolicyEvaluationSnapshotReferenceSchema } from "./policy-evaluation-snapshot.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import { ReleaseCandidateReferenceSchema } from "./release-candidate.js";
import {
  MAX_POLICY_RULES,
  ReleasePolicyComparatorSchema,
  ReleasePolicyExactDecimalSchema,
  ReleasePolicyReferenceSchema,
  ReleasePolicyUnitSchema,
} from "./release-policy.js";

export const POLICY_EVALUATION_RESULT_SCHEMA_VERSION = "0.1" as const;
export const MAX_POLICY_EVALUATION_RULE_RESULT_BYTES = 2 * 1024;
export const MAX_POLICY_EVALUATION_RESULT_RESPONSE_BYTES = 512 * 1024;
export const POLICY_EVALUATION_RULE_OUTCOMES = [
  "satisfied",
  "violated",
  "indeterminate",
  "not_applicable",
] as const;
export const PolicyEvaluationRuleOutcomeSchema = z.enum(POLICY_EVALUATION_RULE_OUTCOMES);

export const POLICY_EVALUATION_UNRESOLVED_REASONS = [
  "approval_not_evaluated",
  "artifact_content_unavailable",
  "artifact_reference_unavailable",
  "assessment_not_declared",
  "assessment_unavailable",
  "candidate_authority_unverified",
  "comparison_ambiguous",
  "comparison_lineage_invalid",
  "comparison_missing",
  "comparison_unresolved",
  "criterion_authority_unverified",
  "evidence_incomparable",
  "evidence_unqualified",
  "interval_confidence_mismatch",
  "interval_method_mismatch",
  "interval_unavailable",
  "metric_missing",
  "metric_type_mismatch",
  "metric_value_unavailable",
  "model_resolution_missing",
  "policy_authority_unverified",
  "policy_expired",
  "policy_not_effective",
  "policy_superseded",
  "policy_withdrawn",
  "required_selector_unknown",
  "sampling_assumption_unsupported",
  "source_unavailable",
  "zero_denominator",
] as const;
export const PolicyEvaluationUnresolvedReasonSchema = z.enum(POLICY_EVALUATION_UNRESOLVED_REASONS);
export const PolicyEvaluationLimitationSchema = z.enum([
  "approval_not_evaluated",
  "declared_reference_authority_only",
  "external_object_observation_only",
  "historical_observation_only",
  "incomplete_candidate_population",
]);
const Count = z.number().int().nonnegative().safe();
const Order = z.union([z.literal(-1), z.literal(0), z.literal(1)]);
const CountPopulation = z.enum([
  "baselineObservedCount",
  "candidateObservedCount",
  "pairedObservedCount",
  "pairedTotalCount",
  "decidedCount",
  "attemptedCount",
]);
const NumeratorPopulation = z.enum([
  "baselineObservedCount",
  "candidateObservedCount",
  "pairedObservedCount",
]);
const DenominatorPopulation = z.enum([
  "baselineTotalCount",
  "candidateTotalCount",
  "pairedTotalCount",
]);
const PredicateKind = z.enum([
  "comparison_threshold",
  "coverage_floor",
  "uncertainty_bound",
  "eligibility_required",
  "artifact_required",
  "safety_event_ceiling",
  "approval_required",
]);
function sortedUnique(values: readonly string[]) {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

// Intrinsic operand consistency only. Owning snapshot validation must still prove these values
// came from the exact retained sources; a self-consistent supplied operand is not source truth.
function decimalFraction(value: string): { numerator: bigint; denominator: bigint } {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  return {
    numerator: BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n),
    denominator: 10n ** BigInt(fraction.length),
  };
}
function sign(value: bigint): -1 | 0 | 1 {
  return value < 0n ? -1 : value > 0n ? 1 : 0;
}

/** Exact compact operands. Full source provenance remains at this rule's bound snapshot index. */
export const PolicyEvaluationRuleEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("not_evaluated"),
      reason: PolicyEvaluationUnresolvedReasonSchema,
    })
    .strict(),
  z.object({ kind: z.literal("applicability_mismatch") }).strict(),
  z
    .object({
      kind: z.literal("exact_threshold"),
      operand: z.enum(["baseline", "candidate", "delta"]),
      value: ComparisonExactValueSchema,
      threshold: ReleasePolicyExactDecimalSchema,
      unit: ReleasePolicyUnitSchema,
      comparator: ReleasePolicyComparatorSchema,
      order: Order,
    })
    .strict(),
  z
    .object({
      kind: z.literal("count_floor"),
      population: CountPopulation,
      observedCount: Count,
      minimumCount: Count,
      order: Order,
    })
    .strict(),
  z
    .object({
      kind: z.literal("ratio_floor"),
      numeratorPopulation: NumeratorPopulation,
      denominatorPopulation: DenominatorPopulation,
      numerator: Count,
      denominator: Count.positive(),
      minimumBasisPoints: z.number().int().min(1).max(10_000),
      order: Order,
    })
    .strict(),
  z
    .object({
      kind: z.literal("uncertainty_bound"),
      bound: z.enum(["lower", "upper"]),
      value: UnitIntervalDecimalSchema,
      thresholdBasisPoints: z.number().int().min(0).max(10_000),
      comparator: z.enum(["at_least", "at_most"]),
      method: z.literal("wilson_score_interval"),
      methodVersion: z.literal("1.0.0"),
      confidenceLevelBasisPoints: z.number().int().min(5_000).max(9_999),
      successCount: Count,
      trialCount: Count.positive(),
      samplingAssumption: z.literal("supported"),
      order: Order,
    })
    .strict(),
  z
    .object({
      kind: z.literal("eligibility"),
      assessmentClass: z.enum(["evaluation", "model_assurance"]),
      eligibility: z.enum(["eligible", "ineligible"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("artifact"),
      status: z.enum([
        "component_missing",
        "artifact_missing",
        "verified",
        "media_type_disallowed",
        "classification_disallowed",
      ]),
      reference: ArtifactContentReferenceSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("safety_ceiling"),
      eventClass: z.enum([
        "guardrail_check",
        "replay_safety_intervention",
        "uncertain_side_effect",
      ]),
      observedCount: Count,
      maximumCount: Count,
      candidatePopulationComplete: z.boolean(),
      order: Order,
    })
    .strict(),
]);

const RuleShape = {
  ruleIndex: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_POLICY_RULES - 1),
  ruleId: OpaqueIdSchema,
  predicateKind: PredicateKind,
  outcome: PolicyEvaluationRuleOutcomeSchema,
  evidence: PolicyEvaluationRuleEvidenceSchema,
  limitations: z
    .array(PolicyEvaluationLimitationSchema)
    .max(PolicyEvaluationLimitationSchema.options.length)
    .refine(sortedUnique),
};

/** Shape/inventory validation does not replace derivation from an authoritative sealed snapshot. */
export const PolicyEvaluationRuleResultSchema = z
  .object(RuleShape)
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    // Optional undefined fields are absent in the admitted JSON representation. Preserve the
    // owning descriptor without fabricating a redaction value or rejecting valid JS callers.
    const json = JSON.parse(JSON.stringify(value)) as unknown;
    if (encodeEvaluationCanonicalJson(json).byteLength > MAX_POLICY_EVALUATION_RULE_RESULT_BYTES)
      issue("Compact rule result exceeds its encoded metadata ceiling");
    const evidence = value.evidence;
    if (evidence.kind === "not_evaluated") {
      if (value.outcome !== "indeterminate") issue("Unresolved evidence cannot become a verdict");
      if (
        (value.predicateKind === "approval_required") !==
        (evidence.reason === "approval_not_evaluated")
      )
        issue("Approval is an explicit unresolved prerequisite in algorithm 1.0.0");
      return;
    }
    if (value.predicateKind === "approval_required")
      issue("No computed approval outcome is supported");
    if (evidence.kind === "applicability_mismatch") {
      if (value.outcome !== "not_applicable")
        issue("Mismatch must preserve its applicability outcome");
      return;
    }
    const expectedKind = {
      exact_threshold: "comparison_threshold",
      count_floor: "coverage_floor",
      ratio_floor: "coverage_floor",
      uncertainty_bound: "uncertainty_bound",
      eligibility: "eligibility_required",
      artifact: "artifact_required",
      safety_ceiling: "safety_event_ceiling",
    } as const;
    if (value.predicateKind !== expectedKind[evidence.kind])
      issue("Evidence must retain its original predicate family");
    if (
      value.outcome !== "satisfied" &&
      value.outcome !== "violated" &&
      !(
        evidence.kind === "safety_ceiling" &&
        !evidence.candidatePopulationComplete &&
        value.outcome === "indeterminate"
      )
    )
      issue("Computed evidence requires an explicit verdict or incomplete safety population");
    if (evidence.kind === "exact_threshold" && evidence.value.unit !== evidence.unit)
      issue("Exact threshold evidence cannot change its original unit");
    if (evidence.kind === "ratio_floor") {
      if (evidence.numerator > evidence.denominator)
        issue("Observed count cannot exceed its complete population");
      const expected = evidence.numeratorPopulation.replace("ObservedCount", "TotalCount");
      if (evidence.denominatorPopulation !== expected)
        issue("Ratio operands require the same population");
    }
    if (evidence.kind === "uncertainty_bound" && evidence.successCount > evidence.trialCount)
      issue("Wilson successes cannot exceed trials");
    if (
      evidence.kind === "artifact" &&
      (evidence.status === "component_missing") !== (evidence.reference === null)
    )
      issue("Artifact presence must retain its exact descriptor");
    if (
      evidence.kind === "safety_ceiling" &&
      value.outcome === "satisfied" &&
      !evidence.candidatePopulationComplete
    )
      issue("Partial safety observations cannot satisfy a ceiling");
    if (
      evidence.kind === "safety_ceiling" &&
      !evidence.candidatePopulationComplete &&
      !value.limitations.includes("incomplete_candidate_population")
    )
      issue("Incomplete safety population must remain an explicit limitation");
    if (
      evidence.kind === "eligibility" &&
      (value.outcome === "satisfied") !== (evidence.eligibility === "eligible")
    )
      issue("Verdict must preserve original eligibility");
    if (
      evidence.kind === "artifact" &&
      (value.outcome === "satisfied") !== (evidence.status === "verified")
    )
      issue("Artifact verdict must preserve its original observed status");
    if ("order" in evidence) {
      let actualOrder: -1 | 0 | 1;
      if (evidence.kind === "exact_threshold") {
        const actual =
          evidence.value.representation === "decimal"
            ? decimalFraction(evidence.value.value)
            : {
                numerator: BigInt(evidence.value.numerator),
                denominator: BigInt(evidence.value.denominator),
              };
        const threshold = decimalFraction(evidence.threshold);
        actualOrder = sign(
          actual.numerator * threshold.denominator - threshold.numerator * actual.denominator,
        );
      } else if (evidence.kind === "ratio_floor") {
        actualOrder = sign(
          BigInt(evidence.numerator) * 10_000n -
            BigInt(evidence.minimumBasisPoints) * BigInt(evidence.denominator),
        );
      } else if (evidence.kind === "uncertainty_bound") {
        const bound = decimalFraction(evidence.value);
        actualOrder = sign(
          bound.numerator * 10_000n - BigInt(evidence.thresholdBasisPoints) * bound.denominator,
        );
      } else {
        actualOrder = sign(
          BigInt(evidence.observedCount) -
            BigInt(evidence.kind === "count_floor" ? evidence.minimumCount : evidence.maximumCount),
        );
      }
      if (actualOrder !== evidence.order)
        issue("Retained ordering must match its exact original operands");
      let expected: "satisfied" | "violated" | "indeterminate";
      if (evidence.kind === "exact_threshold") {
        const matches = {
          equal: evidence.order === 0,
          not_equal: evidence.order !== 0,
          greater_than: evidence.order === 1,
          greater_than_or_equal: evidence.order !== -1,
          less_than: evidence.order === -1,
          less_than_or_equal: evidence.order !== 1,
        };
        expected = matches[evidence.comparator] ? "satisfied" : "violated";
      } else if (evidence.kind === "uncertainty_bound") {
        const matches =
          evidence.comparator === "at_least" ? evidence.order !== -1 : evidence.order !== 1;
        expected = matches ? "satisfied" : "violated";
      } else if (evidence.kind === "safety_ceiling") {
        expected =
          evidence.order === 1
            ? "violated"
            : evidence.candidatePopulationComplete
              ? "satisfied"
              : "indeterminate";
      } else expected = evidence.order === -1 ? "violated" : "satisfied";
      if (value.outcome !== expected) issue("Verdict cannot contradict retained exact ordering");
    }
  });

const DefinitionShape = {
  evaluationId: OpaqueIdSchema,
  request: PolicyEvaluationRequestReferenceSchema,
  snapshot: PolicyEvaluationSnapshotReferenceSchema,
  candidate: ReleaseCandidateReferenceSchema,
  policy: ReleasePolicyReferenceSchema,
  algorithm: PolicyEvaluationAlgorithmSchema,
  evaluationTime: PolicyEvaluationTimeSchema,
  ruleCount: z.number().int().min(1).max(MAX_POLICY_RULES),
  rules: z.array(PolicyEvaluationRuleResultSchema).min(1).max(MAX_POLICY_RULES),
  outcomeCounts: z
    .object({
      satisfied: z.number().int().nonnegative().max(MAX_POLICY_RULES),
      violated: z.number().int().nonnegative().max(MAX_POLICY_RULES),
      indeterminate: z.number().int().nonnegative().max(MAX_POLICY_RULES),
      not_applicable: z.number().int().nonnegative().max(MAX_POLICY_RULES),
    })
    .strict(),
};
function inventory(value: z.infer<z.ZodObject<typeof DefinitionShape>>, context: z.RefinementCtx) {
  if (context.issues.length > 0) return;
  if (value.ruleCount !== value.rules.length)
    context.addIssue({
      code: "custom",
      message: "Every original rule requires exactly one result",
    });
  let previous = "";
  const counts = { satisfied: 0, violated: 0, indeterminate: 0, not_applicable: 0 };
  for (const [index, rule] of value.rules.entries()) {
    if (rule.ruleIndex !== index || rule.ruleId <= previous)
      context.addIssue({
        code: "custom",
        message: "Results require contiguous original policy order",
        path: ["rules", index],
      });
    previous = rule.ruleId;
    counts[rule.outcome]++;
  }
  if (
    serializeEvaluationCanonicalJson(counts) !==
    serializeEvaluationCanonicalJson(value.outcomeCounts)
  )
    context.addIssue({
      code: "custom",
      message: "Outcome counts must retain every rule outcome",
      path: ["outcomeCounts"],
    });
}
function admitRules(raw: unknown, context: z.RefinementCtx) {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const rules: unknown = Reflect.get(raw, "rules");
    if (Array.isArray(rules) && rules.length > MAX_POLICY_RULES) {
      context.addIssue({
        code: "custom",
        message: "Result rules exceed the fixed policy ceiling",
        path: ["rules"],
      });
      return z.NEVER;
    }
  }
  return raw;
}
export const PolicyEvaluationDefinitionSchema = z.preprocess(
  admitRules,
  z.object(DefinitionShape).strict().superRefine(inventory),
);
export const PolicyEvaluationResultReferenceSchema = z
  .object({
    evaluationId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();
/** A parsed server receipt grants no execution or publication capability. */
export const PolicyEvaluationSchema = z.preprocess(
  admitRules,
  z
    .object({
      ...DefinitionShape,
      definitionSha256: Sha256Schema,
      schemaVersion: z.literal(POLICY_EVALUATION_RESULT_SCHEMA_VERSION),
      scope: EvidenceScopeSchema,
      recordedAt: PolicyEvaluationTimeSchema,
      recordedByPrincipalId: OpaqueIdSchema,
      jobId: OpaqueIdSchema,
      attemptId: OpaqueIdSchema,
      workerId: OpaqueIdSchema,
      leaseId: OpaqueIdSchema,
      fencingToken: z.number().int().positive().safe(),
      recoveryEpoch: z.number().int().nonnegative().safe(),
    })
    .strict()
    .superRefine(inventory)
    .superRefine((value, context) => {
      if (context.issues.length > 0) return;
      if (
        policyEvaluationTimestampOrderKey(value.recordedAt) <
        policyEvaluationTimestampOrderKey(value.evaluationTime)
      )
        context.addIssue({
          code: "custom",
          message: "Result receipt cannot precede its semantic evaluation cut",
          path: ["recordedAt"],
        });
    }),
);
export type PolicyEvaluationRuleResult = z.infer<typeof PolicyEvaluationRuleResultSchema>;
export type PolicyEvaluationDefinition = z.infer<typeof PolicyEvaluationDefinitionSchema>;
export type PolicyEvaluationResultReference = z.infer<typeof PolicyEvaluationResultReferenceSchema>;
export type PolicyEvaluation = z.infer<typeof PolicyEvaluationSchema>;
