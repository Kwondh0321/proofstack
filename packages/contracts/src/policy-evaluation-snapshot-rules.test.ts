import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import {
  AssessmentDefinitionSchema,
  EvaluationAggregateDefinitionSchema,
  EvaluationAggregationPolicyDefinitionSchema,
} from "./evaluation-assessment.js";
import { ComparisonDefinitionSchema } from "./evaluation-comparison.js";
import { ComparisonResultDefinitionSchema } from "./evaluation-comparison-result.js";
import { ModelAssuranceAssessmentDefinitionSchema } from "./evaluation-model-assessment.js";
import { encodePolicyEvaluationSnapshotRuleInputs } from "./policy-evaluation-snapshot-rules-encoding.js";
import {
  PolicyEvaluationRuleProjectionSchema,
  PolicyEvaluationSnapshotRuleInputsSchema,
  type PolicyEvaluationSnapshotRuleInputs,
} from "./policy-evaluation-snapshot-rules.js";
import type { PolicyEvaluationSourceReference } from "./policy-evaluation-source-reference.js";

const sha = "a".repeat(64);
function required<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("Missing original fixture member");
  return value;
}
function vector(name: string, kind?: string) {
  const document = JSON.parse(
    readFileSync(new URL(`../vectors/${name}.json`, import.meta.url), "utf8"),
  ) as {
    vectors: {
      kind?: string;
      input: { definition?: unknown };
      encodedByteLength: number;
      sha256: string;
    }[];
  };
  const selected = kind ? document.vectors.find((item) => item.kind === kind) : document.vectors[0];
  if (!selected) throw new Error("Missing independent vector");
  return structuredClone(selected);
}
const canonical = vector("policy-evaluation-snapshot-rules-v1");
function input(): PolicyEvaluationSnapshotRuleInputs {
  return PolicyEvaluationSnapshotRuleInputsSchema.parse(structuredClone(canonical.input));
}
function witness(source: PolicyEvaluationSourceReference) {
  return { source, recordSha256: sha };
}
function readyComparison(value = input()) {
  const frame = required(value.rules, 2);
  const predicate = frame.rule.predicate;
  if (predicate.kind !== "comparison_threshold") throw new Error("Missing comparison rule");
  const definition = ComparisonDefinitionSchema.parse(
    vector("evaluation-comparison-definition-v1").input.definition,
  );
  const result = ComparisonResultDefinitionSchema.parse(
    vector("evaluation-comparison-result-definition-v1").input.definition,
  );
  const metric = required(result.metricResults, 0);
  const exact = { representation: "decimal" as const, unit: "events", value: "0" };
  frame.input = {
    kind: "comparison",
    selection: {
      status: "unique",
      comparison: predicate.comparison,
      result: { resultId: result.resultId, definitionSha256: sha },
    },
    binding: {
      status: "metric_bound",
      metric: {
        definitionIndex: 0,
        resultIndex: 0,
        stratumIndex: 0,
        definition: {
          kind: "trace_event_count",
          eventKind: "tool.execute",
          unit: "events",
          metricId: predicate.metricId,
          label: "Exact trace events",
          stratumId: required(definition.strata, 0).stratumId,
        },
        result: {
          kind: "trace_event_count",
          metricId: predicate.metricId,
          unit: "events",
          samples: metric.samples,
          value: {
            status: "available",
            baseline: exact,
            candidate: exact,
            delta: exact,
            direction: "unchanged",
          },
        },
        stratum: required(definition.strata, 0),
        provenance: {
          calculationPolicy: definition.calculationPolicy,
          comparability: result.comparability,
          pairing: result.pairing,
          latestSourceCutoff: result.latestSourceCutoff,
        },
        witnesses: {
          comparison: witness({ kind: "comparison_definition", reference: predicate.comparison }),
          result: witness({
            kind: "comparison_result",
            reference: { resultId: result.resultId, definitionSha256: sha },
          }),
          baselineSnapshot: witness({
            kind: "comparison_snapshot",
            reference: result.baselineSnapshot,
          }),
          candidateSnapshot: witness({
            kind: "comparison_snapshot",
            reference: result.candidateSnapshot,
          }),
        },
      },
    },
  };
  return PolicyEvaluationSnapshotRuleInputsSchema.parse(value);
}
function readyAssessment(value = input()) {
  const frame = required(value.rules, 6);
  const predicate = frame.rule.predicate;
  if (predicate.kind !== "uncertainty_bound") throw new Error("Missing interval rule");
  const aggregate = EvaluationAggregateDefinitionSchema.parse(
    vector("evaluation-assessment-definition-v1", "evaluation_aggregate").input.definition,
  );
  const policy = EvaluationAggregationPolicyDefinitionSchema.parse(
    vector("evaluation-assessment-definition-v1", "aggregation_policy").input.definition,
  );
  const source = { kind: "assessment" as const, reference: predicate.assessment };
  frame.input = {
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
            reference: { aggregateId: aggregate.aggregateId, definitionSha256: sha },
          }),
          projection: {
            counts: aggregate.counts,
            samplingAssumption: aggregate.samplingAssumption,
            passInterval: aggregate.passInterval,
          },
        },
        aggregationPolicy: {
          status: "verified",
          witness: witness({
            kind: "aggregation_policy",
            reference: {
              policyId: policy.policyId,
              policyVersionId: policy.policyVersionId,
              definitionSha256: sha,
            },
          }),
          projection: { method: policy.method },
        },
      },
    },
  };
  return PolicyEvaluationSnapshotRuleInputsSchema.parse(value);
}
function readyArtifact(value = input()) {
  const frame = required(value.rules, 1);
  const reference = ArtifactContentReferenceSchema.parse({
    artifactId: "artifact_rules",
    classification: "internal",
    mediaType: "application/vnd.proofstack.agent+tar",
    sizeBytes: 16,
    sha256: sha,
  });
  frame.input = {
    kind: "artifact",
    binding: {
      status: "artifact_declared",
      reference,
      catalog: { recordSha256: sha, ownership: null },
      observation: { status: "verified", sha256: sha, sizeBytes: 16 },
    },
  };
  return PolicyEvaluationSnapshotRuleInputsSchema.parse(value);
}

