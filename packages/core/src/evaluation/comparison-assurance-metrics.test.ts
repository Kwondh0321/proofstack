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
import { deriveComparisonAssuranceMetrics } from "./comparison-assurance-metrics.js";

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
type AssuranceState = ComparisonEvidenceFixtureSnapshot["assurance"][number];
type ModelAssuranceReason = Extract<
  AssuranceState,
  { readonly kind: "model_assurance" }
>["reasons"][number];

const conditionCases = [
  ["assessment_eligibility", "assessment_eligible", 0, 1],
  ["assessment_eligibility", "assessment_ineligible", 1, 0],
  ["calibration_availability", "calibration_available", 0, 1],
  ["calibration_availability", "calibration_incompatible", 1, 0],
  ["calibration_availability", "calibration_stale", 1, 0],
  ["calibration_availability", "calibration_unavailable", 1, 0],
  ["counterevidence", "critical_counterevidence_absent", 0, 1],
  ["counterevidence", "critical_counterevidence_present", 1, 0],
  ["disagreement", "disagreement_absent", 0, 1],
  ["human_review", "human_review_available", 0, 1],
  ["human_review", "human_review_conflicted", 1, 0],
  ["human_review", "human_review_expired", 1, 0],
  ["human_review", "human_review_invalid", 1, 0],
  ["human_review", "human_review_missing", 1, 0],
  ["human_review", "human_review_protocol_mismatch", 1, 0],
  ["human_review", "human_review_quorum_shortfall", 1, 0],
  ["model_assurance_eligibility", "model_assurance_eligible", 0, 1],
  ["model_assurance_eligibility", "model_assurance_ineligible", 1, 0],
  ["disagreement", "order_sensitive_result", 1, 0],
  ["disagreement", "unresolved_disagreement", 1, 0],
] as const;

const allModelAssuranceReasons = [
  "calibration_incompatible",
  "calibration_stale",
  "calibration_unavailable",
  "critical_counterevidence",
  "human_review_conflicted",
  "human_review_expired",
  "human_review_invalid",
  "human_review_missing",
  "human_review_protocol_mismatch",
  "human_review_quorum_shortfall",
  "order_sensitive_result",
  "unresolved_disagreement",
] as const satisfies readonly ModelAssuranceReason[];

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

function assuranceComparison(): ComparisonDefinition {
  const source = baseComparison();
  return ComparisonDefinitionRecordSchema.parse({
    ...source,
    metrics: conditionCases.map(([dimension, condition], index) => ({
      condition,
      dimension,
      kind: "assurance_state_count",
      label: `Assurance condition ${condition}`,
      metricId: `metric_${index.toString().padStart(2, "0")}`,
      stratumId: "stratum_all",
      unit: "assurance_records",
    })),
  });
}

function assuranceFor(
  subjectFixture: SubjectFixture,
  state: "eligible" | "ineligible" = "eligible",
  modelReasons: readonly ModelAssuranceReason[] = [],
): readonly AssuranceState[] {
  const assessment = subjectFixture.assessments[0];
  const modelAssurance = subjectFixture.modelAssuranceAssessments[0];
  if (!assessment || !modelAssurance) throw new Error("Expected exact assurance references");
  return [
    {
      eligibility: state,
      kind: "assessment",
      reasons: state === "eligible" ? [] : ["critical_counterevidence"],
      reference: assessment,
    },
    {
      eligibility: state,
      kind: "model_assurance",
      reasons: state === "eligible" ? [] : [...modelReasons],
      reference: modelAssurance,
    },
  ];
}

function snapshot(
  source: ComparisonDefinition,
  role: "baseline" | "candidate",
  options: {
    readonly assurance?: Readonly<Record<string, readonly AssuranceState[]>>;
    readonly includedFixtureIds?: readonly string[];
  } = {},
): ComparisonEvidenceSnapshot {
  const included = new Set(
    options.includedFixtureIds ?? source[role].fixtures.map(({ fixture }) => fixture.fixtureId),
  );
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
    fixtures: source[role].fixtures
      .filter(({ fixture }) => included.has(fixture.fixtureId))
      .map((value) => ({
        artifacts: [],
        assurance: options.assurance?.[value.fixture.fixtureId] ?? assuranceFor(value),
        evaluationOutcomes: [],
        fixture: value.fixture,
        numericObservations: [],
        replay: value.replay,
        safetyEvents: [],
        trace: { eventCount: 0, eventKinds: [], eventKindStatuses: [], eventStatuses: [] },
        usage: [],
      })),
    integrity: "verified",
    knownLimitations: [],
    omissions: [],
    role,
    schemaVersion: COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
    scope: source.scope,
    snapshotId: `snapshot_${role}`,
    sourceCutoff: "2026-09-02T02:00:00.000Z",
  });
}

