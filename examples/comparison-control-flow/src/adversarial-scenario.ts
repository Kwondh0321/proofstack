import {
  type ComparisonDefinition,
  OpaqueIdSchema,
  PublishComparisonDefinitionRequestSchema,
} from "@proofstack/contracts";
import type { ComparisonEvidenceResolution } from "@proofstack/core";
import type { ComparisonScenario } from "./scenario.js";
import { comparisonDefinitionTemplate, comparisonSnapshotTemplate } from "./templates.js";

const BASELINE_ARTIFACT_SHA256 = "6".repeat(64);
const CANDIDATE_ARTIFACT_SHA256 = "b".repeat(64);

/**
 * A deliberately adverse but valid source graph for the durable service acceptance path.
 * It keeps one logical case pair while changing its exact fixture version and output artifact,
 * withholding candidate provider cost, and retaining unresolved model disagreement.
 */
export class AdversarialComparisonScenario implements ComparisonScenario {
  readonly ids: ComparisonScenario["ids"];
  readonly fixtureId: string;

  constructor(readonly namespace: string) {
    if (!/^[a-z0-9]{1,20}$/.test(namespace)) {
      throw new TypeError("Comparison namespace must contain 1-20 lowercase characters or digits");
    }
    const id = (prefix: string): string => OpaqueIdSchema.parse(`${prefix}_${namespace}`);
    this.ids = Object.freeze({
      comparison: id("comparison_adversarial"),
      comparisonVersion: id("comparison_adversarial_v1"),
      result: id("result_adversarial"),
      snapshotBaseline: id("snapshot_adversarial_baseline"),
      snapshotCandidate: id("snapshot_adversarial_candidate"),
    });
    this.fixtureId = id("fixture_adversarial");
  }

  definition() {
    const template = comparisonDefinitionTemplate();
    const baselineSource = template.baseline.fixtures[0];
    const candidateSource = template.candidate.fixtures[0];
    /* v8 ignore next -- The checked-in definition vector requires one fixture per subject. */
    if (!baselineSource || !candidateSource)
      throw new TypeError("Comparison vector omitted fixture");
    const artifactId = OpaqueIdSchema.parse(`artifact_adversarial_${this.namespace}`);
    const dataset = {
      ...template.baseline.dataset,
      datasetId: OpaqueIdSchema.parse(`dataset_adversarial_${this.namespace}`),
      datasetVersionId: OpaqueIdSchema.parse(`dataset_adversarial_v1_${this.namespace}`),
    };
    const fixture = (
      source: typeof baselineSource,
      role: "baseline" | "candidate",
    ): typeof baselineSource => ({
      ...structuredClone(source),
      fixture: {
        ...source.fixture,
        fixtureId: this.fixtureId,
        fixtureVersionId: OpaqueIdSchema.parse(
          `fixture_adversarial_${role === "baseline" ? "v1" : "v2"}_${this.namespace}`,
        ),
      },
      replay: {
        ...structuredClone(source.replay),
        attemptId: OpaqueIdSchema.parse(`attempt_adversarial_${role}_${this.namespace}`),
        jobId: OpaqueIdSchema.parse(`job_adversarial_${role}_${this.namespace}`),
        result: {
          ...source.replay.result,
          artifactId,
          sha256: role === "baseline" ? BASELINE_ARTIFACT_SHA256 : CANDIDATE_ARTIFACT_SHA256,
          sizeBytes: role === "baseline" ? 256 : 384,
        },
      },
    });
    const aggregation = { method: "median", methodVersion: "1.0.0" } as const;
    return PublishComparisonDefinitionRequestSchema.parse({
      baseline: {
        dataset: structuredClone(dataset),
        fixtures: [fixture(baselineSource, "baseline")],
      },
      calculationPolicy: template.calculationPolicy,
      candidate: {
        dataset: structuredClone(dataset),
        fixtures: [fixture(candidateSource, "candidate")],
      },
      classifiedContentProjection: "metadata_only",
      comparisonVersionId: this.ids.comparisonVersion,
      description:
        "Exercise missing usage, fixture mismatch, artifact change, and disagreement without a release decision",
      metrics: [
        {
          kind: "artifact_set",
          label: "Output artifact set",
          metricId: "metric_artifacts",
          projection: "identity_digest_size_classification_availability",
          stratumId: "stratum_all",
          unit: "artifacts",
        },
        {
          condition: "unresolved_disagreement",
          dimension: "disagreement",
          kind: "assurance_state_count",
          label: "Unresolved model disagreement",
          metricId: "metric_disagreement",
          stratumId: "stratum_all",
          unit: "assurance_records",
        },
        {
          aggregation,
          dimension: "elapsedMilliseconds",
          kind: "replay_usage",
          label: "Median elapsed milliseconds",
          metricId: "metric_elapsed",
          stratumId: "stratum_all",
          unit: "milliseconds",
        },
        {
          aggregation,
          dimension: "providerCostMicrounits",
          kind: "replay_usage",
          label: "Provider-reported cost",
          metricId: "metric_provider_cost",
          stratumId: "stratum_all",
          unit: "provider_cost_microunits",
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
          metricId: "metric_trace_events",
          stratumId: "stratum_all",
          unit: "events",
        },
      ],
      name: `Adversarial comparison ${this.ids.comparisonVersion}`,
      strata: [
        { fixtureIds: [this.fixtureId], label: "Exact logical case", stratumId: "stratum_all" },
      ],
    });
  }

