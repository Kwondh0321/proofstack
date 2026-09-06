import {
  type ComparisonSubject,
  type ComparisonSubjectFixture,
  type PublishComparisonDefinitionRequest,
  PublishComparisonDefinitionRequestSchema,
} from "@proofstack/contracts";

export interface Workflow1ExactEvidence {
  readonly assessment: ComparisonSubjectFixture["assessments"][number];
  readonly baselineReplay: ComparisonSubjectFixture["replay"];
  readonly candidateReplay: ComparisonSubjectFixture["replay"];
  readonly dataset: ComparisonSubject["dataset"];
  readonly fixture: ComparisonSubjectFixture["fixture"];
  readonly modelAssuranceAssessment: ComparisonSubjectFixture["modelAssuranceAssessments"][number];
}

export interface Workflow1ComparisonDefinition {
  readonly comparisonId: string;
  readonly comparisonVersionId: string;
  readonly request: PublishComparisonDefinitionRequest;
  readonly resultId: string;
  readonly snapshotIds: {
    readonly baseline: string;
    readonly candidate: string;
  };
}

/** Binds two exact retained replay results to one shared incident and assurance graph. */
export function createWorkflow1ComparisonDefinition(
  namespace: string,
  evidence: Workflow1ExactEvidence,
): Workflow1ComparisonDefinition {
  const comparisonId = `cmp_workflow1_${namespace}`;
  const comparisonVersionId = `cmpv_workflow1_${namespace}`;
  const stratumId = `str_workflow1_${namespace}`;
  const subject = (replay: ComparisonSubjectFixture["replay"]): ComparisonSubject => ({
    dataset: structuredClone(evidence.dataset),
    fixtures: [
      {
        assessments: [structuredClone(evidence.assessment)],
        fixture: structuredClone(evidence.fixture),
        modelAssuranceAssessments: [structuredClone(evidence.modelAssuranceAssessment)],
        replay: structuredClone(replay),
      },
    ],
  });
  const request = PublishComparisonDefinitionRequestSchema.parse({
    baseline: subject(evidence.baselineReplay),
    calculationPolicy: {
      confidenceIntervals: "source_only",
      decimalArithmetic: "exact_decimal_v1",
      denominators: "role_fixture_membership_and_paired_observations",
      fixturePairing: "logical_fixture_id",
      invalidCases: "preserve_and_exclude_from_aggregation",
      mean: "exact_rational_v1",
      minimumPairedCoverageBasisPoints: 10_000,
      missingness: "preserve_all",
      numericObservationMultiplicity: "at_most_one_per_fixture",
      quantile: "nearest_rank_v1",
    },
    candidate: subject(evidence.candidateReplay),
    classifiedContentProjection: "metadata_only",
    comparisonVersionId,
    description:
      "Compare two exact durable replays of one retained failed interaction and assurance graph.",
    metrics: [
      {
        aggregation: { method: "median", methodVersion: "1.0.0" },
        dimension: "elapsedMilliseconds",
        kind: "replay_usage",
        label: "Median replay elapsed time",
        metricId: `met_elapsed_${namespace}`,
        stratumId,
        unit: "milliseconds",
      },
      {
        eventKind: "agent.run",
        kind: "trace_event_count",
        label: "Retained agent run events",
        metricId: `met_trace_${namespace}`,
        stratumId,
        unit: "events",
      },
    ],
    name: "Workflow 1 retained evidence acceptance comparison",
    strata: [
      {
        fixtureIds: [evidence.fixture.fixtureId],
        label: "Retained incident fixture",
        stratumId,
      },
    ],
  });

  return {
    comparisonId,
    comparisonVersionId,
    request,
    resultId: `cmpr_workflow1_${namespace}`,
    snapshotIds: {
      baseline: `cmps_baseline_${namespace}`,
      candidate: `cmps_candidate_${namespace}`,
    },
  };
}
