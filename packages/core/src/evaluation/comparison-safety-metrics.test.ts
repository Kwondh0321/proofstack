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
import { deriveComparisonSafetyMetrics } from "./comparison-safety-metrics.js";

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
type SafetyEvent = ComparisonEvidenceFixtureSnapshot["safetyEvents"][number];

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

function safetyComparison(): ComparisonDefinition {
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
        eventKind: "guardrail_check",
        kind: "safety_event_count",
        label: "Guardrail checks",
        metricId: "metric_guardrail",
        stratumId: "stratum_all",
        unit: "events",
      },
      {
        eventKind: "replay_safety_intervention",
        kind: "safety_event_count",
        label: "Replay safety interventions",
        metricId: "metric_replay_intervention",
        stratumId: "stratum_all",
        unit: "events",
      },
      {
        eventKind: "uncertain_side_effect",
        kind: "safety_event_count",
        label: "Uncertain side effects",
        metricId: "metric_uncertain",
        stratumId: "stratum_all",
        unit: "events",
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

function safetyEvent(
  eventId: string,
  kind: SafetyEvent["kind"],
  digestCharacter: string,
): SafetyEvent {
  return {
    eventId,
    kind,
    occurredAt: "2026-09-02T01:59:59.000Z",
    sourceId: `source_${eventId}`,
    sourceSha256: sha(digestCharacter),
  };
}

function snapshot(
  source: ComparisonDefinition,
  role: "baseline" | "candidate",
  safetyEvents: Readonly<Record<string, readonly SafetyEvent[]>> = {},
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
      safetyEvents: safetyEvents[value.fixture.fixtureId] ?? [],
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

function exact(numerator: string) {
  return {
    denominator: "1",
    numerator,
    representation: "rational" as const,
    unit: "events",
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

describe("safety event comparison derivation", () => {
  it("counts every safety kind across exact paired fixtures", () => {
    const comparison = safetyComparison();
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: [
        safetyEvent("event_a_guardrail_1", "guardrail_check", "1"),
        safetyEvent("event_a_guardrail_2", "guardrail_check", "2"),
        safetyEvent("event_a_replay", "replay_safety_intervention", "3"),
      ],
    });
    const candidate = snapshot(comparison, "candidate", {
      fixture_a: [
        safetyEvent("event_a_guardrail", "guardrail_check", "4"),
        safetyEvent("event_a_uncertain", "uncertain_side_effect", "5"),
      ],
      fixture_b: [
        safetyEvent("event_b_guardrail_1", "guardrail_check", "6"),
        safetyEvent("event_b_guardrail_2", "guardrail_check", "7"),
        safetyEvent("event_b_guardrail_3", "guardrail_check", "8"),
      ],
    });

    expect(deriveComparisonSafetyMetrics({ baseline, candidate, comparison })).toEqual({
      metricResults: [
        {
          kind: "safety_event_count",
          metricId: "metric_guardrail",
          samples: sampleCounts,
          unit: "events",
          value: {
            baseline: exact("2"),
            candidate: exact("4"),
            delta: exact("2"),
            direction: "increased",
            status: "available",
          },
        },
        {
          kind: "safety_event_count",
          metricId: "metric_replay_intervention",
          samples: sampleCounts,
          unit: "events",
          value: {
            baseline: exact("1"),
            candidate: exact("0"),
            delta: exact("-1"),
            direction: "decreased",
            status: "available",
          },
        },
        {
          kind: "safety_event_count",
          metricId: "metric_uncertain",
          samples: sampleCounts,
          unit: "events",
          value: {
            baseline: exact("0"),
            candidate: exact("1"),
            delta: exact("1"),
            direction: "increased",
            status: "available",
          },
        },
      ],
    });
  });

  it("keeps retained empty safety-event sets as available zeroes", () => {
    const comparison = safetyComparison();
    const result = deriveComparisonSafetyMetrics({
      baseline: snapshot(comparison, "baseline"),
      candidate: snapshot(comparison, "candidate"),
      comparison,
    });

    expect(result.metricResults).toHaveLength(3);
    for (const metric of result.metricResults) {
      expect(metric).toMatchObject({
        samples: sampleCounts,
        value: {
          baseline: exact("0"),
          candidate: exact("0"),
          delta: exact("0"),
          direction: "unchanged",
          status: "available",
        },
      });
    }
  });

  it("retains a missing fixture while deriving only from the remaining exact pair", () => {
    const comparison = safetyComparison();
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: [safetyEvent("event_a_guardrail_1", "guardrail_check", "1")],
      fixture_b: [safetyEvent("event_b_guardrail_1", "guardrail_check", "2")],
    });
    const fullCandidate = snapshot(comparison, "candidate", {
      fixture_a: [
        safetyEvent("event_a_guardrail_1", "guardrail_check", "3"),
        safetyEvent("event_a_guardrail_2", "guardrail_check", "4"),
      ],
    });
    const candidate = ComparisonEvidenceSnapshotSchema.parse({
      ...fullCandidate,
      fixtures: fullCandidate.fixtures.filter(({ fixture }) => fixture.fixtureId !== "fixture_b"),
    });

    expect(
      deriveComparisonSafetyMetrics({ baseline, candidate, comparison }).metricResults[0],
    ).toEqual({
      kind: "safety_event_count",
      metricId: "metric_guardrail",
      samples: {
        ...sampleCounts,
        candidateMissingCount: 1,
        candidateObservedCount: 1,
        pairedObservedCount: 1,
        pairedTotalCount: 1,
      },
      unit: "events",
      value: {
        baseline: exact("1"),
        candidate: exact("2"),
        delta: exact("1"),
        direction: "increased",
        status: "available",
      },
    });
  });

  it("reports invalid and absent fixture evidence instead of manufacturing zeroes", () => {
    const comparison = safetyComparison();
    const originalBaseline = snapshot(comparison, "baseline", {
      fixture_a: [safetyEvent("event_a_guardrail", "guardrail_check", "1")],
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
    const result = deriveComparisonSafetyMetrics({
      baseline,
      candidate: snapshot(comparison, "candidate"),
      comparison,
    });

    expect(result.metricResults[0]).toMatchObject({
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
    });
  });

  it("ignores other metric kinds and rejects malformed source envelopes", () => {
    const source = baseComparison();
    const comparison = ComparisonDefinitionRecordSchema.parse({
      ...source,
      metrics: source.metrics.filter(({ kind }) => kind !== "safety_event_count"),
    });
    expect(
      deriveComparisonSafetyMetrics({
        baseline: snapshot(comparison, "baseline"),
        candidate: snapshot(comparison, "candidate"),
        comparison,
      }),
    ).toEqual({ metricResults: [] });

    const invalidCandidate = {
      ...snapshot(comparison, "candidate"),
      role: "baseline",
    } as unknown as ComparisonEvidenceSnapshot;
    expect(() =>
      deriveComparisonSafetyMetrics({
        baseline: snapshot(comparison, "baseline"),
        candidate: invalidCandidate,
        comparison,
      }),
    ).toThrowError(ComparisonPairingError);
  });
});
