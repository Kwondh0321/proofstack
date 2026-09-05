import { describe, expect, it } from "vitest";
import {
  COMPARISON_DEFINITION_SCHEMA_VERSION,
  ComparisonDefinitionRecordSchema,
  ComparisonDefinitionSchema,
  ComparisonMetricSchema,
  ComparisonSubjectSchema,
  PublishComparisonDefinitionRequestSchema,
} from "./evaluation-comparison.js";

const sha = (character: string) => character.repeat(64);

function replay(role: "baseline" | "candidate") {
  return {
    attemptId: `${role}_attempt`,
    completedAt: "2026-09-02T01:00:00.000Z",
    jobId: `${role}_job`,
    plan: {
      definitionSha256: sha(role === "baseline" ? "1" : "2"),
      planId: `${role}_plan`,
      planVersionId: `${role}_plan_v1`,
    },
    result: {
      artifactId: `${role}_result`,
      classification: "internal",
      mediaType: "application/json",
      sha256: sha(role === "baseline" ? "3" : "4"),
      sizeBytes: 128,
    },
    targetRelease: {
      definitionSha256: sha(role === "baseline" ? "5" : "6"),
      targetAdapter: {
        name: "local_target",
        protocolVersion: "1.0.0",
        version: "1.0.0",
      },
      targetId: "target_agent",
      targetReleaseId: `${role}_release`,
      workerProtocol: { name: "json_line", version: "1.0.0" },
    },
    terminalCode: "completed",
    terminalStatus: "succeeded",
  } as const;
}

function subject(role: "baseline" | "candidate") {
  return {
    dataset: {
      datasetId: "dataset_main",
      datasetVersionId: "dataset_v1",
      definitionSha256: sha("7"),
    },
    fixtures: [
      {
        assessments: [
          {
            assessmentId: `${role}_assessment`,
            definitionSha256: sha(role === "baseline" ? "8" : "9"),
          },
        ],
        fixture: {
          definitionSha256: sha("a"),
          fixtureId: "fixture_login",
          fixtureVersionId: "fixture_login_v1",
        },
        modelAssuranceAssessments: [
          {
            assessmentExtensionId: `${role}_model_assessment`,
            definitionSha256: sha(role === "baseline" ? "b" : "c"),
          },
        ],
        replay: replay(role),
      },
    ],
  } as const;
}

function definition() {
  return {
    baseline: subject("baseline"),
    calculationPolicy: {
      confidenceIntervals: "source_only",
      decimalArithmetic: "exact_decimal_v1",
      fixturePairing: "logical_fixture_id",
      mean: "exact_rational_v1",
      minimumPairedCoverageBasisPoints: 8_000,
      missingness: "preserve_all",
      quantile: "nearest_rank_v1",
    },
    candidate: subject("candidate"),
    classifiedContentProjection: "metadata_only",
    comparisonId: "comparison_login",
    comparisonVersionId: "comparison_login_v1",
    description: "Compare the exact login incident regression evidence.",
    metrics: [
      {
        dimension: "elapsedMilliseconds",
        aggregation: { method: "median" },
        kind: "replay_usage",
        label: "Median replay elapsed time",
        metricId: "metric_elapsed",
      },
      {
        criterion: {
          criterionId: "criterion_login",
          criterionSet: {
            criterionSetId: "criteria_main",
            criterionSetVersionId: "criteria_main_v1",
            definitionSha256: sha("d"),
          },
        },
        kind: "evaluation_verdict_count",
        label: "Failed login evaluations",
        metricId: "metric_failures",
        verdict: "fail",
      },
    ],
    name: "Login evidence comparison",
  } as const;
}

