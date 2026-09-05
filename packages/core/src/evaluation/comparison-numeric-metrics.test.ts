import { readFileSync } from "node:fs";
import {
  COMPARISON_DEFINITION_SCHEMA_VERSION,
  COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  type ComparisonDefinition,
  ComparisonDefinitionRecordSchema,
  type ComparisonEvidenceFixtureSnapshot,
  type ComparisonEvidenceSnapshot,
  ComparisonEvidenceSnapshotSchema,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { deriveComparisonNumericMetrics } from "./comparison-numeric-metrics.js";
import { ComparisonPairingError } from "./comparison-pairing.js";

const sha = (character: string) => character.repeat(64);

interface DefinitionVectorDocument {
  readonly vectors: readonly {
    readonly input: {
      readonly definition: Record<string, unknown>;
      readonly scope: Record<string, unknown>;
    };
  }[];
}

const definitionVector = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/evaluation-comparison-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as DefinitionVectorDocument;

type SubjectFixture = ComparisonDefinition["baseline"]["fixtures"][number];
type NumericObservation = ComparisonEvidenceFixtureSnapshot["numericObservations"][number];

function baseComparison(): ComparisonDefinition {
  const vector = definitionVector.vectors[0];
  if (!vector) throw new Error("Expected comparison vector");
  return ComparisonDefinitionRecordSchema.parse({
    ...structuredClone(vector.input.definition),
    createdAt: "2026-09-02T01:10:00.000Z",
    createdByPrincipalId: "principal_operator",
    definitionSha256: sha("d"),
    schemaVersion: COMPARISON_DEFINITION_SCHEMA_VERSION,
    scope: structuredClone(vector.input.scope),
  });
}

function cloneFixture(
  source: SubjectFixture,
  fixtureId: string,
  definitionDigestCharacter: string,
): SubjectFixture {
  return {
    assessments: [],
    fixture: {
      definitionSha256: sha(definitionDigestCharacter),
      fixtureId,
      fixtureVersionId: `${fixtureId}_v1`,
    },
    modelAssuranceAssessments: [],
    replay: {
      ...structuredClone(source.replay),
      attemptId: `${source.replay.attemptId}_${fixtureId}`,
      jobId: `${source.replay.jobId}_${fixtureId}`,
      plan: {
        ...structuredClone(source.replay.plan),
        planId: `${source.replay.plan.planId}_${fixtureId}`,
        planVersionId: `${source.replay.plan.planVersionId}_${fixtureId}`,
      },
      result: {
        ...structuredClone(source.replay.result),
        artifactId: `${source.replay.result.artifactId}_${fixtureId}`,
      },
      targetRelease: {
        ...structuredClone(source.replay.targetRelease),
        targetReleaseId: `${source.replay.targetRelease.targetReleaseId}_${fixtureId}`,
      },
    },
  };
}

function numericComparison(): ComparisonDefinition {
  const source = baseComparison();
  const baselineFixture = source.baseline.fixtures[0];
  const candidateFixture = source.candidate.fixtures[0];
  if (!baselineFixture || !candidateFixture) throw new Error("Expected subject fixtures");
  const identities = [
    ["fixture_a", "1"],
    ["fixture_b", "2"],
    ["fixture_c", "3"],
    ["fixture_d", "4"],
    ["fixture_e", "5"],
  ] as const;
  const fixtures = (roleFixture: SubjectFixture, includedIds: readonly string[]) =>
    identities.flatMap(([fixtureId, digest]) =>
      includedIds.includes(fixtureId) ? [cloneFixture(roleFixture, fixtureId, digest)] : [],
    );
  return ComparisonDefinitionRecordSchema.parse({
    ...source,
    baseline: {
      ...source.baseline,
      fixtures: fixtures(baselineFixture, ["fixture_a", "fixture_b", "fixture_c", "fixture_d"]),
    },
    candidate: {
      ...source.candidate,
      fixtures: fixtures(candidateFixture, ["fixture_a", "fixture_b", "fixture_c", "fixture_e"]),
    },
    metrics: [
      {
        aggregation: { method: "median", methodVersion: "1.0.0" },
        kind: "numeric_measurement",
        label: "Median latency",
        measurementName: "latency",
        metricId: "metric_latency",
        stratumId: "stratum_all",
        unit: "milliseconds",
      },
    ],
    strata: [
      {
        fixtureIds: identities.map(([fixtureId]) => fixtureId),
        label: "All requested fixtures",
        stratumId: "stratum_all",
      },
    ],
  });
}

function assuranceFor(subjectFixture: SubjectFixture) {
  return [
    ...subjectFixture.assessments.map((reference) => ({
      eligibility: "eligible" as const,
      kind: "assessment" as const,
      reasons: [],
      reference,
    })),
    ...subjectFixture.modelAssuranceAssessments.map((reference) => ({
      eligibility: "eligible" as const,
      kind: "model_assurance" as const,
      reasons: [],
      reference,
    })),
  ];
}

function snapshot(
  source: ComparisonDefinition,
  role: "baseline" | "candidate",
  observations: Readonly<Record<string, readonly NumericObservation[]>> = {},
  omissions: ComparisonEvidenceSnapshot["omissions"] = [],
): ComparisonEvidenceSnapshot {
  return ComparisonEvidenceSnapshotSchema.parse({
    comparison: {
      comparisonId: source.comparisonId,
      comparisonVersionId: source.comparisonVersionId,
      definitionSha256: source.definitionSha256,
    },
    createdAt: "2026-09-02T02:00:01.000Z",
    createdByPrincipalId: "principal_operator",
    dataset: source[role].dataset,
    definitionSha256: role === "baseline" ? sha("e") : sha("f"),
    fixtures: source[role].fixtures.map((value) => ({
      artifacts: [],
      assurance: assuranceFor(value),
      evaluationOutcomes: [],
      fixture: value.fixture,
      numericObservations: observations[value.fixture.fixtureId] ?? [],
      replay: value.replay,
      safetyEvents: [],
      trace: { eventCount: 0, eventKinds: [], eventStatuses: [] },
      usage: [],
    })),
    integrity: "verified",
    knownLimitations: [],
    omissions,
    role,
    schemaVersion: COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
    scope: source.scope,
    snapshotId: `snapshot_${role}`,
    sourceCutoff: "2026-09-02T02:00:00.000Z",
  });
}

function observation(
  fixtureId: string,
  value: string,
  suffix = "1",
  unit = "milliseconds",
): NumericObservation {
  return {
    measurementName: "latency",
    observation: {
      definitionSha256: sha(suffix),
      observationId: `observation_${fixtureId}_${suffix}`,
    },
    unit,
    value,
  };
}

function exact(numerator: string) {
  return {
    denominator: "1",
    numerator,
    representation: "rational" as const,
    unit: "milliseconds",
  };
}

describe("numeric comparison derivation", () => {
  it("keeps role distributions separate from exact paired deltas and missingness", () => {
    const comparison = numericComparison();
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: [observation("fixture_a", "10")],
      fixture_b: [observation("fixture_b", "20")],
      fixture_c: [observation("fixture_c", "30", "1"), observation("fixture_c", "31", "2")],
      fixture_d: [observation("fixture_d", "40")],
    });
    const candidate = snapshot(
      comparison,
      "candidate",
      {
        fixture_a: [observation("fixture_a", "8")],
        fixture_c: [observation("fixture_c", "5")],
        fixture_e: [observation("fixture_e", "50")],
      },
      [
        {
          fixtureId: "fixture_b",
          measurementName: "latency",
          reason: "measurement_unavailable",
          sourceKind: "numeric_measurement",
          unit: "milliseconds",
        },
      ],
    );

    expect(deriveComparisonNumericMetrics({ baseline, candidate, comparison })).toEqual({
      distributions: [
        {
          invalidCount: 1,
          method: { method: "median", methodVersion: "1.0.0" },
          metricId: "metric_latency",
          missingCount: 0,
          observedCount: 3,
          role: "baseline",
          totalCount: 4,
          unavailableCount: 0,
          value: exact("20"),
        },
        {
          invalidCount: 0,
          method: { method: "median", methodVersion: "1.0.0" },
          metricId: "metric_latency",
          missingCount: 0,
          observedCount: 3,
          role: "candidate",
          totalCount: 4,
          unavailableCount: 1,
          value: exact("8"),
        },
      ],
      metricResults: [
        {
          metricId: "metric_latency",
          samples: {
            baselineInvalidCount: 1,
            baselineMissingCount: 0,
            baselineObservedCount: 3,
            baselineTotalCount: 4,
            baselineUnavailableCount: 0,
            candidateInvalidCount: 0,
            candidateMissingCount: 0,
            candidateObservedCount: 3,
            candidateTotalCount: 4,
            candidateUnavailableCount: 1,
            pairedInvalidCount: 1,
            pairedMissingCount: 0,
            pairedObservedCount: 1,
            pairedTotalCount: 3,
            pairedUnavailableCount: 1,
          },
          value: {
            baseline: exact("10"),
            candidate: exact("8"),
            delta: exact("-2"),
            direction: "decreased",
            status: "available",
          },
        },
      ],
    });
  });

  it("returns explicit unavailable reasons without coercing absent values to zero", () => {
    const comparison = numericComparison();
    const baseline = snapshot(comparison, "baseline");
    const candidate = snapshot(comparison, "candidate");

    const result = deriveComparisonNumericMetrics({ baseline, candidate, comparison });
    expect(result.distributions).toEqual([]);
    expect(result.metricResults[0]?.value).toEqual({
      reasons: ["baseline_missing", "candidate_missing", "insufficient_observations"],
      status: "unavailable",
    });
    expect(result.metricResults[0]?.samples).toMatchObject({
      baselineMissingCount: 4,
      baselineObservedCount: 0,
      candidateMissingCount: 4,
      candidateObservedCount: 0,
      pairedMissingCount: 3,
      pairedObservedCount: 0,
    });
  });

  it("preserves source limits and invalid units as distinct unavailable reasons", () => {
    const comparison = numericComparison();
    const sourceLimited = (role: "baseline" | "candidate") =>
      snapshot(comparison, role, {}, [
        {
          fixtureId: "fixture_a",
          measurementName: "latency",
          reason: "source_over_limit",
          sourceKind: "numeric_measurement",
          unit: "milliseconds",
        },
      ]);
    expect(
      deriveComparisonNumericMetrics({
        baseline: sourceLimited("baseline"),
        candidate: sourceLimited("candidate"),
        comparison,
      }).metricResults[0]?.value,
    ).toEqual({
      reasons: [
        "baseline_missing",
        "candidate_missing",
        "insufficient_observations",
        "source_over_limit",
      ],
      status: "unavailable",
    });

    const measurementUnavailable = (role: "baseline" | "candidate") =>
      snapshot(comparison, role, {}, [
        {
          fixtureId: "fixture_a",
          measurementName: "latency",
          reason: "measurement_unavailable",
          sourceKind: "numeric_measurement",
          unit: "milliseconds",
        },
      ]);
    expect(
      deriveComparisonNumericMetrics({
        baseline: measurementUnavailable("baseline"),
        candidate: measurementUnavailable("candidate"),
        comparison,
      }).metricResults[0]?.value,
    ).toEqual({
      reasons: [
        "baseline_missing",
        "candidate_missing",
        "insufficient_observations",
        "measurement_unavailable",
      ],
      status: "unavailable",
    });

    const invalidUnit = (role: "baseline" | "candidate") =>
      snapshot(comparison, role, {
        fixture_a: [observation("fixture_a", "1", "1", "seconds")],
      });
    expect(
      deriveComparisonNumericMetrics({
        baseline: invalidUnit("baseline"),
        candidate: invalidUnit("candidate"),
        comparison,
      }).metricResults[0]?.value,
    ).toEqual({
      reasons: [
        "baseline_missing",
        "candidate_missing",
        "insufficient_observations",
        "invalid_observations",
      ],
      status: "unavailable",
    });
  });

  it("derives unchanged and increased directions from the exact signed delta", () => {
    const comparison = numericComparison();
    const deriveDirection = (baselineValue: string, candidateValue: string) =>
      deriveComparisonNumericMetrics({
        baseline: snapshot(comparison, "baseline", {
          fixture_a: [observation("fixture_a", baselineValue)],
        }),
        candidate: snapshot(comparison, "candidate", {
          fixture_a: [observation("fixture_a", candidateValue)],
        }),
        comparison,
      }).metricResults[0]?.value;

    expect(deriveDirection("1.5", "1.5")).toMatchObject({
      delta: exact("0"),
      direction: "unchanged",
      status: "available",
    });
    expect(deriveDirection("1", "2")).toMatchObject({
      delta: exact("1"),
      direction: "increased",
      status: "available",
    });
  });

  it("ignores non-numeric metrics and delegates malformed inputs to exact pairing validation", () => {
    const comparison = baseComparison();
    expect(
      deriveComparisonNumericMetrics({
        baseline: snapshot(comparison, "baseline"),
        candidate: snapshot(comparison, "candidate"),
        comparison,
      }),
    ).toEqual({ distributions: [], metricResults: [] });

    expect(() =>
      deriveComparisonNumericMetrics({
        baseline: snapshot(comparison, "baseline"),
        candidate: snapshot(comparison, "candidate"),
        comparison: {} as ComparisonDefinition,
      }),
    ).toThrow(ComparisonPairingError);
  });
});
