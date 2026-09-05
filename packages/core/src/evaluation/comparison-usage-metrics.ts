import {
  type ComparisonCase,
  type ComparisonDistributionSummary,
  ComparisonDistributionSummarySchema,
  type ComparisonEvidenceFixtureSnapshot,
  type ComparisonEvidenceSnapshot,
  type ComparisonExactValue,
  type ComparisonMetric,
  type ComparisonMetricResult,
  ComparisonMetricResultSchema,
  ComparisonMetricSampleCountsSchema,
  ComparisonUsageMetricProvenanceSchema,
} from "@proofstack/contracts";
import {
  aggregateComparisonExactValues,
  compareComparisonExactValues,
  subtractComparisonExactValues,
} from "./comparison-exact-arithmetic.js";
import { type PairComparisonEvidenceInput, pairComparisonEvidence } from "./comparison-pairing.js";

type UsageComparisonMetric = Extract<ComparisonMetric, { readonly kind: "replay_usage" }>;
type UsageDimension = ComparisonEvidenceFixtureSnapshot["usage"][number];
type UsageSource = "estimated" | "measured" | "provider_reported";
type UsageUnavailableReason =
  | "measurement_failed"
  | "provider_did_not_report"
  | "source_unavailable";
type UsageState = "invalid" | "missing" | "observed" | "unavailable";
type UsageAvailability = "complete" | "partial" | "unavailable";

interface ClassifiedUsage {
  readonly availability?: UsageAvailability;
  readonly observedSources: readonly UsageSource[];
  readonly state: UsageState;
  readonly unavailableReasons: readonly UsageUnavailableReason[];
  readonly value?: ComparisonExactValue;
}

interface ClassifiedUsagePopulation {
  readonly byFixtureId: ReadonlyMap<string, ClassifiedUsage>;
  readonly completeCount: number;
  readonly fullyUnavailableCount: number;
  readonly invalidCount: number;
  readonly missingCount: number;
  readonly observedCount: number;
  readonly observedSources: readonly UsageSource[];
  readonly observedValues: readonly ComparisonExactValue[];
  readonly partialCount: number;
  readonly totalCount: number;
  readonly unavailableCount: number;
  readonly unavailableReasons: readonly UsageUnavailableReason[];
}

interface UsageEvidenceIndex {
  readonly fixtures: ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot>;
  readonly usageByFixture: ReadonlyMap<string, ReadonlyMap<string, UsageDimension>>;
}

export interface ComparisonUsageMetricDerivation {
  readonly distributions: readonly ComparisonDistributionSummary[];
  readonly metricResults: readonly ComparisonMetricResult[];
}

const EMPTY_USAGE_CLASSIFICATION = {
  observedSources: [],
  unavailableReasons: [],
} as const;

function usageEvidenceIndex(snapshot: ComparisonEvidenceSnapshot): UsageEvidenceIndex {
  const fixtures = new Map<string, ComparisonEvidenceFixtureSnapshot>();
  const usageByFixture = new Map<string, Map<string, UsageDimension>>();
  for (const fixture of snapshot.fixtures) {
    const fixtureId = fixture.fixture.fixtureId;
    fixtures.set(fixtureId, fixture);
    usageByFixture.set(fixtureId, new Map(fixture.usage.map((entry) => [entry.dimension, entry])));
  }
  return { fixtures, usageByFixture };
}

function caseMap(cases: readonly ComparisonCase[]): ReadonlyMap<string, ComparisonCase> {
  return new Map(cases.map((entry) => [entry.fixtureId, entry]));
}

function subjectFixtureIds(
  input: PairComparisonEvidenceInput,
  role: "baseline" | "candidate",
  stratumFixtureIds: readonly string[],
): readonly string[] {
  const subject = new Set(input.comparison[role].fixtures.map(({ fixture }) => fixture.fixtureId));
  return stratumFixtureIds.filter((fixtureId) => subject.has(fixtureId));
}

function usageValue(amount: number, unit: string): ComparisonExactValue {
  return {
    denominator: "1",
    numerator: amount.toString(),
    representation: "rational",
    unit,
  };
}

function classifyUsage(
  index: UsageEvidenceIndex,
  comparisonCase: ComparisonCase | undefined,
  metric: UsageComparisonMetric,
  fixtureId: string,
): ClassifiedUsage {
  if (!comparisonCase || comparisonCase.state === "invalid") {
    return { ...EMPTY_USAGE_CLASSIFICATION, state: "invalid" };
  }
  if (!index.fixtures.has(fixtureId)) {
    return { ...EMPTY_USAGE_CLASSIFICATION, state: "missing" };
  }
  const usage = index.usageByFixture.get(fixtureId)?.get(metric.dimension);
  if (!usage) return { ...EMPTY_USAGE_CLASSIFICATION, state: "missing" };

  switch (usage.value.status) {
    case "available":
      return {
        availability: "complete",
        observedSources: usage.value.sources,
        state: "observed",
        unavailableReasons: [],
        value: usageValue(usage.value.amount, metric.unit),
      };
    case "partial":
      return {
        availability: "partial",
        observedSources: usage.value.sources,
        state: "unavailable",
        unavailableReasons: usage.value.unavailableReasons,
      };
    case "unavailable":
      return {
        availability: "unavailable",
        observedSources: [],
        state: "unavailable",
        unavailableReasons: usage.value.unavailableReasons,
      };
  }
}

