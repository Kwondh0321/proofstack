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
import { deriveComparisonVerdictTransitions } from "./comparison-verdict-transitions.js";

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
  assessments: SubjectFixture["assessments"],
): SubjectFixture {
  return {
    ...structuredClone(source),
    assessments: structuredClone(assessments),
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

function verdictComparison(
  fixtureIds: readonly string[] = ["fixture_a", "fixture_b"],
): ComparisonDefinition {
  const source = baseComparison();
  const baselineSource = source.baseline.fixtures[0];
  const candidateSource = source.candidate.fixtures[0];
  if (!baselineSource || !candidateSource) throw new Error("Expected subject fixtures");
  const assessments = baselineSource.assessments;
  const fixtures = (roleSource: SubjectFixture, role: "baseline" | "candidate") =>
    fixtureIds.map((fixtureId, index) =>
      cloneFixture(
        roleSource,
        fixtureId,
        role === "baseline" ? `${index + 1}` : `${index + 5}`,
        assessments,
      ),
    );
  return ComparisonDefinitionRecordSchema.parse({
    ...source,
    baseline: { ...source.baseline, fixtures: fixtures(baselineSource, "baseline") },
    candidate: { ...source.candidate, fixtures: fixtures(candidateSource, "candidate") },
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
        fixtureIds,
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
  value: EvaluationOutcome["counts"],
  exactCriterion: EvaluationOutcome["criterion"] = criterion,
): EvaluationOutcome {
  const assessment = subjectFixture.assessments[0];
  if (!assessment) throw new Error("Expected exact assessment reference");
  return { assessment, counts: value, criterion: exactCriterion };
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

describe("comparison verdict transition derivation", () => {
  it("derives complete marginals and every mathematically unique transition", () => {
    const comparison = verdictComparison(["fixture_a", "fixture_b", "fixture_c"]);
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: [outcome(fixture(comparison, "baseline", "fixture_a"), counts({ fail: 2 }))],
      fixture_b: [
        outcome(fixture(comparison, "baseline", "fixture_b"), counts({ error: 1, pass: 1 })),
      ],
      fixture_c: [outcome(fixture(comparison, "baseline", "fixture_c"), counts({ fail: 1 }))],
    });
    const candidate = snapshot(comparison, "candidate", {
      fixture_a: [outcome(fixture(comparison, "candidate", "fixture_a"), counts({ pass: 2 }))],
      fixture_b: [outcome(fixture(comparison, "candidate", "fixture_b"), counts({ fail: 2 }))],
      fixture_c: [outcome(fixture(comparison, "candidate", "fixture_c"), counts({ pass: 1 }))],
    });

    expect(deriveComparisonVerdictTransitions({ baseline, candidate, comparison })).toEqual({
      verdictMarginals: [
        {
          baseline: { abstain: 0, error: 1, fail: 3, notApplicable: 0, pass: 1, total: 5 },
          candidate: { abstain: 0, error: 0, fail: 2, notApplicable: 0, pass: 3, total: 5 },
          criterion,
          transition: { pairedCount: 5, status: "available" },
        },
      ],
      verdictTransitions: [
        { baseline: "error", candidate: "fail", count: 1, criterion },
        { baseline: "fail", candidate: "pass", count: 3, criterion },
        { baseline: "pass", candidate: "fail", count: 1, criterion },
      ],
    });
  });

  it("keeps aggregate marginals but refuses a non-unique transition matrix", () => {
    const comparison = verdictComparison(["fixture_a"]);
    const mixed = (role: "baseline" | "candidate") =>
      snapshot(comparison, role, {
        fixture_a: [outcome(fixture(comparison, role, "fixture_a"), counts({ fail: 1, pass: 1 }))],
      });

    expect(
      deriveComparisonVerdictTransitions({
        baseline: mixed("baseline"),
        candidate: mixed("candidate"),
        comparison,
      }),
    ).toEqual({
      verdictMarginals: [
        {
          baseline: { abstain: 0, error: 0, fail: 1, notApplicable: 0, pass: 1, total: 2 },
          candidate: { abstain: 0, error: 0, fail: 1, notApplicable: 0, pass: 1, total: 2 },
          criterion,
          transition: { reasons: ["ambiguous_aggregate_pairing"], status: "unavailable" },
        },
      ],
      verdictTransitions: [],
    });
  });

  it("reports missing, mismatched assessment, and unequal-count evidence without partial transitions", () => {
    const source = verdictComparison(["fixture_a", "fixture_b", "fixture_c"]);
    const candidateFixtures = source.candidate.fixtures.map((value) =>
      value.fixture.fixtureId === "fixture_b"
        ? {
            ...value,
            assessments: [{ assessmentId: "assessment_other", definitionSha256: sha("9") }],
          }
        : value,
    );
    const comparison = ComparisonDefinitionRecordSchema.parse({
      ...source,
      candidate: { ...source.candidate, fixtures: candidateFixtures },
    });
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: [outcome(fixture(comparison, "baseline", "fixture_a"), counts({ fail: 1 }))],
      fixture_b: [outcome(fixture(comparison, "baseline", "fixture_b"), counts({ fail: 1 }))],
      fixture_c: [outcome(fixture(comparison, "baseline", "fixture_c"), counts({ fail: 2 }))],
    });
    const candidate = snapshot(comparison, "candidate", {
      fixture_b: [outcome(fixture(comparison, "candidate", "fixture_b"), counts({ pass: 1 }))],
      fixture_c: [outcome(fixture(comparison, "candidate", "fixture_c"), counts({ pass: 1 }))],
    });

    const result = deriveComparisonVerdictTransitions({ baseline, candidate, comparison });
    expect(result.verdictTransitions).toEqual([]);
    expect(result.verdictMarginals[0]).toMatchObject({
      baseline: { fail: 4, total: 4 },
      candidate: { pass: 2, total: 2 },
      transition: {
        reasons: ["assessment_mismatch", "missing_paired_evidence", "outcome_count_mismatch"],
        status: "unavailable",
      },
    });
  });

  it("rejects partial transitions when an exact-criterion case is invalid", () => {
    const comparison = verdictComparison();
    const originalBaseline = snapshot(comparison, "baseline", {
      fixture_b: [outcome(fixture(comparison, "baseline", "fixture_b"), counts({ pass: 1 }))],
    });
    const candidate = snapshot(comparison, "candidate", {
      fixture_a: [outcome(fixture(comparison, "candidate", "fixture_a"), counts({ pass: 1 }))],
      fixture_b: [outcome(fixture(comparison, "candidate", "fixture_b"), counts({ pass: 1 }))],
    });
    const invalidBaseline = ComparisonEvidenceSnapshotSchema.parse({
      ...originalBaseline,
      fixtures: originalBaseline.fixtures.map((value) =>
        value.fixture.fixtureId === "fixture_a"
          ? { ...value, fixture: { ...value.fixture, definitionSha256: sha("9") } }
          : value,
      ),
    });

    const result = deriveComparisonVerdictTransitions({
      baseline: invalidBaseline,
      candidate,
      comparison,
    });
    expect(result.verdictTransitions).toEqual([]);
    expect(result.verdictMarginals[0]?.transition).toEqual({
      reasons: ["invalid_paired_evidence"],
      status: "unavailable",
    });
  });

  it("retains an exact observed zero and returns no summaries without criterion evidence", () => {
    const comparison = verdictComparison(["fixture_a"]);
    const zero = (role: "baseline" | "candidate") =>
      snapshot(comparison, role, {
        fixture_a: [outcome(fixture(comparison, role, "fixture_a"), counts())],
      });
    expect(
      deriveComparisonVerdictTransitions({
        baseline: zero("baseline"),
        candidate: zero("candidate"),
        comparison,
      }).verdictMarginals[0]?.transition,
    ).toEqual({ pairedCount: 0, status: "available" });
    expect(
      deriveComparisonVerdictTransitions({
        baseline: snapshot(comparison, "baseline"),
        candidate: snapshot(comparison, "candidate"),
        comparison,
      }),
    ).toEqual({ verdictMarginals: [], verdictTransitions: [] });
  });

  it("orders exact criteria canonically and keeps their transitions isolated", () => {
    const comparison = verdictComparison(["fixture_a"]);
    const criteria = [
      { ...criterion, criterionId: "criterion_alpha" },
      { ...criterion, criterionId: "criterion_zulu" },
    ] as const;
    const observed = (role: "baseline" | "candidate") =>
      snapshot(comparison, role, {
        fixture_a: criteria.map((exactCriterion, index) =>
          outcome(
            fixture(comparison, role, "fixture_a"),
            role === "baseline"
              ? index === 0
                ? counts({ abstain: 1 })
                : counts({ error: 1 })
              : index === 0
                ? counts({ notApplicable: 1 })
                : counts({ pass: 1 }),
            exactCriterion,
          ),
        ),
      });

    const result = deriveComparisonVerdictTransitions({
      baseline: observed("baseline"),
      candidate: observed("candidate"),
      comparison,
    });
    expect(result.verdictMarginals.map(({ criterion: value }) => value.criterionId)).toEqual([
      "criterion_alpha",
      "criterion_zulu",
    ]);
    expect(
      result.verdictTransitions.map(({ baseline, candidate, criterion: value }) => ({
        baseline,
        candidate,
        criterionId: value.criterionId,
      })),
    ).toEqual([
      { baseline: "abstain", candidate: "not_applicable", criterionId: "criterion_alpha" },
      { baseline: "error", candidate: "pass", criterionId: "criterion_zulu" },
    ]);
  });

  it("fails closed when the result criterion bound is exceeded", () => {
    const comparison = verdictComparison();
    const criteria = Array.from({ length: 129 }, (_, index) => ({
      ...criterion,
      criterionId: `criterion_${index.toString().padStart(3, "0")}`,
    }));
    const excessive = (role: "baseline" | "candidate") =>
      snapshot(comparison, role, {
        fixture_a: criteria
          .slice(0, 128)
          .map((exactCriterion) =>
            outcome(fixture(comparison, role, "fixture_a"), counts({ pass: 1 }), exactCriterion),
          ),
        fixture_b: [
          outcome(fixture(comparison, role, "fixture_b"), counts({ pass: 1 }), criteria[128]),
        ],
      });

    expect(() =>
      deriveComparisonVerdictTransitions({
        baseline: excessive("baseline"),
        candidate: excessive("candidate"),
        comparison,
      }),
    ).toThrowError(/128-criterion result bound/);
  });

  it("fails closed when accumulated exact counts exceed JavaScript's safe range", () => {
    const comparison = verdictComparison();
    const maximum = counts({ fail: Number.MAX_SAFE_INTEGER });
    const excessive = (role: "baseline" | "candidate") =>
      snapshot(comparison, role, {
        fixture_a: [outcome(fixture(comparison, role, "fixture_a"), maximum)],
        fixture_b: [outcome(fixture(comparison, role, "fixture_b"), maximum)],
      });

    expect(() =>
      deriveComparisonVerdictTransitions({
        baseline: excessive("baseline"),
        candidate: excessive("candidate"),
        comparison,
      }),
    ).toThrowError(RangeError);
  });
});