function cloneFixture(source: SubjectFixture, fixtureId: string, digest: string): SubjectFixture {
  return {
    ...structuredClone(source),
    fixture: {
      definitionSha256: sha(digest),
      fixtureId,
      fixtureVersionId: `${fixtureId}_v1`,
    },
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

function exact(numerator: number) {
  return {
    denominator: "1",
    numerator: numerator.toString(),
    representation: "rational" as const,
    unit: "assurance_records",
  };
}

describe("assurance state comparison derivation", () => {
  it("derives every explicit assurance condition from exact retained states", () => {
    const comparison = assuranceComparison();
    const baselineFixture = comparison.baseline.fixtures[0];
    const candidateFixture = comparison.candidate.fixtures[0];
    if (!baselineFixture || !candidateFixture) throw new Error("Expected subject fixtures");
    const baseline = snapshot(comparison, "baseline", {
      assurance: {
        fixture_login: assuranceFor(baselineFixture, "ineligible", allModelAssuranceReasons),
      },
    });
    const candidate = snapshot(comparison, "candidate", {
      assurance: { fixture_login: assuranceFor(candidateFixture) },
    });

    const result = deriveComparisonAssuranceMetrics({ baseline, candidate, comparison });
    expect(result.metricResults).toHaveLength(conditionCases.length);
    for (const [index, [, , baselineCount, candidateCount]] of conditionCases.entries()) {
      const metric = result.metricResults[index];
      expect(metric?.metricId).toBe(`metric_${index.toString().padStart(2, "0")}`);
      expect(metric?.value).toEqual({
        baseline: exact(baselineCount),
        candidate: exact(candidateCount),
        delta: exact(candidateCount - baselineCount),
        direction:
          baselineCount === candidateCount
            ? "unchanged"
            : baselineCount < candidateCount
              ? "increased"
              : "decreased",
        status: "available",
      });
      expect(metric?.samples).toMatchObject({
        baselineObservedCount: 1,
        baselineTotalCount: 1,
        candidateObservedCount: 1,
        candidateTotalCount: 1,
        pairedObservedCount: 1,
        pairedTotalCount: 1,
      });
    }
  });

  it("keeps independent assurance dimensions available when another dimension fails", () => {
    const comparison = assuranceComparison();
    const baselineFixture = comparison.baseline.fixtures[0];
    const candidateFixture = comparison.candidate.fixtures[0];
    if (!baselineFixture || !candidateFixture) throw new Error("Expected subject fixtures");
    const baseline = snapshot(comparison, "baseline", {
      assurance: {
        fixture_login: assuranceFor(baselineFixture, "ineligible", ["human_review_missing"]),
      },
    });
    const candidate = snapshot(comparison, "candidate", {
      assurance: {
        fixture_login: assuranceFor(candidateFixture, "ineligible", ["human_review_missing"]),
      },
    });

    const results = deriveComparisonAssuranceMetrics({ baseline, candidate, comparison });
    const exactCounts = (index: number) => {
      const value = results.metricResults[index]?.value;
      if (value?.status !== "available") throw new Error("Expected an available exact metric");
      if (value.baseline.representation !== "rational") {
        throw new Error("Expected a rational baseline count");
      }
      if (value.candidate.representation !== "rational") {
        throw new Error("Expected a rational candidate count");
      }
      return [value.baseline.numerator, value.candidate.numerator];
    };
    expect(exactCounts(2)).toEqual(["1", "1"]);
    expect(exactCounts(6)).toEqual(["1", "1"]);
    expect(exactCounts(8)).toEqual(["1", "1"]);
    expect(exactCounts(9)).toEqual(["0", "0"]);
    expect(exactCounts(13)).toEqual(["1", "1"]);
    expect(exactCounts(17)).toEqual(["1", "1"]);
  });

  it("treats an exact empty assurance set as an observed zero", () => {
    const source = assuranceComparison();
    const comparison = ComparisonDefinitionRecordSchema.parse({
      ...source,
      baseline: {
        ...source.baseline,
        fixtures: source.baseline.fixtures.map((fixture) => ({
          ...fixture,
          assessments: [],
          modelAssuranceAssessments: [],
        })),
      },
      candidate: {
        ...source.candidate,
        fixtures: source.candidate.fixtures.map((fixture) => ({
          ...fixture,
          assessments: [],
          modelAssuranceAssessments: [],
        })),
      },
      metrics: [
        {
          condition: "human_review_missing",
          dimension: "human_review",
          kind: "assurance_state_count",
          label: "Missing human review",
          metricId: "metric_empty",
          stratumId: "stratum_all",
          unit: "assurance_records",
        },
      ],
    });
    const baseline = snapshot(comparison, "baseline", { assurance: { fixture_login: [] } });
    const candidate = snapshot(comparison, "candidate", { assurance: { fixture_login: [] } });

    expect(
      deriveComparisonAssuranceMetrics({ baseline, candidate, comparison }).metricResults[0],
    ).toMatchObject({
      value: {
        baseline: exact(0),
        candidate: exact(0),
        delta: exact(0),
        direction: "unchanged",
        status: "available",
      },
    });
  });

  it("excludes an absent fixture without turning it into a zero", () => {
    const source = assuranceComparison();
    const baselineFixture = source.baseline.fixtures[0];
    const candidateFixture = source.candidate.fixtures[0];
    if (!baselineFixture || !candidateFixture) throw new Error("Expected subject fixtures");
    const fixtureIds = ["fixture_a", "fixture_b"];
    const comparison = ComparisonDefinitionRecordSchema.parse({
      ...source,
      baseline: {
        ...source.baseline,
        fixtures: fixtureIds.map((fixtureId, index) =>
          cloneFixture(baselineFixture, fixtureId, index === 0 ? "1" : "2"),
        ),
      },
      candidate: {
        ...source.candidate,
        fixtures: fixtureIds.map((fixtureId, index) =>
          cloneFixture(candidateFixture, fixtureId, index === 0 ? "1" : "2"),
        ),
      },
      metrics: [
        {
          condition: "human_review_available",
          dimension: "human_review",
          kind: "assurance_state_count",
          label: "Available human review",
          metricId: "metric_missing_fixture",
          stratumId: "stratum_all",
          unit: "assurance_records",
        },
      ],
      strata: [
        {
          fixtureIds,
          label: "All requested fixtures",
          stratumId: "stratum_all",
        },
      ],
    });
    const baseline = snapshot(comparison, "baseline");
    const candidate = snapshot(comparison, "candidate", { includedFixtureIds: ["fixture_a"] });

    const result = deriveComparisonAssuranceMetrics({ baseline, candidate, comparison });
    expect(result.metricResults[0]).toMatchObject({
      samples: {
        baselineObservedCount: 2,
        baselineTotalCount: 2,
        candidateMissingCount: 1,
        candidateObservedCount: 1,
        candidateTotalCount: 2,
        pairedObservedCount: 1,
        pairedTotalCount: 1,
      },
      value: {
        baseline: exact(1),
        candidate: exact(1),
        delta: exact(0),
        direction: "unchanged",
        status: "available",
      },
    });
  });

  it("fails closed when assurance lineage is invalid", () => {
    const comparison = assuranceComparison();
    const baseline = snapshot(comparison, "baseline");
    const candidateFixture = comparison.candidate.fixtures[0];
    if (!candidateFixture) throw new Error("Expected a candidate fixture");
    const invalidAssurance = assuranceFor(candidateFixture).map((state) =>
      state.kind === "assessment"
        ? { ...state, reference: { ...state.reference, definitionSha256: sha("0") } }
        : state,
    );
    const candidate = snapshot(comparison, "candidate", {
      assurance: { fixture_login: invalidAssurance },
    });

    expect(
      deriveComparisonAssuranceMetrics({ baseline, candidate, comparison }).metricResults[0],
    ).toMatchObject({
      samples: {
        baselineInvalidCount: 1,
        candidateInvalidCount: 1,
        pairedObservedCount: 0,
        pairedTotalCount: 0,
      },
      value: {
        reasons: [
          "baseline_missing",
          "candidate_missing",
          "insufficient_observations",
          "invalid_observations",
        ],
        status: "unavailable",
      },
    });
  });

  it("ignores metric kinds outside assurance state counts", () => {
    const comparison = baseComparison();
    expect(
      deriveComparisonAssuranceMetrics({
        baseline: snapshot(comparison, "baseline"),
        candidate: snapshot(comparison, "candidate"),
        comparison,
      }),
    ).toEqual({ metricResults: [] });
  });
});
