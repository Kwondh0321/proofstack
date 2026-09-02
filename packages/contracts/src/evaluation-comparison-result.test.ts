import { describe, expect, it } from "vitest";
import { ComparisonExactValueSchema } from "./evaluation-comparison.js";
import {
  COMPARISON_RESULT_SCHEMA_VERSION,
  ComparisonArtifactChangeSchema,
  ComparisonCaseSchema,
  ComparisonComparabilitySchema,
  ComparisonCountDeltaSchema,
  ComparisonMetricSampleCountsSchema,
  ComparisonMetricValueSchema,
  ComparisonResultDefinitionSchema,
  ComparisonResultSchema,
  DeriveComparisonResultRequestSchema,
} from "./evaluation-comparison-result.js";

const sha = (character: string) => character.repeat(64);

function fixture(fixtureVersionId: string, digest: string) {
  return {
    definitionSha256: sha(digest),
    fixtureId: "fixture_login",
    fixtureVersionId,
  } as const;
}

function definition() {
  return {
    artifactChanges: [
      {
        artifactId: "artifact_candidate_log",
        candidate: {
          artifactId: "artifact_candidate_log",
          classification: "internal",
          mediaType: "application/json",
          sha256: sha("1"),
          sizeBytes: 256,
        },
        status: "added",
      },
    ],
    baselineSnapshot: {
      definitionSha256: sha("2"),
      role: "baseline",
      snapshotId: "snapshot_baseline",
    },
    candidateSnapshot: {
      definitionSha256: sha("3"),
      role: "candidate",
      snapshotId: "snapshot_candidate",
    },
    cases: [
      {
        baseline: fixture("fixture_login_v1", "4"),
        candidate: fixture("fixture_login_v2", "5"),
        fixtureId: "fixture_login",
        state: "paired",
      },
      {
        baseline: {
          definitionSha256: sha("6"),
          fixtureId: "fixture_payment",
          fixtureVersionId: "fixture_payment_v1",
        },
        candidateMissingReason: "source_unavailable",
        fixtureId: "fixture_payment",
        state: "baseline_only",
      },
    ],
    comparability: {
      reasons: ["missing_source_evidence"],
      status: "partially_comparable",
    },
    comparison: {
      comparisonId: "comparison_release",
      comparisonVersionId: "comparison_release_v1",
      definitionSha256: sha("7"),
    },
    distributions: [
      {
        method: { method: "mean", methodVersion: "1.0.0" },
        metricId: "metric_latency",
        missingCount: 0,
        observedCount: 2,
        role: "baseline",
        totalCount: 2,
        value: { representation: "decimal", unit: "milliseconds", value: "125.5" },
      },
      {
        method: { method: "mean", methodVersion: "1.0.0" },
        metricId: "metric_latency",
        missingCount: 1,
        observedCount: 1,
        role: "candidate",
        totalCount: 2,
        value: { representation: "decimal", unit: "milliseconds", value: "110.5" },
      },
    ],
    knownLimitations: ["One candidate fixture was unavailable"],
    latestSourceCutoff: "2026-09-02T02:00:00.000Z",
    metricResults: [
      {
        metricId: "metric_latency",
        samples: {
          baselineMissingCount: 0,
          baselineObservedCount: 2,
          baselineTotalCount: 2,
          candidateMissingCount: 1,
          candidateObservedCount: 1,
          candidateTotalCount: 2,
          pairedObservedCount: 1,
        },
        value: {
          baseline: { representation: "decimal", unit: "milliseconds", value: "125.5" },
          candidate: { representation: "decimal", unit: "milliseconds", value: "110.5" },
          delta: { representation: "decimal", unit: "milliseconds", value: "-15" },
          direction: "decreased",
          status: "available",
        },
      },
    ],
    pairing: {
      baselineOnlyCount: 1,
      candidateOnlyCount: 0,
      invalidCount: 0,
      pairedCount: 1,
      requestedCount: 2,
    },
    resultId: "comparison_result_release",
    safetyCounts: [
      {
        counts: { baseline: 1, candidate: 2, delta: 1 },
        kind: "guardrail_check",
      },
    ],
    verdictTransitions: [
      {
        baseline: "fail",
        candidate: "pass",
        count: 1,
        criterion: {
          criterionId: "criterion_login",
          criterionSet: {
            criterionSetId: "criteria_main",
            criterionSetVersionId: "criteria_main_v1",
            definitionSha256: sha("8"),
          },
        },
      },
    ],
    verdictMarginals: [
      {
        baseline: { abstain: 0, error: 0, fail: 1, notApplicable: 0, pass: 1, total: 2 },
        candidate: { abstain: 0, error: 0, fail: 0, notApplicable: 0, pass: 1, total: 1 },
        criterion: {
          criterionId: "criterion_login",
          criterionSet: {
            criterionSetId: "criteria_main",
            criterionSetVersionId: "criteria_main_v1",
            definitionSha256: sha("8"),
          },
        },
        pairedCount: 1,
      },
    ],
  } as const;
}

