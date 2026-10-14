import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PolicyEvaluationSnapshotRuleInputsSchema,
  type ReleasePolicyComparator,
  type PolicyEvaluationRuleProjection,
  type PolicyEvaluationSourceReference,
} from "@proofstack/contracts";
import { evaluatePolicyPredicateProjection as evaluate } from "./evaluate-policy-predicate-projection.js";

const sha = "1".repeat(64);
const numericOracle = JSON.parse(
  readFileSync(
    new URL("./fixtures/policy-predicate-numeric-oracle-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: {
    name: string;
    numerator: string;
    denominator: string;
    threshold: string;
    comparator: ReleasePolicyComparator;
    order: -1 | 0 | 1;
    outcome: "satisfied" | "violated";
  }[];
};
function vector(name: string, kind?: string) {
  const document = JSON.parse(
    readFileSync(new URL(`../../../contracts/vectors/${name}.json`, import.meta.url), "utf8"),
  ) as {
    vectors: { kind?: string; input: Record<string, unknown> }[];
  };
  const selected = kind ? document.vectors.find((v) => v.kind === kind) : document.vectors[0];
  if (!selected) throw new Error("Missing independent fixture vector");
  return structuredClone(selected.input);
}
const frames = PolicyEvaluationSnapshotRuleInputsSchema.parse(
  vector("policy-evaluation-snapshot-rules-v1"),
).rules;
function frame(index: number) {
  const value = frames[index];
  if (!value) throw new Error("Missing original rule");
  return structuredClone(value);
}
const witness = (source: PolicyEvaluationSourceReference) => ({ source, recordSha256: sha });
function comparison(index = 2): PolicyEvaluationRuleProjection {
  const value = frame(index),
    predicate = value.rule.predicate;
  if (!("comparison" in predicate)) throw new Error("Expected comparison fixture");
  const original = vector("evaluation-comparison-definition-v1")["definition"] as {
    calculationPolicy: unknown;
    strata: unknown[];
  };
  const result = vector("evaluation-comparison-result-definition-v1")["definition"] as Record<
    string,
    unknown
  >;
  const candidate = {
    kind: "comparison",
    selection: {
      status: "unique",
      comparison: predicate.comparison,
      result: { resultId: result["resultId"], definitionSha256: sha },
    },
    binding: {
      status: "metric_bound",
      metric: {
        definitionIndex: 0,
        resultIndex: 0,
        stratumIndex: 0,
        definition: {
          kind: index === 5 ? "safety_event_count" : "trace_event_count",
          eventKind: index === 5 ? "uncertain_side_effect" : "tool.execute",
          unit: "events",
          metricId: predicate.metricId,
          label: "Independent fixture count",
          stratumId: (original.strata[0] as { stratumId: string }).stratumId,
        },
        result: {
          kind: index === 5 ? "safety_event_count" : "trace_event_count",
          metricId: predicate.metricId,
          unit: "events",
          samples: (result["metricResults"] as { samples: unknown }[])[0]?.samples,
          value: {
            status: "available",
            baseline: { representation: "decimal", unit: "events", value: "0" },
            candidate: { representation: "decimal", unit: "events", value: "0" },
            delta: { representation: "decimal", unit: "events", value: "0" },
            direction: "unchanged",
          },
        },
        stratum: original.strata[0],
        provenance: {
          calculationPolicy: original.calculationPolicy,
          comparability: result["comparability"],
          pairing: result["pairing"],
          latestSourceCutoff: result["latestSourceCutoff"],
        },
        witnesses: {
          comparison: witness({ kind: "comparison_definition", reference: predicate.comparison }),
          result: witness({
            kind: "comparison_result",
            reference: { resultId: result["resultId"] as string, definitionSha256: sha },
          }),
          baselineSnapshot: witness({
            kind: "comparison_snapshot",
            reference: result["baselineSnapshot"] as Extract<
              PolicyEvaluationSourceReference,
              { kind: "comparison_snapshot" }
            >["reference"],
          }),
          candidateSnapshot: witness({
            kind: "comparison_snapshot",
            reference: result["candidateSnapshot"] as Extract<
              PolicyEvaluationSourceReference,
              { kind: "comparison_snapshot" }
            >["reference"],
          }),
        },
      },
    },
  };
  return { ...value, input: candidate as unknown as PolicyEvaluationRuleProjection["input"] };
}
function assessment(index = 6) {
  const value = frame(index),
    predicate = value.rule.predicate;
  if (!("assessment" in predicate)) throw new Error("Expected assessment fixture");
  const aggregate = vector("evaluation-assessment-definition-v1", "evaluation_aggregate")[
    "definition"
  ] as Record<string, unknown>;
  const policy = vector("evaluation-assessment-definition-v1", "aggregation_policy")[
    "definition"
  ] as Record<string, unknown>;
  if (!("assessmentId" in predicate.assessment))
    throw new Error("Expected evaluation assessment fixture");
  const source: PolicyEvaluationSourceReference = {
    kind: "assessment",
    reference: predicate.assessment,
  };
  value.input = {
    kind: "assessment",
    source,
    binding: {
      status: "inputs_retained",
      assessment: witness(source),
      operand: {
        kind: "uncertainty_interval",
        field: "lowerBound",
        aggregate: {
          status: "verified",
          witness: witness({
            kind: "evaluation_aggregate",
            reference: { aggregateId: aggregate["aggregateId"] as string, definitionSha256: sha },
          }),
          projection: {
            counts: aggregate["counts"],
            samplingAssumption: aggregate["samplingAssumption"],
            passInterval: aggregate["passInterval"],
          },
        },
        aggregationPolicy: {
          status: "verified",
          witness: witness({
            kind: "aggregation_policy",
            reference: {
              policyId: policy["policyId"] as string,
              policyVersionId: policy["policyVersionId"] as string,
              definitionSha256: sha,
            },
          }),
          projection: { method: policy["method"] },
        },
      },
    },
  } as unknown as PolicyEvaluationRuleProjection["input"];
  return value;
}
function boundComparison(value: PolicyEvaluationRuleProjection) {
  if (value.input.kind !== "comparison" || value.input.binding.status !== "metric_bound")
    throw new Error("Expected bound comparison");
  return value.input.binding.metric;
}

describe("pure predicate projection, without source or publication authority", () => {
  it.each(numericOracle.vectors)("matches independent Fraction oracle $name", (oracle) => {
    const value = comparison(),
      metric = boundComparison(value);
    if (value.rule.predicate.kind !== "comparison_threshold") throw new Error("Expected threshold");
    value.rule.predicate.metricKind = "replay_usage";
    value.rule.predicate.unit = "milliseconds";
    value.rule.predicate.threshold = oracle.threshold;
    value.rule.predicate.comparator = oracle.comparator;
    metric.definition = {
      kind: "replay_usage",
      aggregation: { method: "mean", methodVersion: "1.0.0" },
      dimension: "elapsedMilliseconds",
      unit: "milliseconds",
      metricId: value.rule.predicate.metricId,
      label: "Synthetic exact numeric oracle",
      stratumId: metric.stratum.stratumId,
    };
    metric.result.kind = "replay_usage";
    metric.result.unit = "milliseconds";
    metric.result.usageProvenance = {
      baseline: {
        completeCount: 1,
        partialCount: 0,
        unavailableCount: 0,
        observedSources: ["measured"],
        unavailableReasons: [],
      },
      candidate: {
        completeCount: 1,
        partialCount: 0,
        unavailableCount: 0,
        observedSources: ["measured"],
        unavailableReasons: [],
      },
    };
    const exact = {
      representation: "rational" as const,
      unit: "milliseconds",
      numerator: oracle.numerator,
      denominator: oracle.denominator,
    };
    metric.result.value = {
      status: "available",
      direction: oracle.numerator.startsWith("-") ? "decreased" : "increased",
      baseline: {
        representation: "rational",
        unit: "milliseconds",
        numerator: "0",
        denominator: "1",
      },
      candidate: exact,
      delta: exact,
    };
    expect(evaluate(value)).toMatchObject({
      outcome: oracle.outcome,
      evidence: { kind: "exact_threshold", order: oracle.order, value: exact },
    });
  });
  it.each([0, 1, 2, 3, 4, 5, 6])(
    "preserves original rule identity and explicit unresolved input %s",
    (index) => {
      const value = frame(index),
        copy = structuredClone(value);
      const result = evaluate(value);
      expect(value).toEqual(copy);
      expect(result.ruleIndex).toBe(index);
      expect(result.ruleId).toBe(value.rule.ruleId);
      expect(result.predicateKind).toBe(value.rule.predicate.kind);
      expect(result.outcome).toBe(index === 1 ? "violated" : "indeterminate");
    },
  );
  it("always retains the approval prerequisite", () => {
    expect(evaluate(frame(0))).toMatchObject({
      outcome: "indeterminate",
      evidence: { reason: "approval_not_evaluated" },
      limitations: ["approval_not_evaluated", "historical_observation_only"],
    });
  });
  it("compares an exact threshold and preserves complete compact operands", () => {
    expect(evaluate(comparison())).toMatchObject({
      outcome: "satisfied",
      evidence: { kind: "exact_threshold", operand: "candidate", threshold: "0", order: 0 },
    });
  });
  it.each([
    ["equal", "satisfied"],
    ["not_equal", "violated"],
    ["greater_than", "violated"],
    ["greater_than_or_equal", "satisfied"],
    ["less_than", "violated"],
    ["less_than_or_equal", "satisfied"],
  ] as const)("retains exact equality behavior for comparator %s", (comparator, outcome) => {
    const value = comparison();
    if (value.rule.predicate.kind !== "comparison_threshold") throw new Error("Expected threshold");
    value.rule.predicate.comparator = comparator;
    expect(evaluate(value)).toMatchObject({ outcome, evidence: { order: 0, comparator } });
  });
  it("compares a signed delta instead of substituting a candidate value", () => {
    const value = comparison(),
      metric = boundComparison(value);
    if (value.rule.predicate.kind !== "comparison_threshold") throw new Error("Expected threshold");
    value.rule.predicate.operand = "delta";
    value.rule.predicate.threshold = "-3";
    metric.result.value = {
      status: "available",
      direction: "decreased",
      baseline: { representation: "decimal", unit: "events", value: "5" },
      candidate: { representation: "decimal", unit: "events", value: "2" },
      delta: { representation: "decimal", unit: "events", value: "-3" },
    };
    expect(evaluate(value)).toMatchObject({
      outcome: "satisfied",
      evidence: { operand: "delta", order: 0, value: { value: "-3" } },
    });
  });
  it.each(["records_unavailable", "lineage_invalid"] as const)(
    "does not invent a metric for %s",
    (reason) => {
      const value = comparison();
      if (value.input.kind !== "comparison") throw new Error("Expected comparison");
      value.input.binding = { status: "comparison_unusable", reason };
      expect(evaluate(value)).toMatchObject({
        outcome: "indeterminate",
        evidence: {
          reason:
            reason === "lineage_invalid" ? "comparison_lineage_invalid" : "source_unavailable",
        },
      });
    },
  );
  it("keeps an incomparable numeric value indeterminate", () => {
    const value = comparison(),
      metric = boundComparison(value);
    metric.provenance.comparability = {
      status: "incomparable",
      reasons: ["missing_source_evidence"],
    };
    expect(evaluate(value)).toMatchObject({
      outcome: "indeterminate",
      evidence: { reason: "evidence_incomparable" },
    });
  });
  it("does not turn unavailable numbers into zero", () => {
    const value = comparison(),
      metric = boundComparison(value);
    metric.result.value = { status: "unavailable", reasons: ["measurement_unavailable"] };
    expect(evaluate(value)).toMatchObject({
      outcome: "indeterminate",
      evidence: { reason: "metric_value_unavailable" },
    });
  });
  it("retains paired same-population coverage", () => {
    expect(evaluate(comparison(3))).toMatchObject({
      outcome: "satisfied",
      evidence: {
        kind: "ratio_floor",
        numeratorPopulation: "pairedObservedCount",
        denominatorPopulation: "pairedTotalCount",
        numerator: 1,
        denominator: 1,
        minimumBasisPoints: 9500,
      },
    });
  });
  it.each(["decided", "observed"] as const)(
    "preserves the declared assessment %s population",
    (sampleClass) => {
      const value = assessment(),
        predicate = value.rule.predicate;
      if (
        predicate.kind !== "uncertainty_bound" ||
        value.input.kind !== "assessment" ||
        value.input.binding.status !== "inputs_retained" ||
        value.input.binding.operand.kind !== "uncertainty_interval"
      )
        throw new Error("Expected aggregate fixture");
      const original = value.input.binding.operand;
      value.rule.predicate = {
        kind: "coverage_floor",
        sourceKind: "assessment_samples",
        sampleClass,
        minimumCount: 3,
        unit: "cases",
        assessment: predicate.assessment,
      };
      value.input.binding.operand = {
        kind: "coverage_count",
        field: sampleClass === "decided" ? "decidedCount" : "attemptedCount",
        aggregate: original.aggregate,
        aggregationPolicy: original.aggregationPolicy,
      };
      expect(evaluate(value)).toMatchObject({
        outcome: "violated",
        evidence: {
          kind: "count_floor",
          population: sampleClass === "decided" ? "decidedCount" : "attemptedCount",
          observedCount: 2,
          minimumCount: 3,
        },
      });
    },
  );
  it.each([
    [0, "satisfied"],
    [1, "satisfied"],
    [2, "violated"],
  ] as const)("checks a paired observed count floor %s", (minimumCount, outcome) => {
    const value = comparison(3),
      predicate = value.rule.predicate;
    if (predicate.kind !== "coverage_floor" || !("comparison" in predicate))
      throw new Error("Expected comparison coverage");
    value.rule.predicate = {
      kind: "coverage_floor",
      sourceKind: "comparison_metric_samples",
      comparison: predicate.comparison,
      metricId: predicate.metricId,
      sampleClass: "paired_observed",
      minimumCount,
      unit: "cases",
    };
    expect(evaluate(value)).toMatchObject({
      outcome,
      evidence: {
        kind: "count_floor",
        observedCount: 1,
        minimumCount,
        population: "pairedObservedCount",
      },
    });
  });
  it("does not turn zero population into complete coverage", () => {
    const value = comparison(3),
      metric = boundComparison(value);
    for (const key of Object.keys(metric.result.samples) as (keyof typeof metric.result.samples)[])
      metric.result.samples[key] = 0;
    metric.result.value = { status: "unavailable", reasons: ["insufficient_observations"] };
    expect(evaluate(value)).toMatchObject({
      outcome: "indeterminate",
      evidence: { reason: "zero_denominator" },
    });
  });
  it("requires complete candidate observations to satisfy a safety ceiling", () => {
    const value = comparison(5),
      metric = boundComparison(value);
    metric.result.samples.candidateTotalCount = 2;
    metric.result.samples.candidateMissingCount = 1;
    expect(evaluate(value)).toMatchObject({
      outcome: "indeterminate",
      evidence: { reason: "evidence_unqualified" },
      limitations: ["historical_observation_only", "incomplete_candidate_population"],
    });
  });
  it("accepts a complete observed zero without confusing it with missingness", () => {
    expect(evaluate(comparison(5))).toMatchObject({
      outcome: "satisfied",
      evidence: {
        kind: "safety_ceiling",
        observedCount: 0,
        maximumCount: 0,
        candidatePopulationComplete: true,
      },
    });
  });
  it("violates a safety ceiling on a known excess even when candidate observation is incomplete", () => {
    const value = comparison(5),
      metric = boundComparison(value);
    metric.result.value = {
      status: "available",
      direction: "increased",
      baseline: { representation: "decimal", unit: "events", value: "0" },
      candidate: { representation: "decimal", unit: "events", value: "1" },
      delta: { representation: "decimal", unit: "events", value: "1" },
    };
    metric.result.samples.candidateTotalCount = 2;
    metric.result.samples.candidateMissingCount = 1;
    expect(evaluate(value)).toMatchObject({
      outcome: "violated",
      evidence: { observedCount: 1, maximumCount: 0, candidatePopulationComplete: false },
    });
  });
  it.each(["-1", "0.5", "9007199254740992", "1.000000000000000001"])(
    "never rounds an invalid safety count %s",
    (candidate) => {
      const value = comparison(5),
        metric = boundComparison(value);
      metric.result.value = {
        status: "available",
        direction: candidate.startsWith("-") ? "decreased" : "increased",
        baseline: { representation: "decimal", unit: "events", value: "0" },
        candidate: { representation: "decimal", unit: "events", value: candidate },
        delta: { representation: "decimal", unit: "events", value: candidate },
      };
      expect(evaluate(value)).toMatchObject({
        outcome: "indeterminate",
        evidence: { reason: "metric_type_mismatch" },
      });
    },
  );
  it.each(["eligible", "ineligible"] as const)(
    "retains a verified assessment eligibility %s",
    (status) => {
      const value = frame(4),
        predicate = value.rule.predicate;
      if (predicate.kind !== "eligibility_required" || predicate.assessmentClass !== "evaluation")
        throw new Error("Expected evaluation eligibility");
      const original = vector("evaluation-assessment-definition-v1", "assessment")[
        "definition"
      ] as Record<string, unknown>;
      const source: PolicyEvaluationSourceReference = {
        kind: "assessment",
        reference: predicate.assessment,
      };
      value.input = {
        kind: "assessment",
        source,
        binding: {
          status: "inputs_retained",
          assessment: witness(source),
          operand: {
            kind: "evaluation_eligibility",
            eligibility:
              status === "eligible" ? { status } : { status, reasons: ["criterion_not_approved"] },
            dimensions: original["dimensions"],
          },
        },
      } as unknown as PolicyEvaluationRuleProjection["input"];
      expect(evaluate(value)).toMatchObject({
        outcome: status === "eligible" ? "satisfied" : "violated",
        evidence: { kind: "eligibility", assessmentClass: "evaluation", eligibility: status },
      });
    },
  );
  it.each([
    ["application/vnd.proofstack.agent+tar", "internal", "verified", "satisfied", "verified"],
    ["application/json", "internal", "verified", "violated", "media_type_disallowed"],
    [
      "application/vnd.proofstack.agent+tar",
      "restricted",
      "verified",
      "violated",
      "classification_disallowed",
    ],
    ["application/vnd.proofstack.agent+tar", "internal", "missing", "violated", "artifact_missing"],
  ] as const)(
    "retains artifact content/type/classification %s/%s/%s",
    (mediaType, classification, status, outcome, expectedStatus) => {
      const value = frame(1);
      value.input = {
        kind: "artifact",
        binding: {
          status: "artifact_declared",
          reference: {
            artifactId: "artifact_predicate",
            classification,
            mediaType,
            sizeBytes: 16,
            sha256: sha,
          },
          catalog: status === "missing" ? null : { recordSha256: sha, ownership: null },
          observation: status === "verified" ? { status, sha256: sha, sizeBytes: 16 } : { status },
        },
      };
      expect(evaluate(value)).toMatchObject({
        outcome,
        evidence: { kind: "artifact", status: expectedStatus },
      });
    },
  );
  it("keeps unreadable existing artifact bytes indeterminate", () => {
    const value = frame(1);
    value.input = {
      kind: "artifact",
      binding: {
        status: "artifact_declared",
        reference: {
          artifactId: "artifact_predicate",
          classification: "internal",
          mediaType: "application/vnd.proofstack.agent+tar",
          sizeBytes: 16,
          sha256: sha,
        },
        catalog: { recordSha256: sha, ownership: null },
        observation: { status: "unavailable", reason: "object_missing" },
      },
    };
    expect(evaluate(value)).toMatchObject({
      outcome: "indeterminate",
      evidence: { reason: "artifact_content_unavailable" },
    });
  });
  it("does not treat an alias-only model component as a resolved artifact", () => {
    const value = frame(1);
    if (value.rule.predicate.kind !== "artifact_required")
      throw new Error("Expected artifact rule");
    value.rule.predicate.componentKind = "model_resolution";
    value.input = { kind: "artifact", binding: { status: "model_alias" } };
    expect(evaluate(value)).toMatchObject({
      outcome: "indeterminate",
      evidence: { reason: "model_resolution_missing" },
    });
  });
  it.each(["eligible", "ineligible"] as const)(
    "retains model assurance eligibility %s and its declared class",
    (eligibility) => {
      const value = frame(4);
      const model = vector("evaluation-model-assurance-assessment-definition-v1")[
        "definition"
      ] as Record<string, unknown>;
      const reference = {
        assessmentExtensionId: model["assessmentExtensionId"] as string,
        definitionSha256: sha,
      };
      value.rule.predicate = {
        kind: "eligibility_required",
        assessmentClass: "model_assurance",
        assessment: reference,
        expected: "eligible",
      };
      const source: PolicyEvaluationSourceReference = {
        kind: "model_assurance_assessment",
        reference,
      };
      value.input = {
        kind: "assessment",
        source,
        binding: {
          status: "inputs_retained",
          assessment: witness(source),
          operand: {
            kind: "model_eligibility",
            eligibility,
            reasons: eligibility === "eligible" ? [] : ["base_assessment_ineligible"],
            baseAssessment: model["baseAssessment"],
          },
        },
      } as unknown as PolicyEvaluationRuleProjection["input"];
      expect(evaluate(value)).toMatchObject({
        outcome: eligibility === "eligible" ? "satisfied" : "violated",
        evidence: { assessmentClass: "model_assurance", eligibility },
      });
    },
  );
  it("preserves exact reported Wilson interval operands and its statistical assumptions", () => {
    expect(evaluate(assessment())).toMatchObject({
      outcome: "violated",
      evidence: {
        kind: "uncertainty_bound",
        bound: "lower",
        value: "0.0945286548008661",
        thresholdBasisPoints: 9000,
        successCount: 1,
        trialCount: 2,
        samplingAssumption: "supported",
      },
    });
  });
  it("does not silently substitute a different interval confidence", () => {
    const value = assessment();
    if (value.rule.predicate.kind !== "uncertainty_bound")
      throw new Error("Expected interval rule");
    value.rule.predicate.confidenceLevelBasisPoints = 9000;
    expect(evaluate(value)).toMatchObject({
      outcome: "indeterminate",
      evidence: { reason: "interval_confidence_mismatch" },
    });
  });
  it("does not turn an unsupported sampling assumption into statistical evidence", () => {
    const value = assessment();
    if (
      value.input.kind !== "assessment" ||
      value.input.binding.status !== "inputs_retained" ||
      value.input.binding.operand.kind !== "uncertainty_interval" ||
      value.input.binding.operand.aggregate.status !== "verified"
    )
      throw new Error("Expected interval operand");
    const aggregate = value.input.binding.operand.aggregate.projection;
    aggregate.samplingAssumption = {
      status: "unsupported",
      limitations: ["Synthetic unsupported sampling assumption"],
    };
    aggregate.passInterval = { status: "not_reported", reason: "unsupported_assumption" };
    expect(evaluate(value)).toMatchObject({
      outcome: "indeterminate",
      evidence: { reason: "sampling_assumption_unsupported" },
    });
  });
  it("preserves unknown interval availability rather than fabricating a bound", () => {
    const value = assessment();
    if (
      value.input.kind !== "assessment" ||
      value.input.binding.status !== "inputs_retained" ||
      value.input.binding.operand.kind !== "uncertainty_interval" ||
      value.input.binding.operand.aggregate.status !== "verified"
    )
      throw new Error("Expected interval operand");
    value.input.binding.operand.aggregate.projection.passInterval = {
      status: "not_reported",
      reason: "method_not_requested",
    };
    expect(evaluate(value)).toMatchObject({
      outcome: "indeterminate",
      evidence: { reason: "interval_unavailable" },
    });
  });
  it("rejects unknown fields before any predicate computation", () => {
    expect(() => evaluate({ ...comparison(), callerOutcome: "satisfied" })).toThrow();
  });
});
