import { readFileSync } from "node:fs";
import {
  COMPARISON_DEFINITION_SCHEMA_VERSION,
  COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  type ComparisonDefinition,
  ComparisonDefinitionRecordSchema,
  type ComparisonEvidenceFixtureSnapshot,
  type ComparisonEvidenceSnapshot,
  ComparisonEvidenceSnapshotSchema,
  MAX_COMPARISON_ARTIFACTS,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  type ComparisonArtifactDerivationError,
  deriveComparisonArtifactMetrics,
} from "./comparison-artifact-metrics.js";
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
type ArtifactState = ComparisonEvidenceFixtureSnapshot["artifacts"][number];

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

function artifactComparison(metricCount = 1): ComparisonDefinition {
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
    metrics: Array.from({ length: metricCount }, (_, index) => ({
      kind: "artifact_set",
      label: `Retained artifacts ${index + 1}`,
      metricId: `metric_artifacts_${index + 1}`,
      projection: "identity_digest_size_classification_availability",
      stratumId: "stratum_all",
      unit: "artifacts",
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

function artifact(
  artifactId: string,
  digestCharacter: string,
  availability: ArtifactState["availability"] = "available",
  overrides: Partial<ArtifactState["artifact"]> = {},
): ArtifactState {
  return {
    artifact: {
      artifactId,
      classification: "internal",
      mediaType: "application/json",
      sha256: sha(digestCharacter),
      sizeBytes: 128,
      ...overrides,
    },
    availability,
  };
}

function snapshot(
  source: ComparisonDefinition,
  role: "baseline" | "candidate",
  artifacts: Readonly<Record<string, readonly ArtifactState[]>> = {},
): ComparisonEvidenceSnapshot {
  const fixtures = source[role].fixtures.map((value) => ({
    artifacts: artifacts[value.fixture.fixtureId] ?? [],
    assurance: assuranceFor(value),
    evaluationOutcomes: [],
    fixture: value.fixture,
    numericObservations: [],
    replay: value.replay,
    safetyEvents: [],
    trace: { eventCount: 0, eventKinds: [], eventKindStatuses: [], eventStatuses: [] },
    usage: [],
  }));
  const omissions = fixtures
    .flatMap((fixture) =>
      fixture.artifacts
        .filter(({ availability }) => availability !== "available")
        .map(({ artifact: reference, availability }) => ({
          artifactId: reference.artifactId,
          fixtureId: fixture.fixture.fixtureId,
          reason: availability === "revoked" ? "artifact_revoked" : "artifact_unavailable",
          sourceKind: "artifact" as const,
        })),
    )
    .sort((left, right) =>
      `${left.fixtureId}:${left.artifactId}`.localeCompare(
        `${right.fixtureId}:${right.artifactId}`,
      ),
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
    fixtures,
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

function exact(numerator: string) {
  return {
    denominator: "1",
    numerator,
    representation: "rational" as const,
    unit: "artifacts",
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

describe("artifact comparison derivation", () => {
  it("derives exact set counts and every metadata-only change state", () => {
    const comparison = artifactComparison();
    const unchanged = artifact("artifact_unchanged", "1");
    const baselineChanged = artifact("artifact_changed", "2", "available", { sizeBytes: 10 });
    const candidateChanged = artifact("artifact_changed", "3", "available", {
      classification: "confidential",
      sizeBytes: 20,
    });
    const removed = artifact("artifact_removed", "4");
    const added = artifact("artifact_added", "5");
    const baselineUnavailable = artifact("artifact_unavailable", "6");
    const candidateUnavailable = artifact("artifact_unavailable", "6", "revoked");
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: [baselineChanged, removed].sort((left, right) =>
        left.artifact.artifactId.localeCompare(right.artifact.artifactId),
      ),
      fixture_b: [unchanged, baselineUnavailable].sort((left, right) =>
        left.artifact.artifactId.localeCompare(right.artifact.artifactId),
      ),
    });
    const candidate = snapshot(comparison, "candidate", {
      fixture_a: [added, candidateChanged].sort((left, right) =>
        left.artifact.artifactId.localeCompare(right.artifact.artifactId),
      ),
      fixture_b: [unchanged, candidateUnavailable].sort((left, right) =>
        left.artifact.artifactId.localeCompare(right.artifact.artifactId),
      ),
    });

    expect(deriveComparisonArtifactMetrics({ baseline, candidate, comparison })).toEqual({
      artifactChanges: [
        {
          artifactId: "artifact_added",
          candidate: added.artifact,
          candidateAvailability: "available",
          status: "added",
        },
        {
          artifactId: "artifact_changed",
          baseline: baselineChanged.artifact,
          baselineAvailability: "available",
          candidate: candidateChanged.artifact,
          candidateAvailability: "available",
          status: "metadata_changed",
        },
        {
          artifactId: "artifact_removed",
          baseline: removed.artifact,
          baselineAvailability: "available",
          status: "removed",
        },
        {
          artifactId: "artifact_unavailable",
          baseline: baselineUnavailable.artifact,
          baselineAvailability: "available",
          candidate: candidateUnavailable.artifact,
          candidateAvailability: "revoked",
          status: "unavailable",
        },
        {
          artifactId: "artifact_unchanged",
          baseline: unchanged.artifact,
          baselineAvailability: "available",
          candidate: unchanged.artifact,
          candidateAvailability: "available",
          status: "unchanged",
        },
      ],
      metricResults: [
        {
          kind: "artifact_set",
          metricId: "metric_artifacts_1",
          samples: sampleCounts,
          unit: "artifacts",
          value: {
            baseline: exact("4"),
            candidate: exact("4"),
            delta: exact("0"),
            direction: "unchanged",
            status: "available",
          },
        },
      ],
    });
  });

  it("keeps retained empty artifact sets as available zeroes", () => {
    const comparison = artifactComparison();
    expect(
      deriveComparisonArtifactMetrics({
        baseline: snapshot(comparison, "baseline"),
        candidate: snapshot(comparison, "candidate"),
        comparison,
      }),
    ).toEqual({
      artifactChanges: [],
      metricResults: [
        {
          kind: "artifact_set",
          metricId: "metric_artifacts_1",
          samples: sampleCounts,
          unit: "artifacts",
          value: {
            baseline: exact("0"),
            candidate: exact("0"),
            delta: exact("0"),
            direction: "unchanged",
            status: "available",
          },
        },
      ],
    });
  });

  it("does not misclassify artifacts from a missing fixture as removals", () => {
    const comparison = artifactComparison();
    const retained = artifact("artifact_retained", "1");
    const missingFixtureArtifact = artifact("artifact_not_removed", "2");
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: [retained],
      fixture_b: [missingFixtureArtifact],
    });
    const fullCandidate = snapshot(comparison, "candidate", { fixture_a: [retained] });
    const candidate = ComparisonEvidenceSnapshotSchema.parse({
      ...fullCandidate,
      fixtures: fullCandidate.fixtures.filter(({ fixture }) => fixture.fixtureId !== "fixture_b"),
    });

    expect(deriveComparisonArtifactMetrics({ baseline, candidate, comparison })).toEqual({
      artifactChanges: [
        {
          artifactId: retained.artifact.artifactId,
          baseline: retained.artifact,
          baselineAvailability: "available",
          candidate: retained.artifact,
          candidateAvailability: "available",
          status: "unchanged",
        },
      ],
      metricResults: [
        {
          kind: "artifact_set",
          metricId: "metric_artifacts_1",
          samples: {
            ...sampleCounts,
            candidateMissingCount: 1,
            candidateObservedCount: 1,
            pairedObservedCount: 1,
            pairedTotalCount: 1,
          },
          unit: "artifacts",
          value: {
            baseline: exact("1"),
            candidate: exact("1"),
            delta: exact("0"),
            direction: "unchanged",
            status: "available",
          },
        },
      ],
    });
  });

  it("reports invalid and absent fixture evidence instead of manufacturing empty sets", () => {
    const comparison = artifactComparison();
    const originalBaseline = snapshot(comparison, "baseline", {
      fixture_a: [artifact("artifact_a", "1")],
    });
    const baseline = ComparisonEvidenceSnapshotSchema.parse({
      ...originalBaseline,
      fixtures: originalBaseline.fixtures
        .filter(({ fixture }) => fixture.fixtureId !== "fixture_b")
        .map((fixture) => ({
          ...fixture,
          fixture: { ...fixture.fixture, definitionSha256: sha("9") },
        })),
    });
    const result = deriveComparisonArtifactMetrics({
      baseline,
      candidate: snapshot(comparison, "candidate"),
      comparison,
    });

    expect(result).toMatchObject({
      artifactChanges: [],
      metricResults: [
        {
          samples: {
            baselineInvalidCount: 1,
            baselineMissingCount: 1,
            baselineObservedCount: 0,
            candidateInvalidCount: 1,
            candidateObservedCount: 1,
            pairedObservedCount: 0,
            pairedTotalCount: 0,
          },
          value: {
            reasons: ["baseline_missing", "insufficient_observations", "invalid_observations"],
            status: "unavailable",
          },
        },
      ],
    });
  });

  it("deduplicates identical changes requested by overlapping artifact metrics", () => {
    const comparison = artifactComparison(2);
    const retained = artifact("artifact_shared", "1");
    const result = deriveComparisonArtifactMetrics({
      baseline: snapshot(comparison, "baseline", { fixture_a: [retained] }),
      candidate: snapshot(comparison, "candidate", { fixture_a: [retained] }),
      comparison,
    });

    expect(result.artifactChanges).toHaveLength(1);
    expect(result.metricResults.map(({ metricId }) => metricId)).toEqual([
      "metric_artifacts_1",
      "metric_artifacts_2",
    ]);
  });

  it("rejects cross-fixture artifact ownership changes", () => {
    const comparison = artifactComparison();
    const moved = artifact("artifact_moved", "1");
    expect(() =>
      deriveComparisonArtifactMetrics({
        baseline: snapshot(comparison, "baseline", { fixture_a: [moved] }),
        candidate: snapshot(comparison, "candidate", { fixture_b: [moved] }),
        comparison,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ComparisonArtifactDerivationError>>({
        code: "artifact_owner_mismatch",
      }),
    );
  });

  it("rejects conflicting changes when split strata conceal an ownership move", () => {
    const source = artifactComparison(2);
    const comparison = ComparisonDefinitionRecordSchema.parse({
      ...source,
      metrics: source.metrics.map((metric, index) => ({
        ...metric,
        stratumId: index === 0 ? "stratum_a" : "stratum_b",
      })),
      strata: [
        { fixtureIds: ["fixture_a"], label: "Fixture A", stratumId: "stratum_a" },
        { fixtureIds: ["fixture_b"], label: "Fixture B", stratumId: "stratum_b" },
      ],
    });
    const moved = artifact("artifact_split_move", "1");

    expect(() =>
      deriveComparisonArtifactMetrics({
        baseline: snapshot(comparison, "baseline", { fixture_a: [moved] }),
        candidate: snapshot(comparison, "candidate", { fixture_b: [moved] }),
        comparison,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ComparisonArtifactDerivationError>>({
        code: "artifact_change_conflict",
      }),
    );
  });

  it("fails explicitly when the exact artifact union exceeds the result bound", () => {
    const comparison = artifactComparison();
    const baselineArtifacts = Array.from({ length: MAX_COMPARISON_ARTIFACTS / 2 + 1 }, (_, index) =>
      artifact(`baseline_${index.toString().padStart(4, "0")}`, "1"),
    );
    const candidateArtifacts = Array.from({ length: MAX_COMPARISON_ARTIFACTS / 2 }, (_, index) =>
      artifact(`candidate_${index.toString().padStart(4, "0")}`, "2"),
    );

    expect(() =>
      deriveComparisonArtifactMetrics({
        baseline: snapshot(comparison, "baseline", { fixture_a: baselineArtifacts }),
        candidate: snapshot(comparison, "candidate", { fixture_a: candidateArtifacts }),
        comparison,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ComparisonArtifactDerivationError>>({
        code: "artifact_change_limit_exceeded",
      }),
    );
  });

  it("ignores other metric kinds and rejects malformed source envelopes", () => {
    const source = baseComparison();
    const comparison = ComparisonDefinitionRecordSchema.parse({
      ...source,
      metrics: source.metrics.filter(({ kind }) => kind !== "artifact_set"),
    });
    expect(
      deriveComparisonArtifactMetrics({
        baseline: snapshot(comparison, "baseline"),
        candidate: snapshot(comparison, "candidate"),
        comparison,
      }),
    ).toEqual({ artifactChanges: [], metricResults: [] });

    const invalidCandidate = {
      ...snapshot(comparison, "candidate"),
      role: "baseline",
    } as unknown as ComparisonEvidenceSnapshot;
    expect(() =>
      deriveComparisonArtifactMetrics({
        baseline: snapshot(comparison, "baseline"),
        candidate: invalidCandidate,
        comparison,
      }),
    ).toThrowError(ComparisonPairingError);
  });
});
