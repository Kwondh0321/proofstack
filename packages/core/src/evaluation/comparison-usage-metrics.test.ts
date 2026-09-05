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
import { deriveComparisonUsageMetrics } from "./comparison-usage-metrics.js";

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
type UsageDimension = ComparisonEvidenceFixtureSnapshot["usage"][number];

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

function usageComparison(): ComparisonDefinition {
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
        aggregation: { method: "mean", methodVersion: "1.0.0" },
        dimension: "elapsedMilliseconds",
        kind: "replay_usage",
        label: "Mean elapsed time",
        metricId: "metric_elapsed",
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
  usage: Readonly<Record<string, readonly UsageDimension[]>> = {},
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
      usage: usage[value.fixture.fixtureId] ?? [],
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

function available(
  amount: number,
  sources: readonly ("estimated" | "measured" | "provider_reported")[],
): UsageDimension {
  return {
    dimension: "elapsedMilliseconds",
    value: {
      amount,
      observedCount: sources.length,
      sources: [...sources],
      status: "available",
      unavailableCount: 0,
    },
  };
}

function partial(
  amount: number,
  source: "estimated" | "measured" | "provider_reported",
  reason: "measurement_failed" | "provider_did_not_report" | "source_unavailable",
): UsageDimension {
  return {
    dimension: "elapsedMilliseconds",
    value: {
      amount,
      observedCount: 1,
      sources: [source],
      status: "partial",
      unavailableCount: 1,
      unavailableReasons: [reason],
    },
  };
}

function unavailable(
  reason: "measurement_failed" | "provider_did_not_report" | "source_unavailable",
): UsageDimension {
  return {
    dimension: "elapsedMilliseconds",
    value: {
      observedCount: 0,
      status: "unavailable",
      unavailableCount: 1,
      unavailableReasons: [reason],
    },
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

describe("replay usage comparison derivation", () => {
  it("excludes partial usage from arithmetic while retaining exact provenance", () => {
    const comparison = usageComparison();
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: [available(10, ["measured"])],
      fixture_b: [partial(20, "provider_reported", "provider_did_not_report")],
      fixture_c: [unavailable("measurement_failed")],
      fixture_d: [available(40, ["estimated"])],
    });
    const candidate = snapshot(comparison, "candidate", {
      fixture_a: [available(8, ["provider_reported"])],
      fixture_b: [available(12, ["measured"])],
      fixture_c: [partial(5, "estimated", "source_unavailable")],
      fixture_e: [unavailable("provider_did_not_report")],
    });

    expect(deriveComparisonUsageMetrics({ baseline, candidate, comparison })).toEqual({
      distributions: [
        {
          invalidCount: 0,
          method: { method: "mean", methodVersion: "1.0.0" },
          metricId: "metric_elapsed",
          missingCount: 0,
          observedCount: 2,
          role: "baseline",
          totalCount: 4,
          unavailableCount: 2,
          value: exact("25"),
        },
        {
          invalidCount: 0,
          method: { method: "mean", methodVersion: "1.0.0" },
          metricId: "metric_elapsed",
          missingCount: 0,
          observedCount: 2,
          role: "candidate",
          totalCount: 4,
          unavailableCount: 2,
          value: exact("10"),
        },
      ],
      metricResults: [
        {
          kind: "replay_usage",
          metricId: "metric_elapsed",
          samples: {
            baselineInvalidCount: 0,
            baselineMissingCount: 0,
            baselineObservedCount: 2,
            baselineTotalCount: 4,
            baselineUnavailableCount: 2,
            candidateInvalidCount: 0,
            candidateMissingCount: 0,
            candidateObservedCount: 2,
            candidateTotalCount: 4,
            candidateUnavailableCount: 2,
            pairedInvalidCount: 0,
            pairedMissingCount: 0,
            pairedObservedCount: 1,
            pairedTotalCount: 3,
            pairedUnavailableCount: 2,
          },
          unit: "milliseconds",
          usageProvenance: {
            baseline: {
              completeCount: 2,
              observedSources: ["estimated", "measured", "provider_reported"],
              partialCount: 1,
              unavailableCount: 1,
              unavailableReasons: ["measurement_failed", "provider_did_not_report"],
            },
            candidate: {
              completeCount: 2,
              observedSources: ["estimated", "measured", "provider_reported"],
              partialCount: 1,
              unavailableCount: 1,
              unavailableReasons: ["provider_did_not_report", "source_unavailable"],
            },
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

  it("keeps missing usage distinct from a measured zero", () => {
    const comparison = usageComparison();
    const missing = deriveComparisonUsageMetrics({
      baseline: snapshot(comparison, "baseline"),
      candidate: snapshot(comparison, "candidate"),
      comparison,
    });
    expect(missing.distributions).toEqual([]);
    expect(missing.metricResults[0]).toMatchObject({
      samples: {
        baselineMissingCount: 4,
        baselineObservedCount: 0,
        baselineUnavailableCount: 0,
        candidateMissingCount: 4,
        candidateObservedCount: 0,
        candidateUnavailableCount: 0,
        pairedMissingCount: 3,
        pairedObservedCount: 0,
        pairedUnavailableCount: 0,
      },
      usageProvenance: {
        baseline: {
          completeCount: 0,
          observedSources: [],
          partialCount: 0,
          unavailableCount: 0,
          unavailableReasons: [],
        },
        candidate: {
          completeCount: 0,
          observedSources: [],
          partialCount: 0,
          unavailableCount: 0,
          unavailableReasons: [],
        },
      },
      value: {
        reasons: ["baseline_missing", "candidate_missing", "insufficient_observations"],
        status: "unavailable",
      },
    });

    const zero = deriveComparisonUsageMetrics({
      baseline: snapshot(comparison, "baseline", {
        fixture_a: [available(0, ["measured"])],
      }),
      candidate: snapshot(comparison, "candidate", {
        fixture_a: [available(0, ["provider_reported"])],
      }),
      comparison,
    });
    expect(zero.metricResults[0]?.value).toEqual({
      baseline: exact("0"),
      candidate: exact("0"),
      delta: exact("0"),
      direction: "unchanged",
      status: "available",
    });
    expect(zero.metricResults[0]?.usageProvenance).toEqual({
      baseline: {
        completeCount: 1,
        observedSources: ["measured"],
        partialCount: 0,
        unavailableCount: 0,
        unavailableReasons: [],
      },
      candidate: {
        completeCount: 1,
        observedSources: ["provider_reported"],
        partialCount: 0,
        unavailableCount: 0,
        unavailableReasons: [],
      },
    });
  });

  it("returns measurement unavailability without using a partial lower bound", () => {
    const comparison = usageComparison();
    const result = deriveComparisonUsageMetrics({
      baseline: snapshot(comparison, "baseline", {
        fixture_a: [available(10, ["measured"])],
      }),
      candidate: snapshot(comparison, "candidate", {
        fixture_a: [partial(1_000_000, "estimated", "source_unavailable")],
      }),
      comparison,
    });
    expect(result.distributions).toHaveLength(1);
    expect(result.metricResults[0]?.value).toEqual({
      reasons: ["candidate_missing", "insufficient_observations", "measurement_unavailable"],
      status: "unavailable",
    });
    expect(result.metricResults[0]?.samples).toMatchObject({
      candidateObservedCount: 0,
      candidateUnavailableCount: 1,
      pairedObservedCount: 0,
      pairedUnavailableCount: 1,
    });
  });

  it("keeps invalid lineage and omitted fixture snapshots out of usage arithmetic", () => {
    const comparison = usageComparison();
    const originalBaseline = snapshot(comparison, "baseline");
    const baseline = ComparisonEvidenceSnapshotSchema.parse({
      ...originalBaseline,
      fixtures: originalBaseline.fixtures
        .filter(({ fixture }) => fixture.fixtureId !== "fixture_b")
        .map((fixture) =>
          fixture.fixture.fixtureId === "fixture_a"
            ? {
                ...fixture,
                fixture: { ...fixture.fixture, definitionSha256: sha("9") },
              }
            : fixture,
        ),
    });
    const result = deriveComparisonUsageMetrics({
      baseline,
      candidate: snapshot(comparison, "candidate"),
      comparison,
    });
    expect(result.metricResults[0]?.samples).toMatchObject({
      baselineInvalidCount: 1,
      baselineMissingCount: 3,
      baselineObservedCount: 0,
      candidateInvalidCount: 1,
      candidateMissingCount: 3,
      candidateObservedCount: 0,
      pairedInvalidCount: 0,
      pairedMissingCount: 1,
      pairedObservedCount: 0,
    });
    expect(result.metricResults[0]?.value).toEqual({
      reasons: [
        "baseline_missing",
        "candidate_missing",
        "insufficient_observations",
        "invalid_observations",
      ],
      status: "unavailable",
    });
  });

  it("ignores other metric kinds and rejects malformed source envelopes", () => {
    const source = baseComparison();
    const comparison = ComparisonDefinitionRecordSchema.parse({
      ...source,
      metrics: [
        {
          eventKind: "agent.run",
          kind: "trace_event_count",
          label: "Agent run events",
          metricId: "metric_events",
          stratumId: "stratum_all",
          unit: "events",
        },
      ],
    });
    expect(
      deriveComparisonUsageMetrics({
        baseline: snapshot(comparison, "baseline"),
        candidate: snapshot(comparison, "candidate"),
        comparison,
      }),
    ).toEqual({ distributions: [], metricResults: [] });

    const invalidCandidate = {
      ...snapshot(comparison, "candidate"),
      role: "baseline",
    } as unknown as ComparisonEvidenceSnapshot;
    expect(() =>
      deriveComparisonUsageMetrics({
        baseline: snapshot(comparison, "baseline"),
        candidate: invalidCandidate,
        comparison,
      }),
    ).toThrowError(ComparisonPairingError);
  });
});
