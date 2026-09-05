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
} from "@proofstack/contracts";
import {
  aggregateComparisonExactValues,
  compareComparisonExactValues,
  subtractComparisonExactValues,
} from "./comparison-exact-arithmetic.js";
import { type PairComparisonEvidenceInput, pairComparisonEvidence } from "./comparison-pairing.js";

type NumericComparisonMetric = Extract<ComparisonMetric, { readonly kind: "numeric_measurement" }>;
type NumericObservation = ComparisonEvidenceFixtureSnapshot["numericObservations"][number];
type ObservationState = "invalid" | "missing" | "observed" | "unavailable";
type UnavailableReason = "measurement_unavailable" | "source_over_limit";

interface ClassifiedObservation {
  readonly state: ObservationState;
  readonly unavailableReason?: UnavailableReason;
  readonly value?: ComparisonExactValue;
}

interface ClassifiedPopulation {
  readonly byFixtureId: ReadonlyMap<string, ClassifiedObservation>;
  readonly invalidCount: number;
  readonly missingCount: number;
  readonly observedCount: number;
  readonly observedValues: readonly ComparisonExactValue[];
  readonly totalCount: number;
  readonly unavailableCount: number;
}

interface IndexedNumericObservation {
  readonly count: number;
  readonly first: NumericObservation;
}

interface NumericEvidenceIndex {
  readonly fixtures: ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot>;
  readonly observations: ReadonlyMap<string, ReadonlyMap<string, IndexedNumericObservation>>;
  readonly omissions: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyMap<string, UnavailableReason>>
  >;
}

export interface ComparisonNumericMetricDerivation {
  readonly distributions: readonly ComparisonDistributionSummary[];
  readonly metricResults: readonly ComparisonMetricResult[];
}

function fixtureMap(
  snapshot: ComparisonEvidenceSnapshot,
): ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot> {
  return new Map(snapshot.fixtures.map((entry) => [entry.fixture.fixtureId, entry]));
}

