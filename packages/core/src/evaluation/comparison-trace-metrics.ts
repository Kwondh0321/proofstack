import {
  type ComparisonCase,
  type ComparisonEvidenceFixtureSnapshot,
  type ComparisonEvidenceSnapshot,
  type ComparisonExactValue,
  type ComparisonMetric,
  type ComparisonMetricResult,
  ComparisonMetricResultSchema,
  ComparisonMetricSampleCountsSchema,
} from "@proofstack/contracts";
import {
  compareComparisonExactValues,
  subtractComparisonExactValues,
} from "./comparison-exact-arithmetic.js";
import { type PairComparisonEvidenceInput, pairComparisonEvidence } from "./comparison-pairing.js";

type TraceComparisonMetric = Extract<ComparisonMetric, { readonly kind: "trace_event_count" }>;
type TraceObservationState = "invalid" | "missing" | "observed";

interface ClassifiedTraceObservation {
  readonly state: TraceObservationState;
  readonly value?: bigint;
}

interface ClassifiedTracePopulation {
  readonly byFixtureId: ReadonlyMap<string, ClassifiedTraceObservation>;
  readonly invalidCount: number;
  readonly missingCount: number;
  readonly observedCount: number;
  readonly totalCount: number;
}

export interface ComparisonTraceMetricDerivation {
  readonly metricResults: readonly ComparisonMetricResult[];
}