function populationFromMap(
  byFixtureId: ReadonlyMap<string, ClassifiedUsage>,
): ClassifiedUsagePopulation {
  const values = [...byFixtureId.values()];
  const countState = (state: UsageState) => values.filter((entry) => entry.state === state).length;
  const countAvailability = (availability: UsageAvailability) =>
    values.filter((entry) => entry.availability === availability).length;
  return {
    byFixtureId,
    completeCount: countAvailability("complete"),
    fullyUnavailableCount: countAvailability("unavailable"),
    invalidCount: countState("invalid"),
    missingCount: countState("missing"),
    observedCount: countState("observed"),
    observedSources: [...new Set(values.flatMap((entry) => entry.observedSources))].sort(),
    observedValues: values.flatMap(({ value }) => (value ? [value] : [])),
    partialCount: countAvailability("partial"),
    totalCount: values.length,
    unavailableCount: countState("unavailable"),
    unavailableReasons: [...new Set(values.flatMap((entry) => entry.unavailableReasons))].sort(),
  };
}

function classifyPopulation(
  index: UsageEvidenceIndex,
  cases: ReadonlyMap<string, ComparisonCase>,
  fixtureIds: readonly string[],
  metric: UsageComparisonMetric,
): ClassifiedUsagePopulation {
  return populationFromMap(
    new Map(
      fixtureIds.map((fixtureId) => [
        fixtureId,
        classifyUsage(index, cases.get(fixtureId), metric, fixtureId),
      ]),
    ),
  );
}

function pairedState(baseline: ClassifiedUsage, candidate: ClassifiedUsage): UsageState {
  if (baseline.state === "invalid" || candidate.state === "invalid") return "invalid";
  if (baseline.state === "unavailable" || candidate.state === "unavailable") {
    return "unavailable";
  }
  if (baseline.state === "missing" || candidate.state === "missing") return "missing";
  return "observed";
}

function unavailableMetricReasons(
  baseline: ClassifiedUsagePopulation,
  candidate: ClassifiedUsagePopulation,
  paired: ClassifiedUsagePopulation,
): readonly (
  | "baseline_missing"
  | "candidate_missing"
  | "insufficient_observations"
  | "invalid_observations"
  | "measurement_unavailable"
)[] {
  const reasons = new Set<
    | "baseline_missing"
    | "candidate_missing"
    | "insufficient_observations"
    | "invalid_observations"
    | "measurement_unavailable"
  >(["insufficient_observations"]);
  if (baseline.observedCount === 0) reasons.add("baseline_missing");
  if (candidate.observedCount === 0) reasons.add("candidate_missing");
  if (baseline.invalidCount + candidate.invalidCount + paired.invalidCount > 0) {
    reasons.add("invalid_observations");
  }
  if (baseline.unavailableCount + candidate.unavailableCount + paired.unavailableCount > 0) {
    reasons.add("measurement_unavailable");
  }
  return [...reasons].sort();
}

function distribution(
  population: ClassifiedUsagePopulation,
  metric: UsageComparisonMetric,
  role: "baseline" | "candidate",
): ComparisonDistributionSummary | undefined {
  if (population.observedValues.length === 0) return undefined;
  return ComparisonDistributionSummarySchema.parse({
    invalidCount: population.invalidCount,
    method: metric.aggregation,
    metricId: metric.metricId,
    missingCount: population.missingCount,
    observedCount: population.observedCount,
    role,
    totalCount: population.totalCount,
    unavailableCount: population.unavailableCount,
    value: aggregateComparisonExactValues(population.observedValues, metric.aggregation),
  });
}

