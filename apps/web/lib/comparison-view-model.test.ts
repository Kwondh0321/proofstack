import { describe, expect, it } from "vitest";
import type { ComparisonView } from "./proofstack-api.js";
import { buildComparisonDisplay, exactValueDisplay } from "./comparison-view-model.js";

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const sampleCounts = {
  baselineInvalidCount: 0,
  baselineMissingCount: 0,
  baselineObservedCount: 1,
  baselineTotalCount: 1,
  baselineUnavailableCount: 0,
  candidateInvalidCount: 0,
  candidateMissingCount: 0,
  candidateObservedCount: 1,
  candidateTotalCount: 1,
  candidateUnavailableCount: 0,
  pairedInvalidCount: 0,
  pairedMissingCount: 0,
  pairedObservedCount: 1,
  pairedTotalCount: 1,
  pairedUnavailableCount: 0,
};

function reference(fixtureId: string, suffix: string) {
  return { definitionSha256: digest, fixtureId, fixtureVersionId: `${fixtureId}_${suffix}` };
}

function displayFixture(): ComparisonView {
  const baselineReference = reference("fixture_paired", "baseline");
  const candidateReference = reference("fixture_paired", "candidate");
  return {
    baseline: {
      createdAt: "2026-09-04T01:00:00.000Z",
      dataset: { datasetId: "dataset_eval", datasetVersionId: "dataset_v1", definitionSha256: digest },
      definitionSha256: digest,
      fixtures: [{}],
      integrity: "verified",
      knownLimitations: ["Baseline observation window is short"],
      omissions: [
        { reason: "classified_content_excluded" },
        { reason: "classified_content_excluded" },
      ],
      role: "baseline",
      snapshotId: "snapshot_baseline",
      sourceCutoff: "2026-09-04T00:59:00.000Z",
    },
    candidate: {
      createdAt: "2026-09-04T01:01:00.000Z",
      dataset: { datasetId: "dataset_eval", datasetVersionId: "dataset_v1", definitionSha256: digest },
      definitionSha256: otherDigest,
      fixtures: [{}, {}],
      integrity: "verified",
      knownLimitations: ["Candidate provider usage is partial"],
      omissions: [{ reason: "provider_did_not_report" }],
      role: "candidate",
      snapshotId: "snapshot_candidate",
      sourceCutoff: "2026-09-04T01:00:00.000Z",
    },
    definition: {
      baseline: {
        dataset: {},
        fixtures: [
          { replay: { targetRelease: { targetReleaseId: "release_baseline" } } },
          { replay: { targetRelease: { targetReleaseId: "release_baseline" } } },
        ],
      },
      calculationPolicy: {
        confidenceIntervals: "source_only",
        decimalArithmetic: "exact_decimal_v1",
        denominators: "role_fixture_membership_and_paired_observations",
        fixturePairing: "logical_fixture_id",
        invalidCases: "preserve_and_exclude_from_aggregation",
        mean: "exact_rational_v1",
        minimumPairedCoverageBasisPoints: 8000,
        missingness: "preserve_all",
        numericObservationMultiplicity: "at_most_one_per_fixture",
        quantile: "nearest_rank_v1",
      },
      candidate: {
        dataset: {},
        fixtures: [{ replay: { targetRelease: { targetReleaseId: "release_candidate" } } }],
      },
      classifiedContentProjection: "metadata_only",
      comparisonId: "comparison_login",
      comparisonVersionId: "comparison_login_v1",
      createdAt: "2026-09-04T00:00:00.000Z",
      definitionSha256: digest,
      description: "Compare a bounded login regression set",
      metrics: [
        { label: "Latency", metricId: "metric_latency" },
        { label: "Coverage", metricId: "metric_coverage" },
        { label: "Usage", metricId: "metric_usage" },
      ],
      name: "Login comparison",
    },
    result: {
      artifactChanges: [
        {
          artifactId: "artifact_changed",
          baseline: {
            artifactId: "artifact_changed",
            classification: "internal",
            mediaType: "application/json",
            redactedAt: "2026-09-04T00:00:00.000Z",
            sha256: digest,
            sizeBytes: 100,
          },
          baselineAvailability: "available",
          candidate: {
            artifactId: "artifact_changed",
            classification: "internal",
            mediaType: "application/json",
            sha256: otherDigest,
            sizeBytes: 120,
          },
          candidateAvailability: "available",
          status: "metadata_changed",
        },
        {
          artifactId: "artifact_added",
          candidate: {
            artifactId: "artifact_added",
            classification: "restricted",
            mediaType: "text/plain",
            sha256: otherDigest,
            sizeBytes: 12,
          },
          candidateAvailability: "revoked",
          status: "unavailable",
        },
      ],
      cases: [
        {
          baseline: baselineReference,
          candidate: candidateReference,
          fixtureId: "fixture_paired",
          state: "paired",
        },
        {
          baseline: reference("fixture_baseline", "v1"),
          candidateMissingReason: "snapshot_omission",
          fixtureId: "fixture_baseline",
          state: "baseline_only",
        },
        {
          baselineMissingReason: "fixture_absent",
          candidate: reference("fixture_candidate", "v1"),
          fixtureId: "fixture_candidate",
          state: "candidate_only",
        },
        {
          baseline: reference("fixture_invalid", "v1"),
          fixtureId: "fixture_invalid",
          reasons: ["digest_mismatch", "invalid_source_integrity"],
          state: "invalid",
        },
      ],
      comparability: { reasons: ["missing_source_evidence"], status: "partially_comparable" },
      createdAt: "2026-09-04T01:02:00.000Z",
      definitionSha256: otherDigest,
      distributions: [
        {
          invalidCount: 0,
          method: { method: "mean", methodVersion: "1.0.0" },
          metricId: "metric_latency",
          missingCount: 0,
          observedCount: 1,
          role: "baseline",
          totalCount: 1,
          unavailableCount: 0,
          value: { representation: "decimal", unit: "milliseconds", value: "125.5" },
        },
        {
          invalidCount: 0,
          method: { basisPoints: 9500, method: "nearest_rank_quantile", methodVersion: "1.0.0" },
          metricId: "metric_latency",
          missingCount: 0,
          observedCount: 1,
          role: "candidate",
          totalCount: 1,
          unavailableCount: 0,
          value: { denominator: "2", numerator: "221", representation: "rational", unit: "milliseconds" },
        },
      ],
      knownLimitations: ["Baseline observation window is short", "Candidate provider usage is partial"],
      latestSourceCutoff: "2026-09-04T01:00:00.000Z",
      metricResults: [
        {
          kind: "numeric_measurement",
          metricId: "metric_latency",
          samples: sampleCounts,
          unit: "milliseconds",
          value: {
            baseline: { representation: "decimal", unit: "milliseconds", value: "125.5" },
            candidate: { representation: "decimal", unit: "milliseconds", value: "110.5" },
            delta: { representation: "decimal", unit: "milliseconds", value: "-15" },
            direction: "decreased",
            status: "available",
          },
        },
        {
          kind: "coverage_count",
          metricId: "metric_coverage",
          samples: sampleCounts,
          unit: "cases",
          value: {
            baseline: { denominator: "2", numerator: "1", representation: "rational", unit: "cases" },
            reasons: ["population_mismatch"],
            status: "incomparable",
          },
        },
        {
          kind: "replay_usage",
          metricId: "metric_usage",
          samples: sampleCounts,
          unit: "milliseconds",
          usageProvenance: {
            baseline: {
              completeCount: 1,
              observedSources: ["measured"],
              partialCount: 0,
              unavailableCount: 0,
              unavailableReasons: [],
            },
            candidate: {
              completeCount: 0,
              observedSources: [],
              partialCount: 0,
              unavailableCount: 1,
              unavailableReasons: ["provider_did_not_report"],
            },
          },
          value: { reasons: ["measurement_unavailable"], status: "unavailable" },
        },
      ],
      pairing: {
        baselineOnlyCount: 1,
        candidateOnlyCount: 1,
        invalidCount: 1,
        pairedCount: 1,
        requestedCount: 4,
      },
      resultId: "result_login_candidate",
      safetyCounts: [
        { counts: { baseline: 1, candidate: 2, delta: 1 }, kind: "guardrail_check" },
      ],
      schemaVersion: "0.6",
      scope: { tenantId: "tenant_demo", projectId: "project_demo", environmentId: "environment_local" },
      verdictMarginals: [
        {
          baseline: { abstain: 0, error: 0, fail: 1, notApplicable: 0, pass: 0, total: 1 },
          candidate: { abstain: 0, error: 0, fail: 0, notApplicable: 0, pass: 1, total: 1 },
          criterion: { criterionId: "criterion_login" },
          transition: { pairedCount: 1, status: "available" },
        },
        {
          baseline: { abstain: 1, error: 0, fail: 0, notApplicable: 0, pass: 0, total: 1 },
          candidate: { abstain: 1, error: 0, fail: 0, notApplicable: 0, pass: 0, total: 1 },
          criterion: { criterionId: "criterion_safety" },
          transition: { reasons: ["missing_paired_evidence"], status: "unavailable" },
        },
      ],
      verdictTransitions: [
        { baseline: "fail", candidate: "pass", count: 1, criterion: { criterionId: "criterion_login" } },
      ],
    },
  } as unknown as ComparisonView;
}