function fixtureMap(
  snapshot: ComparisonEvidenceSnapshot,
): ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot> {
  return new Map(snapshot.fixtures.map((entry) => [entry.fixture.fixtureId, entry]));
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

function traceCount(
  fixture: ComparisonEvidenceFixtureSnapshot,
  metric: TraceComparisonMetric,
): bigint {
  if (metric.eventStatus === undefined) {
    return BigInt(
      fixture.trace.eventKinds.find(({ kind }) => kind === metric.eventKind)?.count ?? 0,
    );
  }
  return BigInt(
    fixture.trace.eventKindStatuses.find(
      ({ kind, status }) => kind === metric.eventKind && status === metric.eventStatus,
    )?.count ?? 0,
  );
}

function classifyTraceObservation(
  fixtures: ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot>,
  comparisonCase: ComparisonCase | undefined,
  fixtureId: string,
  metric: TraceComparisonMetric,
): ClassifiedTraceObservation {
  if (!comparisonCase || comparisonCase.state === "invalid") return { state: "invalid" };
  const fixture = fixtures.get(fixtureId);
  if (!fixture) return { state: "missing" };
  return { state: "observed", value: traceCount(fixture, metric) };
}

function classifyPopulation(
  fixtures: ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot>,
  cases: ReadonlyMap<string, ComparisonCase>,
  fixtureIds: readonly string[],
  metric: TraceComparisonMetric,
): ClassifiedTracePopulation {
  const byFixtureId = new Map<string, ClassifiedTraceObservation>();
  const counts: Record<TraceObservationState, number> = {
    invalid: 0,
    missing: 0,
    observed: 0,
  };
  for (const fixtureId of fixtureIds) {
    const classified = classifyTraceObservation(fixtures, cases.get(fixtureId), fixtureId, metric);
    byFixtureId.set(fixtureId, classified);
    counts[classified.state] += 1;
  }
  return {
    byFixtureId,
    invalidCount: counts.invalid,
    missingCount: counts.missing,
    observedCount: counts.observed,
    totalCount: fixtureIds.length,
  };
}

function pairedState(
  baseline: ClassifiedTraceObservation,
  candidate: ClassifiedTraceObservation,
): TraceObservationState {
  if (baseline.state === "invalid" || candidate.state === "invalid") return "invalid";
  if (baseline.state === "missing" || candidate.state === "missing") return "missing";
  return "observed";
}

function populationFromMap(
  byFixtureId: ReadonlyMap<string, ClassifiedTraceObservation>,
): ClassifiedTracePopulation {
  const count = (state: TraceObservationState) =>
    [...byFixtureId.values()].filter((entry) => entry.state === state).length;
  return {
    byFixtureId,
    invalidCount: count("invalid"),
    missingCount: count("missing"),
    observedCount: count("observed"),
    totalCount: byFixtureId.size,
  };
}

function exactCount(value: bigint, unit: string): ComparisonExactValue {
  return {
    denominator: "1",
    numerator: value.toString(),
    representation: "rational",
    unit,
  };
}

function observedSum(population: ClassifiedTracePopulation, fixtureIds: readonly string[]): bigint {
  return fixtureIds.reduce(
    (sum, fixtureId) => sum + (population.byFixtureId.get(fixtureId)?.value ?? 0n),
    0n,
  );
}

function unavailableMetricReasons(
  baseline: ClassifiedTracePopulation,
  candidate: ClassifiedTracePopulation,
  paired: ClassifiedTracePopulation,
): readonly (
  | "baseline_missing"
  | "candidate_missing"
  | "insufficient_observations"
  | "invalid_observations"
)[] {
  const reasons = new Set<
    "baseline_missing" | "candidate_missing" | "insufficient_observations" | "invalid_observations"
  >(["insufficient_observations"]);
  if (baseline.observedCount === 0) reasons.add("baseline_missing");
  if (candidate.observedCount === 0) reasons.add("candidate_missing");
  if (baseline.invalidCount + candidate.invalidCount + paired.invalidCount > 0) {
    reasons.add("invalid_observations");
  }
  return [...reasons].sort();
}

function metricResult(
  baseline: ClassifiedTracePopulation,
  candidate: ClassifiedTracePopulation,
  paired: ClassifiedTracePopulation,
  observedPairedFixtureIds: readonly string[],
  metric: TraceComparisonMetric,
): ComparisonMetricResult {
  const samples = ComparisonMetricSampleCountsSchema.parse({
    baselineInvalidCount: baseline.invalidCount,
    baselineMissingCount: baseline.missingCount,
    baselineObservedCount: baseline.observedCount,
    baselineTotalCount: baseline.totalCount,
    baselineUnavailableCount: 0,
    candidateInvalidCount: candidate.invalidCount,
    candidateMissingCount: candidate.missingCount,
    candidateObservedCount: candidate.observedCount,
    candidateTotalCount: candidate.totalCount,
    candidateUnavailableCount: 0,
    pairedInvalidCount: paired.invalidCount,
    pairedMissingCount: paired.missingCount,
    pairedObservedCount: paired.observedCount,
    pairedTotalCount: paired.totalCount,
    pairedUnavailableCount: 0,
  });
  if (paired.observedCount === 0) {
    return ComparisonMetricResultSchema.parse({
      kind: metric.kind,
      metricId: metric.metricId,
      samples,
      unit: metric.unit,
      value: {
        reasons: unavailableMetricReasons(baseline, candidate, paired),
        status: "unavailable",
      },
    });
  }
  const baselineValue = exactCount(observedSum(baseline, observedPairedFixtureIds), metric.unit);
  const candidateValue = exactCount(observedSum(candidate, observedPairedFixtureIds), metric.unit);
  const ordering = compareComparisonExactValues(candidateValue, baselineValue);
  return ComparisonMetricResultSchema.parse({
    kind: metric.kind,
    metricId: metric.metricId,
    samples,
    unit: metric.unit,
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
 * Derives event-kind counts, optionally filtered by exact event status, from immutable fixture
 * snapshots. A zero count is an observed value; absent and invalid fixture evidence remains
 * explicit and only valid logical fixture pairs contribute to deltas.
 */
export function deriveComparisonTraceMetrics(
  input: PairComparisonEvidenceInput,
): ComparisonTraceMetricDerivation {
  const pairing = pairComparisonEvidence(input);
  const cases = caseMap(pairing.cases);
  const baselineFixtures = fixtureMap(input.baseline);
  const candidateFixtures = fixtureMap(input.candidate);
  const strata = new Map(input.comparison.strata.map((entry) => [entry.stratumId, entry]));
  const metricResults: ComparisonMetricResult[] = [];

  for (const metric of input.comparison.metrics) {
    if (metric.kind !== "trace_event_count") continue;
    const stratum = strata.get(metric.stratumId);
    if (!stratum) {
      throw new TypeError(`Validated comparison metric ${metric.metricId} has no exact stratum`);
    }
    const baseline = classifyPopulation(
      baselineFixtures,
      cases,
      subjectFixtureIds(input, "baseline", stratum.fixtureIds),
      metric,
    );
    const candidate = classifyPopulation(
      candidateFixtures,
      cases,
      subjectFixtureIds(input, "candidate", stratum.fixtureIds),
      metric,
    );
    const pairedFixtureIds = stratum.fixtureIds.filter(
      (fixtureId) => cases.get(fixtureId)?.state === "paired",
    );
    const pairedByFixtureId = new Map<string, ClassifiedTraceObservation>();
    for (const fixtureId of pairedFixtureIds) {
      const baselineObservation = baseline.byFixtureId.get(fixtureId) ?? { state: "invalid" };
      const candidateObservation = candidate.byFixtureId.get(fixtureId) ?? { state: "invalid" };
      pairedByFixtureId.set(fixtureId, {
        state: pairedState(baselineObservation, candidateObservation),
      });
    }
    const observedPairedFixtureIds = pairedFixtureIds.filter(
      (fixtureId) => pairedByFixtureId.get(fixtureId)?.state === "observed",
    );
    metricResults.push(
      metricResult(
        baseline,
        candidate,
        populationFromMap(pairedByFixtureId),
        observedPairedFixtureIds,
        metric,
      ),
    );
  }

  return { metricResults };
}
