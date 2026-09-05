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
import { deriveComparisonTraceMetrics } from "./comparison-trace-metrics.js";

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
type TraceStructure = ComparisonEvidenceFixtureSnapshot["trace"];
type TraceEntry = TraceStructure["eventKindStatuses"][number];

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

function traceComparison(): ComparisonDefinition {
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
        eventKind: "agent.run",
        kind: "trace_event_count",
        label: "All agent run events",
        metricId: "metric_agent_all",
        stratumId: "stratum_all",
        unit: "events",
      },
      {
        eventKind: "agent.run",
        eventStatus: "error",
        kind: "trace_event_count",
        label: "Errored agent run events",
        metricId: "metric_agent_error",
        stratumId: "stratum_all",
        unit: "events",
      },
      {
        eventKind: "model.generate",
        kind: "trace_event_count",
        label: "Model generation events",
        metricId: "metric_model_zero",
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

function trace(entries: readonly TraceEntry[]): TraceStructure {
  const kindCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  for (const entry of entries) {
    kindCounts.set(entry.kind, (kindCounts.get(entry.kind) ?? 0) + entry.count);
    statusCounts.set(entry.status, (statusCounts.get(entry.status) ?? 0) + entry.count);
  }
  return {
    eventCount: entries.reduce((sum, entry) => sum + entry.count, 0),
    eventKinds: [...kindCounts]
      .map(([kind, count]) => ({ count, kind }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),
    eventKindStatuses: [...entries].sort((a, b) =>
      `${a.kind}:${a.status}`.localeCompare(`${b.kind}:${b.status}`),
    ),
    eventStatuses: [...statusCounts]
      .map(([status, count]) => ({ count, status }))
      .sort((a, b) => a.status.localeCompare(b.status)),
  } as TraceStructure;
}

function snapshot(
  source: ComparisonDefinition,
  role: "baseline" | "candidate",
  traces: Readonly<Record<string, TraceStructure>>,
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
      trace: traces[value.fixture.fixtureId] ?? trace([]),
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

describe("trace count comparison derivation", () => {
  it("uses exact kind-status counts and keeps an observed zero available", () => {
    const comparison = traceComparison();
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: trace([
        { count: 1, kind: "agent.run", status: "error" },
        { count: 2, kind: "agent.run", status: "ok" },
        { count: 1, kind: "guardrail.check", status: "error" },
      ]),
      fixture_b: trace([{ count: 4, kind: "agent.run", status: "ok" }]),
    });
    const candidate = snapshot(comparison, "candidate", {
      fixture_a: trace([
        { count: 2, kind: "agent.run", status: "error" },
        { count: 1, kind: "agent.run", status: "ok" },
      ]),
      fixture_b: trace([{ count: 1, kind: "guardrail.check", status: "ok" }]),
    });

    expect(deriveComparisonTraceMetrics({ baseline, candidate, comparison })).toEqual({
      metricResults: [
        {
          kind: "trace_event_count",
          metricId: "metric_agent_all",
          samples: sampleCounts,
          unit: "events",
          value: {
            baseline: exact("7"),
            candidate: exact("3"),
            delta: exact("-4"),
            direction: "decreased",
            status: "available",
          },
        },
        {
          kind: "trace_event_count",
          metricId: "metric_agent_error",
          samples: sampleCounts,
          unit: "events",
          value: {
            baseline: exact("1"),
            candidate: exact("2"),
            delta: exact("1"),
            direction: "increased",
            status: "available",
          },
        },
        {
          kind: "trace_event_count",
          metricId: "metric_model_zero",
          samples: sampleCounts,
          unit: "events",
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

  it("retains missing fixture evidence while deriving from the remaining exact pair", () => {
    const comparison = traceComparison();
    const baseline = snapshot(comparison, "baseline", {
      fixture_a: trace([{ count: 3, kind: "agent.run", status: "ok" }]),
      fixture_b: trace([{ count: 5, kind: "agent.run", status: "ok" }]),
    });
    const fullCandidate = snapshot(comparison, "candidate", {
      fixture_a: trace([{ count: 2, kind: "agent.run", status: "ok" }]),
    });
    const candidate = ComparisonEvidenceSnapshotSchema.parse({
      ...fullCandidate,
      fixtures: fullCandidate.fixtures.filter(({ fixture }) => fixture.fixtureId !== "fixture_b"),
    });

    expect(
      deriveComparisonTraceMetrics({ baseline, candidate, comparison }).metricResults[0],
    ).toEqual({
      kind: "trace_event_count",
      metricId: "metric_agent_all",
      samples: {
        ...sampleCounts,
        candidateMissingCount: 1,
        candidateObservedCount: 1,
        pairedObservedCount: 1,
        pairedTotalCount: 1,
      },
      unit: "events",
      value: {
        baseline: exact("3"),
        candidate: exact("2"),
        delta: exact("-1"),
        direction: "decreased",
        status: "available",
      },
    });
  });

  it("reports invalid and absent evidence instead of manufacturing a zero delta", () => {
    const comparison = traceComparison();
    const originalBaseline = snapshot(comparison, "baseline", {
      fixture_a: trace([{ count: 3, kind: "agent.run", status: "ok" }]),
      fixture_b: trace([{ count: 5, kind: "agent.run", status: "ok" }]),
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
    const candidate = snapshot(comparison, "candidate", {
      fixture_a: trace([{ count: 2, kind: "agent.run", status: "ok" }]),
    });
    const result = deriveComparisonTraceMetrics({ baseline, candidate, comparison });

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
      metrics: source.metrics.filter(({ kind }) => kind !== "trace_event_count"),
    });
    expect(
      deriveComparisonTraceMetrics({
        baseline: snapshot(comparison, "baseline", {}),
        candidate: snapshot(comparison, "candidate", {}),
        comparison,
      }),
    ).toEqual({ metricResults: [] });

    const invalidCandidate = {
      ...snapshot(comparison, "candidate", {}),
      role: "baseline",
    } as unknown as ComparisonEvidenceSnapshot;
    expect(() =>
      deriveComparisonTraceMetrics({
        baseline: snapshot(comparison, "baseline", {}),
        candidate: invalidCandidate,
        comparison,
      }),
    ).toThrowError(ComparisonPairingError);
  });
});