function metricResult(
  baseline: ClassifiedUsagePopulation,
  candidate: ClassifiedUsagePopulation,
  paired: ClassifiedUsagePopulation,
  pairedBaselineValues: readonly ComparisonExactValue[],
  pairedCandidateValues: readonly ComparisonExactValue[],
  metric: UsageComparisonMetric,
): ComparisonMetricResult {
  const samples = ComparisonMetricSampleCountsSchema.parse({
    baselineInvalidCount: baseline.invalidCount,
    baselineMissingCount: baseline.missingCount,
    baselineObservedCount: baseline.observedCount,
    baselineTotalCount: baseline.totalCount,
    baselineUnavailableCount: baseline.unavailableCount,
    candidateInvalidCount: candidate.invalidCount,
    candidateMissingCount: candidate.missingCount,
    candidateObservedCount: candidate.observedCount,
    candidateTotalCount: candidate.totalCount,
    candidateUnavailableCount: candidate.unavailableCount,
    pairedInvalidCount: paired.invalidCount,
    pairedMissingCount: paired.missingCount,
    pairedObservedCount: paired.observedCount,
    pairedTotalCount: paired.totalCount,
    pairedUnavailableCount: paired.unavailableCount,
  });
  const usageProvenance = ComparisonUsageMetricProvenanceSchema.parse({
    baseline: {
      completeCount: baseline.completeCount,
      observedSources: baseline.observedSources,
      partialCount: baseline.partialCount,
      unavailableCount: baseline.fullyUnavailableCount,
      unavailableReasons: baseline.unavailableReasons,
    },
    candidate: {
      completeCount: candidate.completeCount,
      observedSources: candidate.observedSources,
      partialCount: candidate.partialCount,
      unavailableCount: candidate.fullyUnavailableCount,
      unavailableReasons: candidate.unavailableReasons,
    },
  });
  if (paired.observedCount === 0) {
    return ComparisonMetricResultSchema.parse({
      kind: metric.kind,
      metricId: metric.metricId,
      samples,
      unit: metric.unit,
      usageProvenance,
      value: {
        reasons: unavailableMetricReasons(baseline, candidate, paired),
        status: "unavailable",
      },
    });
  }
  const baselineValue = aggregateComparisonExactValues(pairedBaselineValues, metric.aggregation);
  const candidateValue = aggregateComparisonExactValues(pairedCandidateValues, metric.aggregation);
  const ordering = compareComparisonExactValues(candidateValue, baselineValue);
  return ComparisonMetricResultSchema.parse({
    kind: metric.kind,
    metricId: metric.metricId,
    samples,
    unit: metric.unit,
    usageProvenance,
    value: {
      baseline: baselineValue,
      candidate: candidateValue,
      delta: subtractComparisonExactValues(baselineValue, candidateValue),
      direction: ordering === 0 ? "unchanged" : ordering < 0 ? "decreased" : "increased",
      status: "available",
    },
  });
}

/**
 * Derives replay-usage distributions and paired deltas only from complete usage values. Partial
 * usage remains unavailable for arithmetic while its measured sources and unavailability reasons
 * remain visible in the result provenance.
 */
export function deriveComparisonUsageMetrics(
  input: PairComparisonEvidenceInput,
): ComparisonUsageMetricDerivation {
  const pairing = pairComparisonEvidence(input);
  const cases = caseMap(pairing.cases);
  const baselineIndex = usageEvidenceIndex(input.baseline);
  const candidateIndex = usageEvidenceIndex(input.candidate);
  const strata = new Map(input.comparison.strata.map((entry) => [entry.stratumId, entry]));
  const distributions: ComparisonDistributionSummary[] = [];
  const metricResults: ComparisonMetricResult[] = [];

  for (const metric of input.comparison.metrics) {
    if (metric.kind !== "replay_usage") continue;
    const stratum = strata.get(metric.stratumId);
    if (!stratum) {
      throw new TypeError(`Validated comparison metric ${metric.metricId} has no exact stratum`);
    }
    const baseline = classifyPopulation(
      baselineIndex,
      cases,
      subjectFixtureIds(input, "baseline", stratum.fixtureIds),
      metric,
    );
    const candidate = classifyPopulation(
      candidateIndex,
      cases,
      subjectFixtureIds(input, "candidate", stratum.fixtureIds),
      metric,
    );
    const pairedByFixtureId = new Map<string, ClassifiedUsage>();
    const pairedBaselineValues: ComparisonExactValue[] = [];
    const pairedCandidateValues: ComparisonExactValue[] = [];
    for (const fixtureId of stratum.fixtureIds) {
      if (cases.get(fixtureId)?.state !== "paired") continue;
      const baselineUsage = baseline.byFixtureId.get(fixtureId) ?? {
        ...EMPTY_USAGE_CLASSIFICATION,
        state: "invalid" as const,
      };
      const candidateUsage = candidate.byFixtureId.get(fixtureId) ?? {
        ...EMPTY_USAGE_CLASSIFICATION,
        state: "invalid" as const,
      };
      const state = pairedState(baselineUsage, candidateUsage);
      pairedByFixtureId.set(fixtureId, {
        observedSources: [
          ...new Set([...baselineUsage.observedSources, ...candidateUsage.observedSources]),
        ].sort(),
        state,
        unavailableReasons: [
          ...new Set([...baselineUsage.unavailableReasons, ...candidateUsage.unavailableReasons]),
        ].sort(),
      });
      if (state === "observed" && baselineUsage.value && candidateUsage.value) {
        pairedBaselineValues.push(baselineUsage.value);
        pairedCandidateValues.push(candidateUsage.value);
      }
    }
    const paired = populationFromMap(pairedByFixtureId);
    const baselineDistribution = distribution(baseline, metric, "baseline");
    const candidateDistribution = distribution(candidate, metric, "candidate");
    if (baselineDistribution) distributions.push(baselineDistribution);
    if (candidateDistribution) distributions.push(candidateDistribution);
    metricResults.push(
      metricResult(
        baseline,
        candidate,
        paired,
        pairedBaselineValues,
        pairedCandidateValues,
        metric,
      ),
    );
  }

  return { distributions, metricResults };
}