describe("comparison definition contracts", () => {
  it("accepts exact subjects and finite direction-neutral metrics", () => {
    expect(ComparisonDefinitionSchema.parse(definition())).toEqual(definition());
  });

  it("rejects caller-owned scope, digest, timestamps, and derived result fields", () => {
    const { comparisonId: _comparisonId, ...request } = definition();
    expect(_comparisonId).toBe("comparison_login");
    expect(PublishComparisonDefinitionRequestSchema.safeParse(request).success).toBe(true);

    for (const [field, value] of [
      ["scope", { environmentId: "env_one", projectId: "project_one", tenantId: "tenant_one" }],
      ["createdAt", "2026-09-02T01:00:00.000Z"],
      ["definitionSha256", sha("e")],
      ["comparability", "comparable"],
      ["releaseDecision", "approve"],
    ] as const) {
      expect(
        PublishComparisonDefinitionRequestSchema.safeParse({ ...request, [field]: value }).success,
      ).toBe(false);
    }
  });

  it("rejects identical subjects and a self predecessor", () => {
    const valid = definition();
    expect(
      ComparisonDefinitionSchema.safeParse({ ...valid, candidate: valid.baseline }).success,
    ).toBe(false);
    expect(
      ComparisonDefinitionSchema.safeParse({
        ...valid,
        predecessor: {
          comparisonVersionId: valid.comparisonVersionId,
          definitionSha256: sha("f"),
        },
      }).success,
    ).toBe(false);

    const { comparisonId: _comparisonId, ...request } = valid;
    expect(_comparisonId).toBe("comparison_login");
    expect(
      PublishComparisonDefinitionRequestSchema.safeParse({
        ...request,
        predecessorVersionId: request.comparisonVersionId,
      }).success,
    ).toBe(false);
    expect(
      PublishComparisonDefinitionRequestSchema.safeParse({
        ...request,
        candidate: request.baseline,
      }).success,
    ).toBe(false);
  });

  it("requires unique ordered fixtures, assessments, and metrics", () => {
    const valid = definition();
    const fixture = valid.baseline.fixtures[0];
    expect(
      ComparisonSubjectSchema.safeParse({
        ...valid.baseline,
        fixtures: [fixture, fixture],
      }).success,
    ).toBe(false);
    expect(
      ComparisonSubjectSchema.safeParse({
        ...valid.baseline,
        fixtures: [
          {
            ...fixture,
            assessments: [fixture.assessments[0], fixture.assessments[0]],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ComparisonDefinitionSchema.safeParse({
        ...valid,
        metrics: [valid.metrics[1], valid.metrics[0]],
      }).success,
    ).toBe(false);
  });

  it("bounds quantiles and rejects unknown metric semantics", () => {
    expect(
      ComparisonMetricSchema.safeParse({
        aggregation: {
          basisPoints: 9_500,
          method: "nearest_rank_quantile",
          methodVersion: "1.0.0",
        },
        dimension: "providerCostMicrounits",
        kind: "replay_usage",
        label: "P95 provider cost",
        metricId: "metric_cost_p95",
      }).success,
    ).toBe(true);
    expect(
      ComparisonMetricSchema.safeParse({
        aggregation: {
          basisPoints: 10_001,
          method: "nearest_rank_quantile",
          methodVersion: "1.0.0",
        },
        dimension: "providerCostMicrounits",
        kind: "replay_usage",
        label: "Invalid quantile",
        metricId: "metric_invalid",
      }).success,
    ).toBe(false);
    expect(
      ComparisonMetricSchema.safeParse({
        kind: "weighted_release_score",
        label: "Forbidden score",
        metricId: "metric_release",
        threshold: "0.95",
      }).success,
    ).toBe(false);
  });

  it("requires an exact bounded minimum paired coverage rule", () => {
    const valid = definition();
    for (const minimumPairedCoverageBasisPoints of [0, 10_001, 1.5]) {
      expect(
        ComparisonDefinitionSchema.safeParse({
          ...valid,
          calculationPolicy: {
            ...valid.calculationPolicy,
            minimumPairedCoverageBasisPoints,
          },
        }).success,
      ).toBe(false);
    }

    const missingPolicy = structuredClone(valid) as Record<string, unknown>;
    const calculationPolicy = missingPolicy["calculationPolicy"] as Record<string, unknown>;
    delete calculationPolicy["minimumPairedCoverageBasisPoints"];
    expect(ComparisonDefinitionSchema.safeParse(missingPolicy).success).toBe(false);
  });

  it("accepts only canonical server provenance", () => {
    const record = {
      ...definition(),
      createdAt: "2026-09-02T01:00:00.000Z",
      createdByPrincipalId: "principal_operator",
      definitionSha256: sha("0"),
      schemaVersion: COMPARISON_DEFINITION_SCHEMA_VERSION,
      scope: {
        environmentId: "env_one",
        projectId: "project_one",
        tenantId: "tenant_one",
      },
    };
    expect(ComparisonDefinitionRecordSchema.safeParse(record).success).toBe(true);
    expect(
      ComparisonDefinitionRecordSchema.safeParse({
        ...record,
        createdAt: "2026-09-02T01:00:00Z",
      }).success,
    ).toBe(false);
  });
});
