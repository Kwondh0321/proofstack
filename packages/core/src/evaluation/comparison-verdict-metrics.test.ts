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
import { ComparisonPairingError } from "./comparison-pairing.js";
import { deriveComparisonVerdictMetrics } from "./comparison-verdict-metrics.js";

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
type EvaluationOutcome = ComparisonEvidenceFixtureSnapshot["evaluationOutcomes"][number];

const criterion = {
  criterionId: "criterion_login",
  criterionSet: {
    criterionSetId: "criteria_main",
    criterionSetVersionId: "criteria_main_v1",
    definitionSha256: sha("e"),
  },
} as const;

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
    ...structuredClone(source),
    fixture: {
      definitionSha256: sha(definitionDigestCharacter),
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

function verdictComparison(): ComparisonDefinition {
  const source = baseComparison();
  const baselineFixture = source.baseline.fixtures[0];
  const candidateFixture = source.candidate.fixtures[0];
  if (!baselineFixture || !candidateFixture) throw new Error("Expected subject fixtures");
  const identities = [
    ["fixture_a", "1"],
    ["fixture_b", "2"],
  ] as const;
  const fixtures = (roleFixture: SubjectFixture) =>
    identities.map(([fixtureId, digest]) => cloneFixture(roleFixture, fixtureId, digest));
  return ComparisonDefinitionRecordSchema.parse({
    ...source,
    baseline: { ...source.baseline, fixtures: fixtures(baselineFixture) },
    candidate: { ...source.candidate, fixtures: fixtures(candidateFixture) },
    metrics: [
      {
        criterion,
        kind: "evaluation_verdict_count",
        label: "Failed exact login evaluations",
        metricId: "metric_failures",
        stratumId: "stratum_all",
        unit: "evaluation_outcomes",
        verdict: "fail",
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

function outcome(
  subjectFixture: SubjectFixture,
  counts: EvaluationOutcome["counts"],
  exactCriterion: EvaluationOutcome["criterion"] = criterion,
): EvaluationOutcome {
  const assessment = subjectFixture.assessments[0];
  if (!assessment) throw new Error("Expected exact assessment reference");
  return { assessment, counts, criterion: exactCriterion };
}

function counts(values: Partial<EvaluationOutcome["counts"]> = {}): EvaluationOutcome["counts"] {
  const result = {
    abstain: values.abstain ?? 0,
    error: values.error ?? 0,
    fail: values.fail ?? 0,
    notApplicable: values.notApplicable ?? 0,
    pass: values.pass ?? 0,
  };
  return { ...result, total: Object.values(result).reduce((sum, value) => sum + value, 0) };
}

function snapshot(
  source: ComparisonDefinition,
  role: "baseline" | "candidate",
  outcomes: Readonly<Record<string, readonly EvaluationOutcome[]>> = {},
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
      evaluationOutcomes: outcomes[value.fixture.fixtureId] ?? [],
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

function fixture(comparison: ComparisonDefinition, role: "baseline" | "candidate", id: string) {
  const value = comparison[role].fixtures.find(({ fixture }) => fixture.fixtureId === id);
  if (!value) throw new Error(`Expected ${role} fixture ${id}`);
  return value;
}

function exact(numerator: string) {
  return {
    denominator: "1",
    numerator,
    representation: "rational" as const,
    unit: "evaluation_outcomes",
  };
}

const sampleCounts = {
  baselineInvalidCount: 0,
  baselineMissingCount: 0,
  baselineObservedCount: 2,
  baselineTotalCount: 2,
  baselineUnavailableCount: 0,
  candidateInvalidCount: 0,
  candidateMissingCount: 0,
  candidateObservedCount: 2,
  candidateTotalCount: 2,
  candidateUnavailableCount: 0,
  pairedInvalidCount: 0,
  pairedMissingCount: 0,
  pairedObservedCount: 2,
  pairedTotalCount: 2,
  pairedUnavailableCount: 0,
};

describe("evaluation verdict comparison derivation", () => {
  it("counts only the requested verdict across exact paired criterion outcomes", () => {
    const comparison = verdictComparison();
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: [
        outcome(fixture(comparison, "baseline", "fixture_a"), counts({ fail: 1, pass: 2 })),
      ],
      fixture_b: [outcome(fixture(comparison, "baseline", "fixture_b"), counts({ pass: 1 }))],
    });
    const candidate = snapshot(comparison, "candidate", {
      fixture_a: [outcome(fixture(comparison, "candidate", "fixture_a"), counts({ pass: 3 }))],
      fixture_b: [
        outcome(fixture(comparison, "candidate", "fixture_b"), counts({ error: 1, fail: 2 })),
      ],
    });

    expect(deriveComparisonVerdictMetrics({ baseline, candidate, comparison })).toEqual({
      metricResults: [
        {
          kind: "evaluation_verdict_count",
          metricId: "metric_failures",
          samples: sampleCounts,
          unit: "evaluation_outcomes",
          value: {
            baseline: exact("1"),
            candidate: exact("2"),
            delta: exact("1"),
            direction: "increased",
            status: "available",
          },
        },
      ],
    });
  });

  it("keeps exact zero verdict counts available", () => {
    const comparison = verdictComparison();
    const noFailures = (role: "baseline" | "candidate") =>
      snapshot(comparison, role, {
        fixture_a: [outcome(fixture(comparison, role, "fixture_a"), counts({ pass: 1 }))],
        fixture_b: [outcome(fixture(comparison, role, "fixture_b"), counts())],
      });

    expect(
      deriveComparisonVerdictMetrics({
        baseline: noFailures("baseline"),
        candidate: noFailures("candidate"),
        comparison,
      }).metricResults[0],
    ).toMatchObject({
      samples: sampleCounts,
      value: {
        baseline: exact("0"),
        candidate: exact("0"),
        delta: exact("0"),
        direction: "unchanged",
        status: "available",
      },
    });
  });

  it("maps every verdict spelling to its exact retained count", () => {
    const source = verdictComparison();
    const verdicts = ["abstain", "error", "fail", "not_applicable", "pass"] as const;
    const comparison = ComparisonDefinitionRecordSchema.parse({
      ...source,
      metrics: verdicts.map((verdict) => ({
        criterion,
        kind: "evaluation_verdict_count" as const,
        label: `${verdict} exact login evaluations`,
        metricId: `metric_${verdict}`,
        stratumId: "stratum_all",
        unit: "evaluation_outcomes" as const,
        verdict,
      })),
    });
    const baselineCounts = counts({
      abstain: 1,
      error: 2,
      fail: 3,
      notApplicable: 4,
      pass: 5,
    });
    const observed = (role: "baseline" | "candidate", first: EvaluationOutcome["counts"]) =>
      snapshot(comparison, role, {
        fixture_a: [outcome(fixture(comparison, role, "fixture_a"), first)],
        fixture_b: [outcome(fixture(comparison, role, "fixture_b"), counts())],
      });

    const results = deriveComparisonVerdictMetrics({
      baseline: observed("baseline", baselineCounts),
      candidate: observed("candidate", counts()),
      comparison,
    }).metricResults;
    expect(
      results.map(({ metricId, value }) => ({
        baseline:
          value.status === "available" && value.baseline.representation === "rational"
            ? value.baseline.numerator
            : undefined,
        metricId,
      })),
    ).toEqual([
      { baseline: "1", metricId: "metric_abstain" },
      { baseline: "2", metricId: "metric_error" },
      { baseline: "3", metricId: "metric_fail" },
      { baseline: "4", metricId: "metric_not_applicable" },
      { baseline: "5", metricId: "metric_pass" },
    ]);
  });

  it("does not conflate a criterion digest mismatch with an observed zero", () => {
    const comparison = verdictComparison();
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: [outcome(fixture(comparison, "baseline", "fixture_a"), counts({ fail: 1 }))],
      fixture_b: [outcome(fixture(comparison, "baseline", "fixture_b"), counts({ fail: 2 }))],
    });
    const mismatchedCriteria: readonly EvaluationOutcome["criterion"][] = [
      { ...criterion, criterionId: "criterion_other" },
      {
        ...criterion,
        criterionSet: { ...criterion.criterionSet, criterionSetId: "criteria_other" },
      },
      {
        ...criterion,
        criterionSet: {
          ...criterion.criterionSet,
          criterionSetVersionId: "criteria_main_v2",
        },
      },
      {
        ...criterion,
        criterionSet: { ...criterion.criterionSet, definitionSha256: sha("9") },
      },
    ];
    for (const mismatchedCriterion of mismatchedCriteria) {
      const candidate = snapshot(comparison, "candidate", {
        fixture_a: [outcome(fixture(comparison, "candidate", "fixture_a"), counts({ pass: 1 }))],
        fixture_b: [
          outcome(
            fixture(comparison, "candidate", "fixture_b"),
            counts({ fail: 5 }),
            mismatchedCriterion,
          ),
        ],
      });

      expect(
        deriveComparisonVerdictMetrics({ baseline, candidate, comparison }).metricResults[0],
      ).toEqual({
        kind: "evaluation_verdict_count",
        metricId: "metric_failures",
        samples: {
          ...sampleCounts,
          candidateMissingCount: 1,
          candidateObservedCount: 1,
          pairedMissingCount: 1,
          pairedObservedCount: 1,
        },
        unit: "evaluation_outcomes",
        value: {
          baseline: exact("1"),
          candidate: exact("0"),
          delta: exact("-1"),
          direction: "decreased",
          status: "available",
        },
      });
    }
  });

  it("returns explicit missing reasons and rejects malformed envelopes", () => {
    const comparison = verdictComparison();
    const missing = deriveComparisonVerdictMetrics({
      baseline: snapshot(comparison, "baseline"),
      candidate: snapshot(comparison, "candidate"),
      comparison,
    });
    expect(missing.metricResults[0]).toMatchObject({
      samples: {
        baselineMissingCount: 2,
        baselineObservedCount: 0,
        candidateMissingCount: 2,
        candidateObservedCount: 0,
        pairedMissingCount: 2,
        pairedObservedCount: 0,
      },
      value: {
        reasons: ["baseline_missing", "candidate_missing", "insufficient_observations"],
        status: "unavailable",
      },
    });

    const originalBaseline = snapshot(comparison, "baseline");
    const corruptedBaseline = ComparisonEvidenceSnapshotSchema.parse({
      ...originalBaseline,
      fixtures: originalBaseline.fixtures.map((value, index) =>
        index === 0
          ? {
              ...value,
              fixture: { ...value.fixture, definitionSha256: sha("9") },
            }
          : value,
      ),
    });
    expect(
      deriveComparisonVerdictMetrics({
        baseline: corruptedBaseline,
        candidate: snapshot(comparison, "candidate"),
        comparison,
      }).metricResults[0],
    ).toMatchObject({
      samples: {
        baselineInvalidCount: 1,
        candidateInvalidCount: 1,
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

    const source = baseComparison();
    expect(
      deriveComparisonVerdictMetrics({
        baseline: snapshot(source, "baseline"),
        candidate: snapshot(source, "candidate"),
        comparison: source,
      }),
    ).toEqual({ metricResults: [] });

    const invalidCandidate = {
      ...snapshot(comparison, "candidate"),
      role: "baseline",
    } as unknown as ComparisonEvidenceSnapshot;
    expect(() =>
      deriveComparisonVerdictMetrics({
        baseline: snapshot(comparison, "baseline"),
        candidate: invalidCandidate,
        comparison,
      }),
    ).toThrowError(ComparisonPairingError);
  });
});
