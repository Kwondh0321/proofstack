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
import { deriveComparisonCoverageMetrics } from "./comparison-coverage-metrics.js";

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

const dimensions = ["abstention", "decided", "error", "observed"] as const;

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

function coverageComparison(): ComparisonDefinition {
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
    metrics: dimensions.map((dimension) => ({
      criterion,
      dimension,
      kind: "coverage_count",
      label: `${dimension} logical fixture coverage`,
      metricId: `metric_${dimension}`,
      stratumId: "stratum_all",
      unit: "cases",
    })),
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
  outcomeCounts: EvaluationOutcome["counts"],
  exactCriterion: EvaluationOutcome["criterion"] = criterion,
  assessmentIndex = 0,
): EvaluationOutcome {
  const assessment = subjectFixture.assessments[assessmentIndex];
  if (!assessment) throw new Error("Expected exact assessment reference");
  return { assessment, counts: outcomeCounts, criterion: exactCriterion };
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
    unit: "cases",
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

describe("criterion coverage comparison derivation", () => {
  it("derives all criterion coverage dimensions from logical paired fixtures", () => {
    const comparison = coverageComparison();
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: [outcome(fixture(comparison, "baseline", "fixture_a"), counts({ pass: 1 }))],
      fixture_b: [outcome(fixture(comparison, "baseline", "fixture_b"), counts({ error: 1 }))],
    });
    const candidate = snapshot(comparison, "candidate", {
      fixture_a: [outcome(fixture(comparison, "candidate", "fixture_a"), counts({ pass: 1 }))],
      fixture_b: [outcome(fixture(comparison, "candidate", "fixture_b"), counts({ abstain: 1 }))],
    });

    expect(deriveComparisonCoverageMetrics({ baseline, candidate, comparison })).toEqual({
      metricResults: [
        {
          kind: "coverage_count",
          metricId: "metric_abstention",
          samples: sampleCounts,
          unit: "cases",
          value: {
            baseline: exact("0"),
            candidate: exact("1"),
            delta: exact("1"),
            direction: "increased",
            status: "available",
          },
        },
        {
          kind: "coverage_count",
          metricId: "metric_decided",
          samples: sampleCounts,
          unit: "cases",
          value: {
            baseline: exact("1"),
            candidate: exact("1"),
            delta: exact("0"),
            direction: "unchanged",
            status: "available",
          },
        },
        {
          kind: "coverage_count",
          metricId: "metric_error",
          samples: sampleCounts,
          unit: "cases",
          value: {
            baseline: exact("1"),
            candidate: exact("0"),
            delta: exact("-1"),
            direction: "decreased",
            status: "available",
          },
        },
        {
          kind: "coverage_count",
          metricId: "metric_observed",
          samples: sampleCounts,
          unit: "cases",
          value: {
            baseline: exact("2"),
            candidate: exact("2"),
            delta: exact("0"),
            direction: "unchanged",
            status: "available",
          },
        },
      ],
    });
  });

  it("excludes a missing criterion outcome instead of treating it as zero", () => {
    const comparison = coverageComparison();
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: [outcome(fixture(comparison, "baseline", "fixture_a"), counts({ pass: 1 }))],
      fixture_b: [outcome(fixture(comparison, "baseline", "fixture_b"), counts({ pass: 1 }))],
    });
    const candidate = snapshot(comparison, "candidate", {
      fixture_a: [outcome(fixture(comparison, "candidate", "fixture_a"), counts({ pass: 1 }))],
    });

    const observed = deriveComparisonCoverageMetrics({
      baseline,
      candidate,
      comparison,
    }).metricResults.find(({ metricId }) => metricId === "metric_observed");
    expect(observed).toEqual({
      kind: "coverage_count",
      metricId: "metric_observed",
      samples: {
        ...sampleCounts,
        candidateMissingCount: 1,
        candidateObservedCount: 1,
        pairedMissingCount: 1,
        pairedObservedCount: 1,
      },
      unit: "cases",
      value: {
        baseline: exact("1"),
        candidate: exact("1"),
        delta: exact("0"),
        direction: "unchanged",
        status: "available",
      },
    });
  });

  it("returns explicit missing reasons when neither role retains the criterion", () => {
    const comparison = coverageComparison();
    const result = deriveComparisonCoverageMetrics({
      baseline: snapshot(comparison, "baseline"),
      candidate: snapshot(comparison, "candidate"),
      comparison,
    });

    expect(result.metricResults[0]).toMatchObject({
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
  });

  it("requires every component of the exact criterion reference", () => {
    const comparison = coverageComparison();
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: [outcome(fixture(comparison, "baseline", "fixture_a"), counts({ pass: 1 }))],
      fixture_b: [outcome(fixture(comparison, "baseline", "fixture_b"), counts({ pass: 1 }))],
    });
    const mismatchedCriteria: readonly EvaluationOutcome["criterion"][] = [
      { ...criterion, criterionId: "criterion_other" },
      { ...criterion, criterionSet: { ...criterion.criterionSet, criterionSetId: "other_set" } },
      {
        ...criterion,
        criterionSet: { ...criterion.criterionSet, criterionSetVersionId: "criteria_main_v2" },
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
            counts({ pass: 1 }),
            mismatchedCriterion,
          ),
        ],
      });
      const observed = deriveComparisonCoverageMetrics({
        baseline,
        candidate,
        comparison,
      }).metricResults.find(({ metricId }) => metricId === "metric_observed");
      expect(observed?.samples).toMatchObject({
        candidateMissingCount: 1,
        candidateObservedCount: 1,
        pairedMissingCount: 1,
        pairedObservedCount: 1,
      });
      expect(observed?.value).toMatchObject({
        baseline: exact("1"),
        candidate: exact("1"),
        status: "available",
      });
    }
  });

  it("fails closed when evaluation outcome lineage is invalid", () => {
    const comparison = coverageComparison();
    const invalidOutcomes = (role: "baseline" | "candidate") =>
      Object.fromEntries(
        ["fixture_a", "fixture_b"].map((fixtureId) => {
          const value = outcome(fixture(comparison, role, fixtureId), counts({ pass: 1 }));
          return [
            fixtureId,
            [{ ...value, assessment: { ...value.assessment, definitionSha256: sha("0") } }],
          ];
        }),
      );
    const result = deriveComparisonCoverageMetrics({
      baseline: snapshot(comparison, "baseline", invalidOutcomes("baseline")),
      candidate: snapshot(comparison, "candidate", invalidOutcomes("candidate")),
      comparison,
    });

    expect(result.metricResults[0]).toMatchObject({
      samples: {
        baselineInvalidCount: 2,
        candidateInvalidCount: 2,
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

  it("counts a logical fixture once when multiple assessments retain matching outcomes", () => {
    const source = baseComparison();
    const withSecondAssessment = (role: "baseline" | "candidate") => {
      const subject = source[role];
      const roleFixture = subject.fixtures[0];
      if (!roleFixture) throw new Error("Expected subject fixture");
      const first = roleFixture.assessments[0];
      if (!first) throw new Error("Expected assessment reference");
      return {
        ...subject,
        fixtures: [
          {
            ...roleFixture,
            assessments: [
              first,
              {
                assessmentId: `${first.assessmentId}_second`,
                definitionSha256: role === "baseline" ? sha("6") : sha("7"),
              },
            ],
          },
        ],
      };
    };
    const comparison = ComparisonDefinitionRecordSchema.parse({
      ...source,
      baseline: withSecondAssessment("baseline"),
      candidate: withSecondAssessment("candidate"),
      metrics: [
        {
          criterion,
          dimension: "observed",
          kind: "coverage_count",
          label: "Observed logical fixture coverage",
          metricId: "metric_observed",
          stratumId: "stratum_all",
          unit: "cases",
        },
      ],
    });
    const retained = (role: "baseline" | "candidate") => {
      const roleFixture = fixture(comparison, role, "fixture_login");
      return snapshot(comparison, role, {
        fixture_login: [
          outcome(roleFixture, counts({ pass: 1 }), criterion, 0),
          outcome(roleFixture, counts({ pass: 1 }), criterion, 1),
        ],
      });
    };

    expect(
      deriveComparisonCoverageMetrics({
        baseline: retained("baseline"),
        candidate: retained("candidate"),
        comparison,
      }).metricResults[0],
    ).toMatchObject({
      samples: {
        baselineObservedCount: 1,
        baselineTotalCount: 1,
        candidateObservedCount: 1,
        candidateTotalCount: 1,
        pairedObservedCount: 1,
        pairedTotalCount: 1,
      },
      value: {
        baseline: exact("1"),
        candidate: exact("1"),
        delta: exact("0"),
        status: "available",
      },
    });
  });

  it("ignores metric kinds outside criterion coverage counts", () => {
    const comparison = baseComparison();
    expect(
      deriveComparisonCoverageMetrics({
        baseline: snapshot(comparison, "baseline"),
        candidate: snapshot(comparison, "candidate"),
        comparison,
      }),
    ).toEqual({ metricResults: [] });
  });
});
