import { readFileSync } from "node:fs";
import {
  COMPARISON_DEFINITION_SCHEMA_VERSION,
  COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  type ComparisonDefinition,
  ComparisonDefinitionRecordSchema,
  type ComparisonEvidenceSnapshot,
  ComparisonEvidenceSnapshotSchema,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { ComparisonPairingError, pairComparisonEvidence } from "./comparison-pairing.js";

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

function comparison(): ComparisonDefinition {
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

function assuranceFor(subjectFixture: ComparisonDefinition["baseline"]["fixtures"][number]) {
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
      numericObservations: [],
      replay: value.replay,
      safetyEvents: [],
      trace: { eventCount: 0, eventKinds: [], eventStatuses: [] },
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

function cloneFixture(
  value: ComparisonDefinition["baseline"]["fixtures"][number],
  fixtureId: string,
  fixtureVersionId: string,
  digest: string,
) {
  return {
    ...structuredClone(value),
    assessments: [],
    fixture: { definitionSha256: sha(digest), fixtureId, fixtureVersionId },
    modelAssuranceAssessments: [],
    replay: {
      ...structuredClone(value.replay),
      attemptId: `attempt_${fixtureId}`,
      jobId: `job_${fixtureId}`,
      plan: {
        ...structuredClone(value.replay.plan),
        definitionSha256: sha(digest),
        planId: `plan_${fixtureId}`,
        planVersionId: `plan_${fixtureId}_v1`,
      },
      result: {
        ...structuredClone(value.replay.result),
        artifactId: `artifact_${fixtureId}`,
        sha256: sha(digest),
      },
      targetRelease: {
        ...structuredClone(value.replay.targetRelease),
        definitionSha256: sha(digest),
        targetReleaseId: `release_${fixtureId}`,
      },
    },
  };
}

function expectPairingError(action: () => unknown, code: ComparisonPairingError["code"]): void {
  try {
    action();
    throw new Error("Expected comparison pairing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ComparisonPairingError);
    expect((error as ComparisonPairingError).code).toBe(code);
  }
}

describe("exact comparison pairing", () => {
  it("pairs exact logical fixtures before aggregation", () => {
    const definition = comparison();
    const result = pairComparisonEvidence({
      baseline: snapshot(definition, "baseline"),
      candidate: snapshot(definition, "candidate"),
      comparison: definition,
    });
    expect(result).toEqual({
      cases: [
        {
          baseline: definition.baseline.fixtures[0]?.fixture,
          candidate: definition.candidate.fixtures[0]?.fixture,
          fixtureId: "fixture_login",
          state: "paired",
        },
      ],
      comparability: { reasons: [], status: "comparable" },
      pairing: {
        baselineOnlyCount: 0,
        candidateOnlyCount: 0,
        invalidCount: 0,
        pairedCount: 1,
        requestedCount: 1,
      },
    });
  });

  it("makes changed fixture versions visible as partial comparability", () => {
    const source = comparison();
    const candidateFixture = source.candidate.fixtures[0];
    if (!candidateFixture) throw new Error("Expected candidate fixture");
    const definition = ComparisonDefinitionRecordSchema.parse({
      ...source,
      candidate: {
        ...source.candidate,
        fixtures: [cloneFixture(candidateFixture, "fixture_login", "fixture_login_v2", "a")],
      },
    });
    const result = pairComparisonEvidence({
      baseline: snapshot(definition, "baseline"),
      candidate: snapshot(definition, "candidate"),
      comparison: definition,
    });
    expect(result.cases[0]?.state).toBe("paired");
    expect(result.comparability).toEqual({
      reasons: ["fixture_mismatch"],
      status: "partially_comparable",
    });
  });

  it("preserves baseline-only, candidate-only, and omitted evidence separately", () => {
    const source = comparison();
    const baselineFixture = source.baseline.fixtures[0];
    const candidateFixture = source.candidate.fixtures[0];
    if (!baselineFixture || !candidateFixture) throw new Error("Expected subject fixtures");
    const definition = ComparisonDefinitionRecordSchema.parse({
      ...source,
      baseline: {
        ...source.baseline,
        fixtures: [
          cloneFixture(baselineFixture, "fixture_baseline_only", "fixture_baseline_v1", "1"),
          baselineFixture,
        ],
      },
      candidate: {
        ...source.candidate,
        fixtures: [
          cloneFixture(candidateFixture, "fixture_candidate_only", "fixture_candidate_v1", "2"),
          candidateFixture,
        ],
      },
    });
    const baseline = snapshot(definition, "baseline");
    const candidate = snapshot(definition, "candidate");
    const result = pairComparisonEvidence({ baseline, candidate, comparison: definition });
    expect(result.cases.map(({ state }) => state)).toEqual([
      "baseline_only",
      "candidate_only",
      "paired",
    ]);
    expect(result.pairing).toEqual({
      baselineOnlyCount: 1,
      candidateOnlyCount: 1,
      invalidCount: 0,
      pairedCount: 1,
      requestedCount: 3,
    });

    const omitted = ComparisonEvidenceSnapshotSchema.parse({
      ...baseline,
      fixtures: baseline.fixtures.slice(0, 1),
    });
    const omittedResult = pairComparisonEvidence({
      baseline: omitted,
      candidate,
      comparison: definition,
    });
    expect(
      omittedResult.cases.find(({ fixtureId }) => fixtureId === "fixture_login"),
    ).toMatchObject({
      baselineMissingReason: "snapshot_omission",
      state: "candidate_only",
    });

    const missingBoth = ComparisonEvidenceSnapshotSchema.parse({
      ...baseline,
      fixtures: baseline.fixtures.slice(1),
    });
    expect(
      pairComparisonEvidence({
        baseline: missingBoth,
        candidate,
        comparison: definition,
      }).cases[0],
    ).toMatchObject({ reasons: ["unresolved_lineage"], state: "invalid" });
  });

  it("enforces the declared paired coverage with exact basis-point arithmetic", () => {
    const source = comparison();
    const baselineFixture = source.baseline.fixtures[0];
    const candidateFixture = source.candidate.fixtures[0];
    if (!baselineFixture || !candidateFixture) throw new Error("Expected subject fixtures");
    const threeCaseDefinition = ComparisonDefinitionRecordSchema.parse({
      ...source,
      baseline: {
        ...source.baseline,
        fixtures: [
          cloneFixture(baselineFixture, "fixture_baseline_only", "fixture_baseline_v1", "1"),
          baselineFixture,
        ],
      },
      candidate: {
        ...source.candidate,
        fixtures: [
          cloneFixture(candidateFixture, "fixture_candidate_only", "fixture_candidate_v1", "2"),
          candidateFixture,
        ],
      },
      calculationPolicy: {
        ...source.calculationPolicy,
        minimumPairedCoverageBasisPoints: 3_334,
      },
    });
    const strictResult = pairComparisonEvidence({
      baseline: snapshot(threeCaseDefinition, "baseline"),
      candidate: snapshot(threeCaseDefinition, "candidate"),
      comparison: threeCaseDefinition,
    });
    expect(strictResult.pairing).toMatchObject({ pairedCount: 1, requestedCount: 3 });
    expect(strictResult.comparability.reasons).toContain("insufficient_paired_coverage");

    const relaxedDefinition = ComparisonDefinitionRecordSchema.parse({
      ...threeCaseDefinition,
      calculationPolicy: {
        ...threeCaseDefinition.calculationPolicy,
        minimumPairedCoverageBasisPoints: 3_333,
      },
    });
    const relaxedResult = pairComparisonEvidence({
      baseline: snapshot(relaxedDefinition, "baseline"),
      candidate: snapshot(relaxedDefinition, "candidate"),
      comparison: relaxedDefinition,
    });
    expect(relaxedResult.comparability.reasons).not.toContain("insufficient_paired_coverage");
  });

  it("marks digest and lineage corruption invalid instead of pairing it", () => {
    const definition = comparison();
    const baseline = snapshot(definition, "baseline");
    const fixture = baseline.fixtures[0];
    if (!fixture) throw new Error("Expected snapshot fixture");
    const corrupted = ComparisonEvidenceSnapshotSchema.parse({
      ...baseline,
      fixtures: [
        {
          ...fixture,
          fixture: { ...fixture.fixture, definitionSha256: sha("0") },
          replay: { ...fixture.replay, jobId: "job_corrupted" },
        },
      ],
    });
    const result = pairComparisonEvidence({
      baseline: corrupted,
      candidate: snapshot(definition, "candidate"),
      comparison: definition,
    });
    expect(result.cases[0]).toMatchObject({
      reasons: ["digest_mismatch", "unresolved_lineage"],
      state: "invalid",
    });
    expect(result.comparability).toEqual({
      reasons: ["insufficient_paired_coverage", "invalid_source_integrity"],
      status: "incomparable",
    });

    const versionMismatch = ComparisonEvidenceSnapshotSchema.parse({
      ...baseline,
      fixtures: [
        {
          ...fixture,
          fixture: { ...fixture.fixture, fixtureVersionId: "fixture_login_wrong" },
        },
      ],
    });
    expect(
      pairComparisonEvidence({
        baseline: versionMismatch,
        candidate: snapshot(definition, "candidate"),
        comparison: definition,
      }).cases[0],
    ).toMatchObject({ reasons: ["unresolved_lineage"], state: "invalid" });

    const missingAssurance = ComparisonEvidenceSnapshotSchema.parse({
      ...baseline,
      fixtures: [{ ...fixture, assurance: [] }],
    });
    expect(
      pairComparisonEvidence({
        baseline: missingAssurance,
        candidate: snapshot(definition, "candidate"),
        comparison: definition,
      }).cases[0],
    ).toMatchObject({ reasons: ["unresolved_lineage"], state: "invalid" });
  });

  it("marks exact dataset changes and zero-overlap fixture sets incomparable", () => {
    const source = comparison();
    const baselineFixture = source.baseline.fixtures[0];
    const candidateFixture = source.candidate.fixtures[0];
    if (!baselineFixture || !candidateFixture) throw new Error("Expected subject fixtures");
    const definition = ComparisonDefinitionRecordSchema.parse({
      ...source,
      baseline: {
        ...source.baseline,
        fixtures: [cloneFixture(baselineFixture, "fixture_alpha", "fixture_alpha_v1", "1")],
      },
      candidate: {
        ...source.candidate,
        dataset: {
          ...source.candidate.dataset,
          datasetVersionId: "dataset_reference_v2",
          definitionSha256: sha("2"),
        },
        fixtures: [cloneFixture(candidateFixture, "fixture_beta", "fixture_beta_v1", "2")],
      },
      strata: [{ ...source.strata[0], fixtureIds: ["fixture_alpha", "fixture_beta"] }],
    });
    const result = pairComparisonEvidence({
      baseline: snapshot(definition, "baseline"),
      candidate: snapshot(definition, "candidate"),
      comparison: definition,
    });
    expect(result.comparability).toEqual({
      reasons: ["dataset_mismatch", "insufficient_paired_coverage", "missing_source_evidence"],
      status: "incomparable",
    });
  });

  it("rejects role, scope, definition, dataset, and unexpected-fixture substitution", () => {
    const definition = comparison();
    const baseline = snapshot(definition, "baseline");
    const candidate = snapshot(definition, "candidate");
    expectPairingError(
      () => pairComparisonEvidence({ baseline: {} as never, candidate, comparison: definition }),
      "invalid_evidence_snapshot",
    );
    expectPairingError(
      () => pairComparisonEvidence({ baseline, candidate, comparison: {} as never }),
      "invalid_comparison_definition",
    );
    expectPairingError(
      () => pairComparisonEvidence({ baseline: candidate, candidate, comparison: definition }),
      "role_mismatch",
    );
    expectPairingError(
      () =>
        pairComparisonEvidence({
          baseline: { ...baseline, scope: { ...baseline.scope, tenantId: "tenant_other" } },
          candidate,
          comparison: definition,
        }),
      "scope_mismatch",
    );
    expectPairingError(
      () =>
        pairComparisonEvidence({
          baseline: {
            ...baseline,
            comparison: { ...baseline.comparison, definitionSha256: sha("0") },
          },
          candidate,
          comparison: definition,
        }),
      "comparison_reference_mismatch",
    );
    expectPairingError(
      () =>
        pairComparisonEvidence({
          baseline: { ...baseline, dataset: { ...baseline.dataset, definitionSha256: sha("0") } },
          candidate,
          comparison: definition,
        }),
      "dataset_reference_mismatch",
    );
    const fixture = baseline.fixtures[0];
    if (!fixture) throw new Error("Expected snapshot fixture");
    expectPairingError(
      () =>
        pairComparisonEvidence({
          baseline: {
            ...baseline,
            fixtures: [
              fixture,
              { ...fixture, fixture: { ...fixture.fixture, fixtureId: "fixture_unexpected" } },
            ],
          },
          candidate,
          comparison: definition,
        }),
      "snapshot_subject_mismatch",
    );
    expectPairingError(
      () =>
        pairComparisonEvidence({
          baseline,
          candidate: { ...candidate, snapshotId: baseline.snapshotId },
          comparison: definition,
        }),
      "snapshot_subject_mismatch",
    );
  });
});