describe("strict ordered snapshot rule inputs", () => {
  it("retains all seven original predicates and unresolved approval without fabricating inputs", () => {
    const value = input();
    expect(value.rules.map(({ rule }) => rule.predicate.kind)).toEqual([
      "approval_required",
      "artifact_required",
      "comparison_threshold",
      "coverage_floor",
      "eligibility_required",
      "safety_event_ceiling",
      "uncertainty_bound",
    ]);
    expect(required(value.rules, 0).input).toEqual({
      kind: "approval",
      status: "not_evaluated",
      reason: "approval_not_evaluated",
    });
    expect(value).not.toHaveProperty("sealed");
  });

  it("validates bounded original metric, aggregate and artifact metadata without copying source bodies", () => {
    const value = readyArtifact(readyAssessment(readyComparison()));
    expect(PolicyEvaluationSnapshotRuleInputsSchema.parse(value)).toEqual(value);
    const text = JSON.stringify(value);
    for (const field of [
      "members",
      "runs",
      "observations",
      "objectKey",
      "wrappedDataKey",
      "plaintext",
    ])
      expect(text).not.toContain(`"${field}"`);
  });

  it.each([
    "order",
    "index",
    "duplicate",
    "family",
    "candidate",
    "policy",
    "approval",
    "empty",
    "extra",
    "omitted",
  ] as const)("rejects original rule/root substitution: %s", (fault) => {
    const value = input();
    if (fault === "order") value.rules.reverse();
    else if (fault === "index") required(value.rules, 0).ruleIndex = 1;
    else if (fault === "duplicate")
      required(value.rules, 1).rule.ruleId = required(value.rules, 0).rule.ruleId;
    else if (fault === "family") required(value.rules, 2).input = required(value.rules, 0).input;
    else if (fault === "candidate") value.candidate = value.policy;
    else if (fault === "policy") value.policy = value.candidate;
    else if (fault === "approval")
      Reflect.set(required(value.rules, 0).input, "status", "approved");
    else if (fault === "empty") value.rules = [];
    else if (fault === "omitted") value.rules.pop();
    else Reflect.set(value, "workerId", "caller_worker");
    expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    "selection",
    "not_unique",
    "metric",
    "kind",
    "unit",
    "stratum",
    "definition",
    "result",
    "baseline",
    "candidate",
  ] as const)("rejects bound comparison substitution: %s", (fault) => {
    const value = readyComparison();
    const frame = required(value.rules, 2);
    if (frame.input.kind !== "comparison" || frame.input.binding.status !== "metric_bound")
      throw new Error("Missing bound metric");
    const { metric } = frame.input.binding;
    if (fault === "selection") frame.input.selection.comparison.definitionSha256 = "b".repeat(64);
    else if (fault === "not_unique")
      frame.input.selection = { status: "missing", comparison: frame.input.selection.comparison };
    else if (fault === "metric") metric.result.metricId = "other_metric";
    else if (fault === "kind") metric.result.kind = "coverage_count";
    else if (fault === "unit") Reflect.set(metric.definition, "unit", "cases");
    else if (fault === "stratum") metric.stratum.stratumId = "other_stratum";
    else if (fault === "definition")
      metric.witnesses.comparison.source = metric.witnesses.result.source;
    else if (fault === "result")
      metric.witnesses.result.source = metric.witnesses.comparison.source;
    else if (fault === "baseline")
      metric.witnesses.baselineSnapshot = metric.witnesses.candidateSnapshot;
    else metric.witnesses.candidateSnapshot = metric.witnesses.baselineSnapshot;
    expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(false);
  });

  it("retains a known missing metric only on a unique original comparison selection", () => {
    const value = readyComparison();
    const frame = required(value.rules, 2);
    if (frame.input.kind !== "comparison") throw new Error("Missing comparison input");
    frame.input.binding = { status: "metric_missing" };
    expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(true);
    frame.input.binding = { status: "comparison_unusable", reason: "selection_unresolved" };
    expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(false);
    frame.input.binding = { status: "comparison_unusable", reason: "records_unavailable" };
    expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(true);
  });

  it.each(["definitionIndex", "resultIndex", "stratumIndex", "cut"] as const)(
    "rejects out-of-range metric coordinate or future %s",
    (field) => {
      const value = readyComparison();
      const frame = required(value.rules, 2);
      if (frame.input.kind !== "comparison" || frame.input.binding.status !== "metric_bound")
        throw new Error("Missing bound metric");
      if (field === "cut")
        frame.input.binding.metric.provenance.latestSourceCutoff = "2026-10-04T00:00:00.000Z";
      else frame.input.binding.metric[field] = field === "stratumIndex" ? 64 : 128;
      expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each([
    "source",
    "witness",
    "operand",
    "field",
    "aggregate_kind",
    "policy_kind",
    "counts",
    "trials",
    "assumption",
  ] as const)("rejects substituted assessment operands: %s", (fault) => {
    const value = readyAssessment();
    const frame = required(value.rules, 6);
    if (
      frame.input.kind !== "assessment" ||
      frame.input.binding.status !== "inputs_retained" ||
      frame.input.binding.operand.kind !== "uncertainty_interval"
    )
      throw new Error("Missing interval input");
    const binding = frame.input.binding;
    const operand = binding.operand;
    if (
      operand.kind !== "uncertainty_interval" ||
      operand.aggregate.status !== "verified" ||
      operand.aggregationPolicy.status !== "verified"
    )
      throw new Error("Missing aggregate projection");
    if (fault === "source")
      Reflect.set(frame.input.source.reference, "definitionSha256", "b".repeat(64));
    else if (fault === "witness") binding.assessment.source = value.candidate.source;
    else if (fault === "operand") Reflect.set(operand, "kind", "coverage_count");
    else if (fault === "field") operand.field = "upperBound";
    else if (fault === "aggregate_kind")
      operand.aggregate.witness.source = operand.aggregationPolicy.witness.source;
    else if (fault === "policy_kind")
      operand.aggregationPolicy.witness.source = operand.aggregate.witness.source;
    else if (fault === "counts") operand.aggregate.projection.counts.attemptedCount++;
    else if (fault === "trials") {
      const interval = operand.aggregate.projection.passInterval;
      if (interval.status !== "reported") throw new Error("Missing reported interval");
      interval.interval.trialCount++;
    } else operand.aggregate.projection.samplingAssumption = { status: "not_required" };
    expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(false);
  });

  it.each(["aggregate", "aggregationPolicy"] as const)(
    "preserves unavailable %s without promoting future/missing evidence",
    (field) => {
      const value = readyAssessment();
      const frame = required(value.rules, 6);
      if (
        frame.input.kind !== "assessment" ||
        frame.input.binding.status !== "inputs_retained" ||
        frame.input.binding.operand.kind !== "uncertainty_interval"
      )
        throw new Error("Missing interval input");
      const operand = frame.input.binding.operand;
      const prior = operand[field];
      if (prior.status !== "verified") throw new Error("Missing retained projection");
      Reflect.set(operand, field, {
        status: "unavailable",
        source: prior.witness.source,
        observation: { status: "unavailable", reason: "not_yet_available" },
      });
      expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(true);
      Reflect.set(operand[field], "observation", { status: "verified", recordSha256: sha });
      expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each(["decided", "observed"] as const)(
    "retains all verdict counts for assessment %s coverage",
    (sampleClass) => {
      const value = readyAssessment();
      const frame = required(value.rules, 6);
      const original = frame.rule.predicate;
      if (
        original.kind !== "uncertainty_bound" ||
        frame.input.kind !== "assessment" ||
        frame.input.binding.status !== "inputs_retained" ||
        frame.input.binding.operand.kind !== "uncertainty_interval"
      )
        throw new Error("Missing interval input");
      frame.rule.predicate = {
        kind: "coverage_floor",
        sourceKind: "assessment_samples",
        assessment: original.assessment,
        sampleClass,
        minimumCount: 1,
        unit: "cases",
      };
      const { aggregate, aggregationPolicy } = frame.input.binding.operand;
      frame.input.binding.operand = {
        kind: "coverage_count",
        field: sampleClass === "decided" ? "decidedCount" : "attemptedCount",
        aggregate,
        aggregationPolicy,
      };
      expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(true);
      frame.input.binding.operand.field =
        sampleClass === "decided" ? "attemptedCount" : "decidedCount";
      expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each(["evaluation", "model_assurance"] as const)(
    "retains %s eligibility with its original dimensions or reasons",
    (assessmentClass) => {
      const value = input();
      const frame = required(value.rules, 4);
      const original = frame.rule.predicate;
      if (original.kind !== "eligibility_required") throw new Error("Missing eligibility rule");
      if (assessmentClass === "evaluation") {
        if (original.assessmentClass !== "evaluation")
          throw new Error("Missing original evaluation assessment");
        const assessment = AssessmentDefinitionSchema.parse(
          vector("evaluation-assessment-definition-v1", "assessment").input.definition,
        );
        const source = { kind: "assessment" as const, reference: original.assessment };
        frame.input = {
          kind: "assessment",
          source,
          binding: {
            status: "inputs_retained",
            assessment: witness(source),
            operand: {
              kind: "evaluation_eligibility",
              eligibility: assessment.eligibility,
              dimensions: assessment.dimensions,
            },
          },
        };
      } else {
        const assessment = ModelAssuranceAssessmentDefinitionSchema.parse(
          vector("evaluation-model-assurance-assessment-definition-v1").input.definition,
        );
        const reference = {
          assessmentExtensionId: assessment.assessmentExtensionId,
          definitionSha256: sha,
        };
        const source = { kind: "model_assurance_assessment" as const, reference };
        frame.rule.predicate = {
          kind: "eligibility_required",
          assessmentClass,
          assessment: reference,
          expected: "eligible",
        };
        frame.input = {
          kind: "assessment",
          source,
          binding: {
            status: "inputs_retained",
            assessment: witness(source),
            operand: {
              kind: "model_eligibility",
              eligibility: assessment.eligibility,
              reasons: assessment.reasons,
              baseAssessment: assessment.baseAssessment,
            },
          },
        };
      }
      expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(true);
      if (frame.input.kind !== "assessment" || frame.input.binding.status !== "inputs_retained")
        throw new Error("Missing eligibility input");
      if (frame.input.binding.operand.kind === "model_eligibility") {
        const originalEligibility = frame.input.binding.operand.eligibility;
        frame.input.binding.operand.eligibility =
          originalEligibility === "eligible" ? "ineligible" : "eligible";
        expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(false);
        frame.input.binding.operand.eligibility = originalEligibility;
      }
      Reflect.set(
        frame.input.binding.operand,
        "kind",
        assessmentClass === "evaluation" ? "model_eligibility" : "evaluation_eligibility",
      );
      expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each(["hash", "size", "catalog", "alias", "owner_scope", "owner_identity"] as const)(
    "rejects false artifact content/ownership: %s",
    (fault) => {
      const value = readyArtifact();
      const frame = required(value.rules, 1);
      if (frame.input.kind !== "artifact" || frame.input.binding.status !== "artifact_declared")
        throw new Error("Missing artifact input");
      const binding = frame.input.binding;
      if (fault === "alias") frame.input.binding = { status: "model_alias" };
      else if (fault === "catalog") binding.catalog = null;
      else if (fault === "hash") Reflect.set(binding.observation, "sha256", "b".repeat(64));
      else if (fault === "size") Reflect.set(binding.observation, "sizeBytes", 17);
      else {
        if (!binding.catalog) throw new Error("Missing catalog");
        binding.catalog.ownership = {
          schemaVersion: "0.1",
          scope: {
            ...value.scope,
            ...(fault === "owner_scope" ? { tenantId: "other_tenant" } : {}),
          },
          artifactId: fault === "owner_identity" ? "other_artifact" : binding.reference.artifactId,
          boundAt: "2026-10-03T00:00:00.000Z",
          boundByPrincipalId: "owner_principal",
          owner: {
            kind: "regression_fixture_version",
            fixtureId: "fixture_rules",
            fixtureVersionId: "fixture_rules_v1",
          },
        };
      }
      expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(false);
    },
  );

  it("retains missing, unreadable and alias-only model artifacts as distinct observations", () => {
    const value = readyArtifact();
    const frame = required(value.rules, 1);
    if (
      frame.input.kind !== "artifact" ||
      frame.input.binding.status !== "artifact_declared" ||
      frame.rule.predicate.kind !== "artifact_required"
    )
      throw new Error("Missing artifact rule");
    frame.input.binding.observation = { status: "unavailable", reason: "content_integrity_failed" };
    expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(true);
    frame.input.binding.catalog = null;
    frame.input.binding.observation = { status: "missing" };
    expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(true);
    frame.rule.predicate.componentKind = "model_resolution";
    frame.input.binding = { status: "model_alias" };
    expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    "missing",
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
  ] as const)("binds catalog presence to the original %s observation", (reason) => {
    const value = readyArtifact();
    const frame = required(value.rules, 1);
    if (frame.input.kind !== "artifact" || frame.input.binding.status !== "artifact_declared")
      throw new Error("Missing artifact input");
    const binding = frame.input.binding;
    binding.observation =
      reason === "missing" ? { status: "missing" } : { status: "unavailable", reason };
    const absent = [
      "missing",
      "reference_unsupported",
      "record_invalid",
      "reference_mismatch",
    ].includes(reason);
    expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(!absent);
    binding.catalog = null;
    expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(absent);
  });

  it("admits exactly 128 ordered rules and rejects overflow before inspecting nested material", () => {
    const value = input();
    const original = required(value.rules, 0);
    value.ruleCount = 128;
    value.rules = Array.from({ length: 128 }, (_, index) => ({
      ...structuredClone(original),
      ruleIndex: index,
      rule: { ...structuredClone(original.rule), ruleId: `rule_${String(index).padStart(3, "0")}` },
    }));
    expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(true);
    value.rules.push(structuredClone(original));
    Object.defineProperty(value.rules[0], "rule", {
      get() {
        throw new Error("Material read before admission");
      },
    });
    expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(false);
  });

  it.each([null, [], "invalid", { rules: "invalid" }, { rules: [] }])(
    "rejects malformed input without an empty success: %j",
    (value) => {
      expect(PolicyEvaluationSnapshotRuleInputsSchema.safeParse(value).success).toBe(false);
    },
  );

  it("rejects extra authority fields even on a single original approval rule", () => {
    const frame = required(input().rules, 0);
    Reflect.set(frame.input, "approvedByPrincipalId", "caller_approval");
    expect(PolicyEvaluationRuleProjectionSchema.safeParse(frame).success).toBe(false);
  });
});

describe("canonical ordered snapshot rule metadata", () => {
  const hash = (value: PolicyEvaluationSnapshotRuleInputs) =>
    createHash("sha256").update(encodePolicyEvaluationSnapshotRuleInputs(value)).digest("hex");
  it("matches independently generated Python canonical UTF-8 bytes and SHA-256", () => {
    expect(encodePolicyEvaluationSnapshotRuleInputs(input()).byteLength).toBe(
      canonical.encodedByteLength,
    );
    expect(hash(input())).toBe(canonical.sha256);
  });
  it("keeps canonical bytes stable across object insertion order", () => {
    const value = input();
    expect(
      hash(
        Object.fromEntries(Object.entries(value).reverse()) as PolicyEvaluationSnapshotRuleInputs,
      ),
    ).toBe(canonical.sha256);
  });
  it.each([
    "cut",
    "request",
    "scope",
    "root",
    "rule",
    "predicate",
    "source",
    "availability",
  ] as const)("binds the exact retained %s", (field) => {
    const value = input();
    if (field === "cut")
      value.evaluationTime = "2026-10-03T00:00:00.000000000000000000000000000002Z";
    else if (field === "request") value.request.definitionSha256 = "b".repeat(64);
    else if (field === "scope") value.scope.tenantId = "other_tenant";
    else if (field === "root") value.candidate.recordSha256 = "b".repeat(64);
    else if (field === "rule")
      required(value.rules, 0).rule.nonWaivable = !required(value.rules, 0).rule.nonWaivable;
    else if (field === "predicate")
      Reflect.set(required(value.rules, 0).rule.predicate, "quorum", 1);
    else if (field === "source")
      required(required(value.rules, 0).rule.sources, 0).source.definitionSha256 = "b".repeat(64);
    else {
      Reflect.set(required(value.rules, 1).input, "binding", { status: "model_alias" });
      Reflect.set(required(value.rules, 1).rule.predicate, "componentKind", "model_resolution");
    }
    expect(hash(value)).not.toBe(canonical.sha256);
  });
});