function numericEvidenceIndex(snapshot: ComparisonEvidenceSnapshot): NumericEvidenceIndex {
  const observations = new Map<string, Map<string, IndexedNumericObservation>>();
  for (const fixture of snapshot.fixtures) {
    const byMeasurement = new Map<string, IndexedNumericObservation>();
    for (const observation of fixture.numericObservations) {
      const existing = byMeasurement.get(observation.measurementName);
      byMeasurement.set(observation.measurementName, {
        count: (existing?.count ?? 0) + 1,
        first: existing?.first ?? observation,
      });
    }
    observations.set(fixture.fixture.fixtureId, byMeasurement);
  }

  const omissions = new Map<string, Map<string, Map<string, UnavailableReason>>>();
  for (const omission of snapshot.omissions) {
    if (omission.sourceKind !== "numeric_measurement") continue;
    const byMeasurement = omissions.get(omission.fixtureId) ?? new Map();
    const byUnit = byMeasurement.get(omission.measurementName) ?? new Map();
    byUnit.set(omission.unit, omission.reason);
    byMeasurement.set(omission.measurementName, byUnit);
    omissions.set(omission.fixtureId, byMeasurement);
  }
  return { fixtures: fixtureMap(snapshot), observations, omissions };
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

function classifyObservation(
  index: NumericEvidenceIndex,
  comparisonCase: ComparisonCase | undefined,
  metric: NumericComparisonMetric,
  fixtureId: string,
): ClassifiedObservation {
  if (!comparisonCase || comparisonCase.state === "invalid") return { state: "invalid" };
  if (!index.fixtures.has(fixtureId)) return { state: "missing" };

  const indexedObservation = index.observations.get(fixtureId)?.get(metric.measurementName);
  if (indexedObservation && indexedObservation.count > 1) return { state: "invalid" };
  const observation = indexedObservation?.first;
  if (observation) {
    if (observation.unit !== metric.unit) return { state: "invalid" };
    return {
      state: "observed",
      value: { representation: "decimal", unit: observation.unit, value: observation.value },
    };
  }

  const omissionReason = index.omissions
    .get(fixtureId)
    ?.get(metric.measurementName)
    ?.get(metric.unit);
  if (omissionReason) {
    return { state: "unavailable", unavailableReason: omissionReason };
  }
  return { state: "missing" };
}

function classifyPopulation(
  index: NumericEvidenceIndex,
  cases: ReadonlyMap<string, ComparisonCase>,
  fixtureIds: readonly string[],
  metric: NumericComparisonMetric,
): ClassifiedPopulation {
  const byFixtureId = new Map<string, ClassifiedObservation>();
  const observedValues: ComparisonExactValue[] = [];
  const counts: Record<ObservationState, number> = {
    invalid: 0,
    missing: 0,
    observed: 0,
    unavailable: 0,
  };
  for (const fixtureId of fixtureIds) {
    const classified = classifyObservation(index, cases.get(fixtureId), metric, fixtureId);
    byFixtureId.set(fixtureId, classified);
    counts[classified.state] += 1;
    if (classified.value) observedValues.push(classified.value);
  }
  return {
    byFixtureId,
    invalidCount: counts.invalid,
    missingCount: counts.missing,
    observedCount: counts.observed,
    observedValues,
    totalCount: fixtureIds.length,
    unavailableCount: counts.unavailable,
  };
}

function pairedState(
  baseline: ClassifiedObservation,
  candidate: ClassifiedObservation,
): ObservationState {
  if (baseline.state === "invalid" || candidate.state === "invalid") return "invalid";
  if (baseline.state === "unavailable" || candidate.state === "unavailable") {
    return "unavailable";
  }
  if (baseline.state === "missing" || candidate.state === "missing") return "missing";
  return "observed";
}

function unavailableMetricReasons(
  baseline: ClassifiedPopulation,
  candidate: ClassifiedPopulation,
  paired: ClassifiedPopulation,
): readonly (
  | "baseline_missing"
  | "candidate_missing"
  | "insufficient_observations"
  | "invalid_observations"
  | "measurement_unavailable"
  | "source_over_limit"
)[] {
  const reasons = new Set<
    | "baseline_missing"
    | "candidate_missing"
    | "insufficient_observations"
    | "invalid_observations"
    | "measurement_unavailable"
    | "source_over_limit"
  >(["insufficient_observations"]);
  if (baseline.observedCount === 0) reasons.add("baseline_missing");
  if (candidate.observedCount === 0) reasons.add("candidate_missing");
  if (baseline.invalidCount + candidate.invalidCount + paired.invalidCount > 0) {
    reasons.add("invalid_observations");
  }
  const classifications = [
    ...baseline.byFixtureId.values(),
    ...candidate.byFixtureId.values(),
    ...paired.byFixtureId.values(),
  ];
  if (classifications.some(({ unavailableReason }) => unavailableReason === "source_over_limit")) {
    reasons.add("source_over_limit");
  }
  if (
    classifications.some(({ unavailableReason }) => unavailableReason === "measurement_unavailable")
  ) {
    reasons.add("measurement_unavailable");
  }
  return [...reasons].sort();
}

function distribution(
  population: ClassifiedPopulation,
  metric: NumericComparisonMetric,
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
  baseline: ClassifiedPopulation,
  candidate: ClassifiedPopulation,
  paired: ClassifiedPopulation,
  pairedBaselineValues: readonly ComparisonExactValue[],
  pairedCandidateValues: readonly ComparisonExactValue[],
  metric: NumericComparisonMetric,
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
  if (paired.observedCount === 0) {
    return ComparisonMetricResultSchema.parse({
      metricId: metric.metricId,
      samples,
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
    metricId: metric.metricId,
    samples,
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
 * Derives numeric distributions from each exact role population and deltas only from observations
 * paired by the same logical fixture. Invalid, unavailable, and absent sources remain distinct and
 * never enter an aggregate as zero.
 */
export function deriveComparisonNumericMetrics(
  input: PairComparisonEvidenceInput,
): ComparisonNumericMetricDerivation {
  const pairing = pairComparisonEvidence(input);
  const cases = caseMap(pairing.cases);
  const baselineIndex = numericEvidenceIndex(input.baseline);
  const candidateIndex = numericEvidenceIndex(input.candidate);
  const strata = new Map(input.comparison.strata.map((entry) => [entry.stratumId, entry]));
  const distributions: ComparisonDistributionSummary[] = [];
  const metricResults: ComparisonMetricResult[] = [];

  for (const metric of input.comparison.metrics) {
    if (metric.kind !== "numeric_measurement") continue;
    const stratum = strata.get(metric.stratumId);
    if (!stratum) {
      throw new TypeError(`Validated comparison metric ${metric.metricId} has no exact stratum`);
    }
    const baselineIds = subjectFixtureIds(input, "baseline", stratum.fixtureIds);
    const candidateIds = subjectFixtureIds(input, "candidate", stratum.fixtureIds);
    const baseline = classifyPopulation(baselineIndex, cases, baselineIds, metric);
    const candidate = classifyPopulation(candidateIndex, cases, candidateIds, metric);

    const pairedIds = stratum.fixtureIds.filter(
      (fixtureId) => cases.get(fixtureId)?.state === "paired",
    );
    const pairedByFixtureId = new Map<string, ClassifiedObservation>();
    const pairedBaselineValues: ComparisonExactValue[] = [];
    const pairedCandidateValues: ComparisonExactValue[] = [];
    for (const fixtureId of pairedIds) {
      const baselineObservation = baseline.byFixtureId.get(fixtureId) ?? { state: "invalid" };
      const candidateObservation = candidate.byFixtureId.get(fixtureId) ?? { state: "invalid" };
      const state = pairedState(baselineObservation, candidateObservation);
      const unavailableReason =
        baselineObservation.unavailableReason ?? candidateObservation.unavailableReason;
      pairedByFixtureId.set(
        fixtureId,
        unavailableReason ? { state, unavailableReason } : { state },
      );
      if (state === "observed" && baselineObservation.value && candidateObservation.value) {
        pairedBaselineValues.push(baselineObservation.value);
        pairedCandidateValues.push(candidateObservation.value);
      }
    }
    const paired = classifyPopulationFromMap(pairedByFixtureId);
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

function classifyPopulationFromMap(
  byFixtureId: ReadonlyMap<string, ClassifiedObservation>,
): ClassifiedPopulation {
  const observedValues = [...byFixtureId.values()].flatMap(({ value }) => (value ? [value] : []));
  const count = (state: ObservationState) =>
    [...byFixtureId.values()].filter((entry) => entry.state === state).length;
  return {
    byFixtureId,
    invalidCount: count("invalid"),
    missingCount: count("missing"),
    observedCount: count("observed"),
    observedValues,
    totalCount: byFixtureId.size,
    unavailableCount: count("unavailable"),
  };
}