describe("comparison view model", () => {
  it("preserves exact decimal and rational representations", () => {
    expect(exactValueDisplay({ representation: "decimal", unit: "seconds", value: "0.125" })).toEqual({
      representation: "decimal",
      text: "0.125 seconds",
      unit: "seconds",
      value: "0.125",
    });
    expect(
      exactValueDisplay({ denominator: "8", numerator: "1", representation: "rational", unit: "seconds" }),
    ).toEqual({
      denominator: "8",
      numerator: "1",
      representation: "rational",
      text: "1/8 seconds",
      unit: "seconds",
    });
  });

  it("projects only bounded operator-safe comparison metadata", () => {
    const model = buildComparisonDisplay(displayFixture());

    expect(model.result).toMatchObject({
      resultId: "result_login_candidate",
      schemaVersion: "0.6",
      scope: "tenant_demo/project_demo/environment_local",
    });
    expect(model.sources).toEqual([
      expect.objectContaining({
        dataset: "dataset_eval@dataset_v1",
        fixtureCount: 1,
        omissionCount: 2,
        omissionReasons: ["classified_content_excluded"],
        role: "baseline",
        targetReleaseIds: ["release_baseline"],
      }),
      expect.objectContaining({
        fixtureCount: 2,
        omissionReasons: ["provider_did_not_report"],
        role: "candidate",
        targetReleaseIds: ["release_candidate"],
      }),
    ]);
    expect(model.cases.map(({ reasons, state }) => ({ reasons, state }))).toEqual([
      { reasons: [], state: "paired" },
      { reasons: ["snapshot_omission"], state: "baseline_only" },
      { reasons: ["fixture_absent"], state: "candidate_only" },
      { reasons: ["digest_mismatch", "invalid_source_integrity"], state: "invalid" },
    ]);
    expect(model.metrics).toEqual([
      expect.objectContaining({
        baseline: expect.objectContaining({ text: "125.5 milliseconds" }),
        delta: expect.objectContaining({ text: "-15 milliseconds" }),
        direction: "decreased",
        label: "Latency",
        status: "available",
      }),
      expect.objectContaining({
        baseline: expect.objectContaining({ denominator: "2", numerator: "1" }),
        reasons: ["population_mismatch"],
        status: "incomparable",
      }),
      expect.objectContaining({
        reasons: ["measurement_unavailable"],
        status: "unavailable",
        usageProvenance: {
          baseline: expect.stringContaining("sources measured"),
          candidate: expect.stringContaining("reasons provider_did_not_report"),
        },
      }),
    ]);
    expect(model.distributions.map(({ method, value }) => ({ method, value: value.text }))).toEqual([
      { method: "mean @ 1.0.0", value: "125.5 milliseconds" },
      { method: "nearest_rank_quantile 9500bp @ 1.0.0", value: "221/2 milliseconds" },
    ]);
    expect(model.artifacts[0]).toEqual(
      expect.objectContaining({
        baseline: expect.objectContaining({ redactedAt: "2026-09-04T00:00:00.000Z" }),
        candidate: expect.objectContaining({ availability: "available" }),
        status: "metadata_changed",
      }),
    );
    expect(model.artifacts[1]).toEqual(
      expect.objectContaining({
        candidate: expect.objectContaining({ availability: "revoked" }),
        status: "unavailable",
      }),
    );
    expect(model.artifacts[1]).not.toHaveProperty("baseline");
    expect(model.safety).toEqual([
      { baseline: 1, candidate: 2, delta: 1, kind: "guardrail_check" },
    ]);
    expect(model.verdictMarginals.map(({ transition }) => transition)).toEqual([
      "available; paired 1",
      "unavailable; missing_paired_evidence",
    ]);
    expect(model.verdictTransitions).toEqual([
      { baseline: "fail", candidate: "pass", count: 1, criterionId: "criterion_login" },
    ]);
    expect(model.policy).toContainEqual({ label: "Classified projection", value: "metadata_only" });
    expect(JSON.stringify(model)).not.toContain("prompt_plaintext");
  });

  it("uses stable fallbacks when an optional description, metric label, or artifact role is absent", () => {
    const view = displayFixture();
    const definition = { ...view.definition, description: undefined, metrics: [] };
    const result = {
      ...view.result,
      artifactChanges: [{ ...view.result.artifactChanges[1], candidate: undefined, candidateAvailability: undefined }],
    };
    const model = buildComparisonDisplay({ ...view, definition, result } as ComparisonView);

    expect(model.comparison.description).toBeUndefined();
    expect(model.metrics[0]?.label).toBe("metric_latency");
    expect(model.artifacts[0]).toEqual({ artifactId: "artifact_added", status: "unavailable" });
  });
});