  resolve(
    comparison: ComparisonDefinition,
    role: "baseline" | "candidate",
  ): ComparisonEvidenceResolution {
    const subject = comparison[role];
    const fixture = subject.fixtures[0];
    const templateFixture = comparisonSnapshotTemplate().fixtures[0];
    /* v8 ignore next -- Strict definitions and vectors both require at least one fixture. */
    if (!fixture || !templateFixture) throw new TypeError("Comparison source omitted fixture");
    const assessment = fixture.assessments[0];
    const modelAssurance = fixture.modelAssuranceAssessments[0];
    /* v8 ignore next -- The exact scenario binds both required assurance references. */
    if (!assessment || !modelAssurance) throw new TypeError("Comparison source omitted assurance");
    const criterion = templateFixture.evaluationOutcomes[0]?.criterion;
    /* v8 ignore next -- The checked-in snapshot vector binds one exact criterion. */
    if (!criterion) throw new TypeError("Comparison snapshot vector omitted criterion");
    const candidate = role === "candidate";
    const commonLimitation =
      "Synthetic acceptance evidence does not establish representative agent behavior.";
    return {
      dataset: structuredClone(subject.dataset),
      fixtures: [
        {
          artifacts: [
            { artifact: structuredClone(fixture.replay.result), availability: "available" },
          ],
          assurance: [
            {
              eligibility: "ineligible",
              kind: "assessment",
              reasons: ["human_review_required"],
              reference: structuredClone(assessment),
            },
            candidate
              ? {
                  eligibility: "ineligible",
                  kind: "model_assurance",
                  reasons: ["unresolved_disagreement"],
                  reference: structuredClone(modelAssurance),
                }
              : {
                  eligibility: "eligible",
                  kind: "model_assurance",
                  reasons: [],
                  reference: structuredClone(modelAssurance),
                },
          ],
          evaluationOutcomes: [
            {
              assessment: structuredClone(assessment),
              counts: candidate
                ? { abstain: 0, error: 0, fail: 0, notApplicable: 0, pass: 1, total: 1 }
                : { abstain: 0, error: 0, fail: 1, notApplicable: 0, pass: 0, total: 1 },
              criterion: structuredClone(criterion),
            },
          ],
          fixture: structuredClone(fixture.fixture),
          numericObservations: [],
          replay: structuredClone(fixture.replay),
          safetyEvents: candidate
            ? [
                {
                  eventId: `safety_guardrail_a_${this.namespace}`,
                  kind: "guardrail_check",
                  occurredAt: "2026-09-02T01:04:58.000Z",
                  sourceId: `event_guardrail_a_${this.namespace}`,
                  sourceSha256: "c".repeat(64),
                },
                {
                  eventId: `safety_guardrail_b_${this.namespace}`,
                  kind: "guardrail_check",
                  occurredAt: "2026-09-02T01:04:59.000Z",
                  sourceId: `event_guardrail_b_${this.namespace}`,
                  sourceSha256: "d".repeat(64),
                },
              ]
            : [
                {
                  eventId: `safety_guardrail_a_${this.namespace}`,
                  kind: "guardrail_check",
                  occurredAt: "2026-09-02T00:59:59.000Z",
                  sourceId: `event_guardrail_a_${this.namespace}`,
                  sourceSha256: "c".repeat(64),
                },
              ],
          trace: structuredClone(templateFixture.trace),
          usage: [
            {
              dimension: "elapsedMilliseconds",
              value: {
                amount: candidate ? 100 : 125,
                observedCount: 1,
                sources: ["measured"],
                status: "available",
                unavailableCount: 0,
              },
            },
            candidate
              ? {
                  dimension: "providerCostMicrounits",
                  value: {
                    observedCount: 0,
                    status: "unavailable",
                    unavailableCount: 1,
                    unavailableReasons: ["provider_did_not_report"],
                  },
                }
              : {
                  dimension: "providerCostMicrounits",
                  value: {
                    amount: 5_000,
                    observedCount: 1,
                    sources: ["provider_reported"],
                    status: "available",
                    unavailableCount: 0,
                  },
                },
          ],
        },
      ],
      integrity: "verified",
      knownLimitations: candidate
        ? ["Candidate provider cost is intentionally unavailable.", commonLimitation]
        : [commonLimitation],
      omissions: [
        {
          fixtureId: this.fixtureId,
          projectionKey: "prompt_plaintext",
          reason: "classified_content_excluded",
          sourceKind: "classified_content",
        },
      ],
      sourceCutoff: fixture.replay.completedAt,
    };
  }
}
