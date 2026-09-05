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
import { ComparisonPairingError } from "./comparison-pairing.js";
import { deriveComparisonResultDefinition } from "./derive-comparison-result.js";

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

const criterion = {
  criterionId: "criterion_login",
  criterionSet: {
    criterionSetId: "criteria_main",
    criterionSetVersionId: "criteria_main_v1",
    definitionSha256: sha("e"),
  },
} as const;

function comparison(): ComparisonDefinition {
  const vector = definitionVector.vectors[0];
  if (!vector) throw new Error("Expected comparison vector");
  return ComparisonDefinitionRecordSchema.parse({
    ...structuredClone(vector.input.definition),
    createdAt: "2026-09-02T01:10:00.000Z",
    createdByPrincipalId: "principal_operator",
    definitionSha256: sha("d"),
    metrics: [
      {
        kind: "artifact_set",
        label: "Exact artifact set",
        metricId: "metric_artifact",
        projection: "identity_digest_size_classification_availability",
        stratumId: "stratum_all",
        unit: "artifacts",
      },
      {
        condition: "assessment_eligible",
        dimension: "assessment_eligibility",
        kind: "assurance_state_count",
        label: "Eligible assessments",
        metricId: "metric_assurance",
        stratumId: "stratum_all",
        unit: "assurance_records",
      },
      {
        criterion,
        dimension: "observed",
        kind: "coverage_count",
        label: "Observed criterion coverage",
        metricId: "metric_coverage",
        stratumId: "stratum_all",
        unit: "cases",
      },
      {
        aggregation: { method: "mean", methodVersion: "1.0.0" },
        kind: "numeric_measurement",
        label: "Mean response time",
        measurementName: "response_time",
        metricId: "metric_numeric",
        stratumId: "stratum_all",
        unit: "milliseconds",
      },
      {
        eventKind: "guardrail_check",
        kind: "safety_event_count",
        label: "Guardrail checks",
        metricId: "metric_safety",
        stratumId: "stratum_all",
        unit: "events",
      },
      {
        eventKind: "agent.run",
        kind: "trace_event_count",
        label: "Agent run events",
        metricId: "metric_trace",
        stratumId: "stratum_all",
        unit: "events",
      },
      {
        aggregation: { method: "median", methodVersion: "1.0.0" },
        dimension: "elapsedMilliseconds",
        kind: "replay_usage",
        label: "Median elapsed milliseconds",
        metricId: "metric_usage",
        stratumId: "stratum_all",
        unit: "milliseconds",
      },
      {
        criterion,
        kind: "evaluation_verdict_count",
        label: "Failed criterion outcomes",
        metricId: "metric_verdict",
        stratumId: "stratum_all",
        unit: "evaluation_outcomes",
        verdict: "fail",
      },
    ],
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
  options: {
    readonly knownLimitations?: readonly string[];
    readonly sourceCutoff?: string;
  } = {},
): ComparisonEvidenceSnapshot {
  return ComparisonEvidenceSnapshotSchema.parse({
    comparison: {
      comparisonId: source.comparisonId,
      comparisonVersionId: source.comparisonVersionId,
      definitionSha256: source.definitionSha256,
    },
    createdAt: "2026-09-02T02:10:00.000Z",
    createdByPrincipalId: "principal_operator",
    dataset: source[role].dataset,
    definitionSha256: role === "baseline" ? sha("e") : sha("f"),
    fixtures: source[role].fixtures.map((value) => ({
      artifacts: [],
      assurance: assuranceFor(value),
      evaluationOutcomes: [],
      fixture: value.fixture,
      numericObservations: [
        {
          measurementName: "response_time",
          observation: {
            definitionSha256: role === "baseline" ? sha("8") : sha("9"),
            observationId: `observation_${role}`,
          },
          unit: "milliseconds",
          value: role === "baseline" ? "125.5" : "110.5",
        },
      ],
      replay: value.replay,
      safetyEvents: [],
      trace: { eventCount: 0, eventKinds: [], eventKindStatuses: [], eventStatuses: [] },
      usage: [
        {
          dimension: "elapsedMilliseconds",
          value: {
            amount: role === "baseline" ? 125 : 110,
            observedCount: 1,
            sources: ["measured"],
            status: "available",
            unavailableCount: 0,
          },
        },
      ],
    })),
    integrity: "verified",
    knownLimitations: options.knownLimitations ?? [],
    omissions: [],
    role,
    schemaVersion: COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
    scope: source.scope,
    snapshotId: `snapshot_${role}`,
    sourceCutoff:
      options.sourceCutoff ??
      (role === "baseline" ? "2026-09-02T02:00:00.000Z" : "2026-09-02T02:05:00.000Z"),
  });
}

describe("comparison result derivation", () => {
  it("assembles every declared metric and descriptive fragment into one exact result", () => {
    const source = comparison();
    const result = deriveComparisonResultDefinition({
      baseline: snapshot(source, "baseline", {
        knownLimitations: ["Baseline source limitation", "Shared source limitation"],
      }),
      candidate: snapshot(source, "candidate", {
        knownLimitations: ["Candidate source limitation", "Shared source limitation"],
      }),
      comparison: source,
      resultId: "result_exact_comparison",
    });

    expect(result.comparison).toEqual({
      comparisonId: source.comparisonId,
      comparisonVersionId: source.comparisonVersionId,
      definitionSha256: source.definitionSha256,
    });
    expect(result.baselineSnapshot).toEqual({
      definitionSha256: sha("e"),
      role: "baseline",
      snapshotId: "snapshot_baseline",
    });
    expect(result.candidateSnapshot).toEqual({
      definitionSha256: sha("f"),
      role: "candidate",
      snapshotId: "snapshot_candidate",
    });
    expect(result.latestSourceCutoff).toBe("2026-09-02T02:05:00.000Z");
    expect(result.knownLimitations).toEqual([
      "Baseline source limitation",
      "Candidate source limitation",
      "Shared source limitation",
    ]);
    expect(result.pairing).toEqual({
      baselineOnlyCount: 0,
      candidateOnlyCount: 0,
      invalidCount: 0,
      pairedCount: 1,
      requestedCount: 1,
    });
    expect(result.comparability).toEqual({ reasons: [], status: "comparable" });
    expect(result.metricResults.map(({ metricId }) => metricId)).toEqual(
      source.metrics.map(({ metricId }) => metricId),
    );
    expect(result.metricResults).toHaveLength(8);
    expect(result.artifactChanges).toEqual([]);
    expect(result.distributions.map(({ metricId, role }) => `${metricId}:${role}`)).toEqual([
      "metric_numeric:baseline",
      "metric_numeric:candidate",
      "metric_usage:baseline",
      "metric_usage:candidate",
    ]);
    expect(result.safetyCounts).toEqual([
      { counts: { baseline: 0, candidate: 0, delta: 0 }, kind: "guardrail_check" },
      {
        counts: { baseline: 0, candidate: 0, delta: 0 },
        kind: "replay_safety_intervention",
      },
      { counts: { baseline: 0, candidate: 0, delta: 0 }, kind: "uncertain_side_effect" },
    ]);
    expect(result.verdictMarginals).toEqual([]);
    expect(result.verdictTransitions).toEqual([]);
  });

  it("uses the later baseline cutoff and rejects malformed snapshot envelopes", () => {
    const source = comparison();
    const baseline = snapshot(source, "baseline", {
      sourceCutoff: "2026-09-02T02:06:00.000Z",
    });
    const candidate = snapshot(source, "candidate", {
      sourceCutoff: "2026-09-02T02:05:00.000Z",
    });
    expect(
      deriveComparisonResultDefinition({
        baseline,
        candidate,
        comparison: source,
        resultId: "result_later_baseline",
      }).latestSourceCutoff,
    ).toBe("2026-09-02T02:06:00.000Z");

    expect(() =>
      deriveComparisonResultDefinition({
        baseline,
        candidate: { ...candidate, role: "baseline" } as ComparisonEvidenceSnapshot,
        comparison: source,
        resultId: "result_invalid_role",
      }),
    ).toThrowError(ComparisonPairingError);
  });

  it("fails instead of truncating combined snapshot limitations", () => {
    const source = comparison();
    const limitations = (prefix: string) =>
      Array.from(
        { length: 33 },
        (_, index) => `${prefix} limitation ${index.toString().padStart(2, "0")}`,
      );
    expect(() =>
      deriveComparisonResultDefinition({
        baseline: snapshot(source, "baseline", { knownLimitations: limitations("Baseline") }),
        candidate: snapshot(source, "candidate", { knownLimitations: limitations("Candidate") }),
        comparison: source,
        resultId: "result_over_limit",
      }),
    ).toThrowError();
  });
});
