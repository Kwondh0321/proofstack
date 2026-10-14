import {
  PolicyEvaluationRuleProjectionSchema,
  PolicyEvaluationRuleResultSchema,
  type PolicyEvaluationRuleResult,
  type PolicyEvaluationUnresolvedReasonSchema,
} from "@proofstack/contracts";
import {
  comparePolicyCounts,
  comparePolicyCoverageRatio,
  comparePolicyExactThreshold,
  comparePolicyProbabilityBound,
} from "./policy-exact-arithmetic.js";
import { compareComparisonExactValues } from "../evaluation/comparison-exact-arithmetic.js";

type Reason = (typeof PolicyEvaluationUnresolvedReasonSchema.options)[number];
type Evidence = PolicyEvaluationRuleResult["evidence"];
const populations = {
  baseline_observed: "baselineObservedCount",
  candidate_observed: "candidateObservedCount",
  paired_observed: "pairedObservedCount",
  paired_total: "pairedTotalCount",
  baseline_total: "baselineTotalCount",
  candidate_total: "candidateTotalCount",
} as const;

/**
 * Pure predicate projection only. Owning sealed-input derivation and global source/authority/
 * qualification/applicability gates must precede this helper. It cannot publish a policy result.
 */
export function evaluatePolicyPredicateProjection(raw: unknown): PolicyEvaluationRuleResult {
  const frame = PolicyEvaluationRuleProjectionSchema.parse(raw);
  const predicate = frame.rule.predicate;
  const input = frame.input;
  const result = (
    outcome: PolicyEvaluationRuleResult["outcome"],
    evidence: Evidence,
    limitations: PolicyEvaluationRuleResult["limitations"] = ["historical_observation_only"],
  ): PolicyEvaluationRuleResult =>
    PolicyEvaluationRuleResultSchema.parse({
      ruleIndex: frame.ruleIndex,
      ruleId: frame.rule.ruleId,
      predicateKind: predicate.kind,
      outcome,
      evidence,
      limitations,
    });
  const unresolved = (reason: Reason) =>
    result("indeterminate", {
      kind: "not_evaluated",
      reason: reason as Extract<Evidence, { kind: "not_evaluated" }>["reason"],
    });
  if (predicate.kind === "approval_required")
    return result("indeterminate", { kind: "not_evaluated", reason: "approval_not_evaluated" }, [
      "approval_not_evaluated",
      "historical_observation_only",
    ]);

  if (predicate.kind === "artifact_required") {
    if (input.kind !== "artifact") throw new TypeError("Expected owning artifact projection");
    const binding = input.binding;
    if (binding.status === "component_missing")
      return result("violated", { kind: "artifact", status: "component_missing", reference: null });
    if (binding.status === "model_alias") return unresolved("model_resolution_missing");
    const reference = binding.reference;
    if (!predicate.allowedMediaTypes.includes(reference.mediaType))
      return result("violated", { kind: "artifact", status: "media_type_disallowed", reference });
    const ranks = { metadata: 0, internal: 1, confidential: 2, restricted: 3 };
    if (ranks[reference.classification] > ranks[predicate.maximumDataClassification])
      return result("violated", {
        kind: "artifact",
        status: "classification_disallowed",
        reference,
      });
    if (binding.observation.status === "missing")
      return result("violated", { kind: "artifact", status: "artifact_missing", reference });
    if (binding.observation.status !== "verified")
      return unresolved("artifact_content_unavailable");
    if (binding.catalog === null) return unresolved("artifact_reference_unavailable");
    return result("satisfied", { kind: "artifact", status: "verified", reference }, [
      "external_object_observation_only",
      "historical_observation_only",
    ]);
  }

  if (input.kind === "assessment") {
    const binding = input.binding;
    if (binding.status === "not_declared") return unresolved("assessment_not_declared");
    if (binding.status === "assessment_unavailable") return unresolved("assessment_unavailable");
    const operand = binding.operand;
    if (predicate.kind === "eligibility_required") {
      if (operand.kind !== "evaluation_eligibility" && operand.kind !== "model_eligibility")
        throw new TypeError("Expected owning eligibility projection");
      const eligibility =
        operand.kind === "evaluation_eligibility"
          ? operand.eligibility.status
          : operand.eligibility;
      return result(eligibility === "eligible" ? "satisfied" : "violated", {
        kind: "eligibility",
        assessmentClass: predicate.assessmentClass,
        eligibility,
      });
    }
    if (operand.kind !== "coverage_count" && operand.kind !== "uncertainty_interval")
      throw new TypeError("Expected owning aggregate projection");
    if (operand.aggregate.status !== "verified" || operand.aggregationPolicy.status !== "verified")
      return unresolved("source_unavailable");
    const aggregate = operand.aggregate.projection;
    if (
      predicate.kind === "coverage_floor" &&
      predicate.sourceKind === "assessment_samples" &&
      operand.kind === "coverage_count"
    ) {
      const observedCount = aggregate.counts[operand.field];
      const compared = comparePolicyCounts(
        observedCount,
        predicate.minimumCount,
        "greater_than_or_equal",
      );
      return result(compared.matches ? "satisfied" : "violated", {
        kind: "count_floor",
        population: operand.field,
        observedCount,
        minimumCount: predicate.minimumCount,
        order: compared.order,
      });
    }
    if (predicate.kind === "uncertainty_bound" && operand.kind === "uncertainty_interval") {
      if (aggregate.samplingAssumption.status !== "supported")
        return unresolved("sampling_assumption_unsupported");
      if (aggregate.passInterval.status !== "reported") return unresolved("interval_unavailable");
      const interval = aggregate.passInterval.interval;
      if (
        interval.method !== predicate.intervalMethod ||
        interval.methodVersion !== predicate.intervalMethodVersion
      )
        return unresolved("interval_method_mismatch");
      if (interval.confidenceLevelBasisPoints !== predicate.confidenceLevelBasisPoints)
        return unresolved("interval_confidence_mismatch");
      const value = interval[operand.field];
      const compared = comparePolicyProbabilityBound(
        value,
        predicate.thresholdBasisPoints,
        predicate.comparator,
      );
      return result(compared.matches ? "satisfied" : "violated", {
        kind: "uncertainty_bound",
        bound: predicate.bound,
        value,
        thresholdBasisPoints: predicate.thresholdBasisPoints,
        comparator: predicate.comparator,
        method: interval.method,
        methodVersion: interval.methodVersion,
        confidenceLevelBasisPoints: interval.confidenceLevelBasisPoints,
        successCount: interval.successCount,
        trialCount: interval.trialCount,
        samplingAssumption: "supported",
        order: compared.order,
      });
    }
    throw new TypeError("Contradictory aggregate predicate projection");
  }

  if (input.kind !== "comparison") throw new TypeError("Expected owning comparison projection");
  const binding = input.binding;
  if (binding.status === "comparison_unusable") {
    if (binding.reason === "lineage_invalid") return unresolved("comparison_lineage_invalid");
    if (binding.reason === "records_unavailable") return unresolved("source_unavailable");
    const selection = input.selection;
    return unresolved(
      selection.status === "ambiguous"
        ? "comparison_ambiguous"
        : selection.status === "missing"
          ? "comparison_missing"
          : "comparison_unresolved",
    );
  }
  if (binding.status === "metric_missing") return unresolved("metric_missing");
  const metric = binding.metric;
  const samples = metric.result.samples;
  if (predicate.kind === "coverage_floor") {
    if (predicate.sourceKind === "comparison_metric_samples") {
      const population = populations[predicate.sampleClass];
      const observedCount = samples[population];
      const compared = comparePolicyCounts(
        observedCount,
        predicate.minimumCount,
        "greater_than_or_equal",
      );
      return result(compared.matches ? "satisfied" : "violated", {
        kind: "count_floor",
        population,
        observedCount,
        minimumCount: predicate.minimumCount,
        order: compared.order,
      });
    }
    if (predicate.sourceKind !== "comparison_metric_ratio")
      throw new TypeError("Expected comparison coverage projection");
    const numeratorPopulation = populations[predicate.numerator];
    const denominatorPopulation = populations[predicate.denominator];
    const numerator = samples[numeratorPopulation],
      denominator = samples[denominatorPopulation];
    const compared = comparePolicyCoverageRatio(
      numerator,
      denominator,
      predicate.minimumBasisPoints,
    );
    if (compared.status === "undefined") return unresolved(compared.reason);
    return result(compared.comparison.matches ? "satisfied" : "violated", {
      kind: "ratio_floor",
      numeratorPopulation,
      denominatorPopulation,
      numerator,
      denominator,
      minimumBasisPoints: predicate.minimumBasisPoints,
      order: compared.comparison.order,
    });
  }
  if (predicate.kind === "comparison_threshold") {
    if (metric.definition.kind !== predicate.metricKind || metric.result.unit !== predicate.unit)
      return unresolved("metric_type_mismatch");
    if (metric.provenance.comparability.status !== "comparable")
      return unresolved("evidence_incomparable");
    if (metric.result.value.status !== "available") return unresolved("metric_value_unavailable");
    const value = metric.result.value[predicate.operand];
    const compared = comparePolicyExactThreshold(
      value,
      predicate.threshold,
      predicate.unit,
      predicate.comparator,
    );
    return result(compared.matches ? "satisfied" : "violated", {
      kind: "exact_threshold",
      operand: predicate.operand,
      value,
      threshold: predicate.threshold,
      unit: predicate.unit,
      comparator: predicate.comparator,
      order: compared.order,
    });
  }
  if (predicate.kind === "safety_event_ceiling") {
    if (
      metric.definition.kind !== "safety_event_count" ||
      metric.definition.eventKind !== predicate.eventClass ||
      metric.result.unit !== "events"
    )
      return unresolved("metric_type_mismatch");
    if (metric.result.value.status !== "available") return unresolved("metric_value_unavailable");
    const value = metric.result.value.candidate;
    if (value.representation === "rational" && value.denominator !== "1")
      return unresolved("metric_type_mismatch");
    const observedCount = Number(
      value.representation === "decimal" ? value.value : value.numerator,
    );
    if (
      !Number.isSafeInteger(observedCount) ||
      observedCount < 0 ||
      compareComparisonExactValues(value, {
        representation: "decimal",
        unit: "events",
        value: String(observedCount),
      }) !== 0
    )
      return unresolved("metric_type_mismatch");
    const compared = comparePolicyCounts(
      observedCount,
      predicate.maximumCount,
      "less_than_or_equal",
    );
    const candidatePopulationComplete =
      samples.candidateTotalCount > 0 &&
      samples.candidateObservedCount === samples.candidateTotalCount &&
      samples.pairedObservedCount === samples.candidateTotalCount;
    if (compared.matches && !candidatePopulationComplete)
      return result("indeterminate", { kind: "not_evaluated", reason: "evidence_unqualified" }, [
        "historical_observation_only",
        "incomplete_candidate_population",
      ]);
    return result(
      compared.matches ? "satisfied" : "violated",
      {
        kind: "safety_ceiling",
        eventClass: predicate.eventClass,
        observedCount,
        maximumCount: predicate.maximumCount,
        candidatePopulationComplete,
        order: compared.order,
      },
      candidatePopulationComplete
        ? ["historical_observation_only"]
        : ["historical_observation_only", "incomplete_candidate_population"],
    );
  }
  throw new TypeError("Unsupported owning predicate projection");
}