describe("comparison result contracts", () => {
  it("accepts a policy-independent exact result with explicit missingness", () => {
    expect(ComparisonResultDefinitionSchema.parse(definition())).toEqual(definition());
  });

  it("validates decimal deltas, units, and direction using exact arithmetic", () => {
    expect(
      ComparisonMetricValueSchema.safeParse({
        baseline: { representation: "decimal", unit: "requests", value: "1.20" },
        candidate: { representation: "decimal", unit: "requests", value: "1.30" },
        delta: { representation: "decimal", unit: "requests", value: "0.10" },
        direction: "increased",
        status: "available",
      }).success,
    ).toBe(true);
    expect(
      ComparisonMetricValueSchema.safeParse({
        baseline: { representation: "decimal", unit: "requests", value: "1.20" },
        candidate: { representation: "decimal", unit: "requests", value: "1.30" },
        delta: { representation: "decimal", unit: "requests", value: "0.20" },
        direction: "increased",
        status: "available",
      }).success,
    ).toBe(false);
    expect(
      ComparisonMetricValueSchema.safeParse({
        baseline: { representation: "decimal", unit: "requests", value: "1" },
        candidate: { representation: "decimal", unit: "tokens", value: "1" },
        delta: { representation: "decimal", unit: "requests", value: "0" },
        direction: "increased",
        status: "available",
      }).success,
    ).toBe(false);
  });

  it("preserves canonical rational values and validates cross-representation deltas", () => {
    expect(
      ComparisonExactValueSchema.safeParse({
        denominator: "3",
        numerator: "1",
        representation: "rational",
        unit: "ratio",
      }).success,
    ).toBe(true);
    for (const value of [
      { denominator: "6", numerator: "2" },
      { denominator: "2", numerator: "0" },
    ]) {
      expect(
        ComparisonExactValueSchema.safeParse({
          ...value,
          representation: "rational",
          unit: "ratio",
        }).success,
      ).toBe(false);
    }

    const exactThirdDelta = {
      baseline: {
        denominator: "3",
        numerator: "1",
        representation: "rational",
        unit: "ratio",
      },
      candidate: {
        denominator: "3",
        numerator: "2",
        representation: "rational",
        unit: "ratio",
      },
      delta: {
        denominator: "3",
        numerator: "1",
        representation: "rational",
        unit: "ratio",
      },
      direction: "increased",
      status: "available",
    } as const;
    expect(ComparisonMetricValueSchema.safeParse(exactThirdDelta).success).toBe(true);
    expect(
      ComparisonMetricValueSchema.safeParse({
        ...exactThirdDelta,
        baseline: { representation: "decimal", unit: "ratio", value: "0.5" },
        candidate: {
          denominator: "3",
          numerator: "2",
          representation: "rational",
          unit: "ratio",
        },
        delta: {
          denominator: "6",
          numerator: "1",
          representation: "rational",
          unit: "ratio",
        },
      }).success,
    ).toBe(true);
    expect(
      ComparisonMetricValueSchema.safeParse({
        ...exactThirdDelta,
        delta: {
          denominator: "4",
          numerator: "1",
          representation: "rational",
          unit: "ratio",
        },
      }).success,
    ).toBe(false);
  });

  it("requires pairing counts and comparability to reconstruct exact cases", () => {
    const valid = definition();
    expect(
      ComparisonResultDefinitionSchema.safeParse({
        ...valid,
        pairing: { ...valid.pairing, pairedCount: 2 },
      }).success,
    ).toBe(false);
    expect(
      ComparisonResultDefinitionSchema.safeParse({
        ...valid,
        comparability: { reasons: [], status: "comparable" },
      }).success,
    ).toBe(false);
  });

  it("retains exact logical identity and invalid-case source references", () => {
    expect(
      ComparisonCaseSchema.safeParse({
        fixtureId: "fixture_invalid",
        reasons: ["digest_mismatch"],
        state: "invalid",
      }).success,
    ).toBe(false);
    expect(
      ComparisonCaseSchema.safeParse({
        baseline: fixture("fixture_login_v1", "a"),
        candidateMissingReason: "fixture_absent",
        fixtureId: "fixture_other",
        state: "baseline_only",
      }).success,
    ).toBe(false);
    expect(
      ComparisonComparabilitySchema.safeParse({
        reasons: [],
        status: "partially_comparable",
      }).success,
    ).toBe(false);
  });

  it("reconstructs metric denominators and bounds paired observations", () => {
    expect(
      ComparisonMetricSampleCountsSchema.safeParse({
        baselineMissingCount: 0,
        baselineObservedCount: 1,
        baselineTotalCount: 1,
        candidateMissingCount: 0,
        candidateObservedCount: 1,
        candidateTotalCount: 1,
        pairedObservedCount: 2,
      }).success,
    ).toBe(false);
    expect(
      ComparisonMetricSampleCountsSchema.safeParse({
        baselineMissingCount: 1,
        baselineObservedCount: 1,
        baselineTotalCount: 1,
        candidateMissingCount: 0,
        candidateObservedCount: 1,
        candidateTotalCount: 1,
        pairedObservedCount: 1,
      }).success,
    ).toBe(false);
  });

  it("preserves unavailable and incomparable metrics instead of coercing them to zero", () => {
    expect(
      ComparisonMetricValueSchema.safeParse({
        reasons: ["candidate_missing"],
        status: "unavailable",
      }).success,
    ).toBe(true);
    expect(
      ComparisonMetricValueSchema.safeParse({
        baseline: { representation: "decimal", unit: "milliseconds", value: "10" },
        candidate: { representation: "decimal", unit: "seconds", value: "1" },
        reasons: ["unit_mismatch"],
        status: "incomparable",
      }).success,
    ).toBe(true);
  });

  it("validates artifact shapes and signed count deltas", () => {
    expect(
      ComparisonArtifactChangeSchema.safeParse({
        artifactId: "artifact_missing",
        status: "added",
      }).success,
    ).toBe(false);
    expect(
      ComparisonArtifactChangeSchema.safeParse({
        artifactId: "artifact_declared",
        candidate: {
          artifactId: "artifact_other",
          classification: "internal",
          mediaType: "application/json",
          sha256: sha("b"),
          sizeBytes: 1,
        },
        status: "added",
      }).success,
    ).toBe(false);
    expect(
      ComparisonCountDeltaSchema.safeParse({ baseline: 4, candidate: 1, delta: -3 }).success,
    ).toBe(true);
    expect(
      ComparisonCountDeltaSchema.safeParse({ baseline: 4, candidate: 1, delta: 3 }).success,
    ).toBe(false);
  });

  it("accepts only exact role-bound inputs and rejects caller-derived decisions", () => {
    const valid = definition();
    const request = {
      baselineSnapshot: valid.baselineSnapshot,
      candidateSnapshot: valid.candidateSnapshot,
      comparison: valid.comparison,
      resultId: valid.resultId,
    };
    expect(DeriveComparisonResultRequestSchema.safeParse(request).success).toBe(true);
    expect(
      DeriveComparisonResultRequestSchema.safeParse({
        ...request,
        candidateSnapshot: { ...request.candidateSnapshot, role: "baseline" },
      }).success,
    ).toBe(false);
    expect(
      DeriveComparisonResultRequestSchema.safeParse({
        ...request,
        approval: "approved",
        releaseDecision: "release",
      }).success,
    ).toBe(false);
    expect(
      DeriveComparisonResultRequestSchema.safeParse({
        ...request,
        baselineSnapshot: { ...request.baselineSnapshot, role: "candidate" },
      }).success,
    ).toBe(false);
    expect(
      DeriveComparisonResultRequestSchema.safeParse({
        ...request,
        candidateSnapshot: {
          ...request.candidateSnapshot,
          snapshotId: request.baselineSnapshot.snapshotId,
        },
      }).success,
    ).toBe(false);
  });

  it("requires complete paired verdict transitions and distinct result roles", () => {
    const valid = definition();
    expect(
      ComparisonResultDefinitionSchema.safeParse({
        ...valid,
        baselineSnapshot: { ...valid.baselineSnapshot, role: "candidate" },
        candidateSnapshot: {
          ...valid.candidateSnapshot,
          role: "baseline",
          snapshotId: valid.baselineSnapshot.snapshotId,
        },
      }).success,
    ).toBe(false);
    expect(
      ComparisonResultDefinitionSchema.safeParse({
        ...valid,
        verdictMarginals: [],
      }).success,
    ).toBe(false);
    expect(
      ComparisonResultDefinitionSchema.safeParse({
        ...valid,
        verdictTransitions: [],
      }).success,
    ).toBe(false);
  });

  it("requires server provenance after the latest source cutoff", () => {
    const record = {
      ...definition(),
      createdAt: "2026-09-02T02:00:01.000Z",
      createdByPrincipalId: "principal_operator",
      definitionSha256: sha("9"),
      schemaVersion: COMPARISON_RESULT_SCHEMA_VERSION,
      scope: {
        environmentId: "environment_reference",
        projectId: "project_reference",
        tenantId: "tenant_reference",
      },
    };
    expect(ComparisonResultSchema.safeParse(record).success).toBe(true);
    expect(
      ComparisonResultSchema.safeParse({
        ...record,
        createdAt: "2026-09-02T01:59:59.999Z",
      }).success,
    ).toBe(false);
  });
});
