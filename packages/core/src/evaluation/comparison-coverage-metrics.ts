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

type CoverageComparisonMetric = Extract<ComparisonMetric, { readonly kind: "coverage_count" }>;
type EvaluationOutcome = ComparisonEvidenceFixtureSnapshot["evaluationOutcomes"][number];
type CoverageObservationState = "invalid" | "missing" | "observed";

interface ClassifiedCoverageObservation {
  readonly state: CoverageObservationState;
  readonly value?: bigint;
}

interface ClassifiedCoveragePopulation {
  readonly byFixtureId: ReadonlyMap<string, ClassifiedCoverageObservation>;
  readonly invalidCount: number;
  readonly missingCount: number;
  readonly observedCount: number;
  readonly totalCount: number;
}

export interface ComparisonCoverageMetricDerivation {
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

function exactCriterionMatches(
  outcome: EvaluationOutcome,
  metric: CoverageComparisonMetric,
): boolean {
  return (
    outcome.criterion.criterionId === metric.criterion.criterionId &&
    outcome.criterion.criterionSet.criterionSetId ===
      metric.criterion.criterionSet.criterionSetId &&
    outcome.criterion.criterionSet.criterionSetVersionId ===
      metric.criterion.criterionSet.criterionSetVersionId &&
    outcome.criterion.criterionSet.definitionSha256 ===
      metric.criterion.criterionSet.definitionSha256
  );
}

function fixtureMatchesDimension(
  outcomes: readonly EvaluationOutcome[],
  dimension: CoverageComparisonMetric["dimension"],
): boolean {
  switch (dimension) {
    case "abstention":
      return outcomes.some(({ counts }) => counts.abstain > 0);
    case "decided":
      return outcomes.some(({ counts }) => counts.fail + counts.notApplicable + counts.pass > 0);
    case "error":
      return outcomes.some(({ counts }) => counts.error > 0);
    case "observed":
      return true;
  }
}

function classifyCoverageObservation(
  fixtures: ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot>,
  comparisonCase: ComparisonCase | undefined,
  fixtureId: string,
  metric: CoverageComparisonMetric,
): ClassifiedCoverageObservation {
  if (!comparisonCase || comparisonCase.state === "invalid") return { state: "invalid" };
  const fixture = fixtures.get(fixtureId);
  if (!fixture) return { state: "missing" };
  const outcomes = fixture.evaluationOutcomes.filter((outcome) =>
    exactCriterionMatches(outcome, metric),
  );
  if (outcomes.length === 0) return { state: "missing" };
  return {
    state: "observed",
    value: fixtureMatchesDimension(outcomes, metric.dimension) ? 1n : 0n,
  };
}

function populationFromMap(
  byFixtureId: ReadonlyMap<string, ClassifiedCoverageObservation>,
): ClassifiedCoveragePopulation {
  const values = [...byFixtureId.values()];
  const count = (state: CoverageObservationState) =>
    values.filter((entry) => entry.state === state).length;
  return {
    byFixtureId,
    invalidCount: count("invalid"),
    missingCount: count("missing"),
    observedCount: count("observed"),
    totalCount: values.length,
  };
}

function classifyPopulation(
  fixtures: ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot>,
  cases: ReadonlyMap<string, ComparisonCase>,
  fixtureIds: readonly string[],
  metric: CoverageComparisonMetric,
): ClassifiedCoveragePopulation {
  return populationFromMap(
    new Map(
      fixtureIds.map((fixtureId) => [
        fixtureId,
        classifyCoverageObservation(fixtures, cases.get(fixtureId), fixtureId, metric),
      ]),
    ),
  );
}

function pairedState(
  baseline: ClassifiedCoverageObservation,
  candidate: ClassifiedCoverageObservation,
): CoverageObservationState {
  if (baseline.state === "invalid" || candidate.state === "invalid") return "invalid";
  if (baseline.state === "missing" || candidate.state === "missing") return "missing";
  return "observed";
}

function exactCount(value: bigint, unit: string): ComparisonExactValue {
  return {
    denominator: "1",
    numerator: value.toString(),
    representation: "rational",
    unit,
  };
}

function observedSum(
  population: ClassifiedCoveragePopulation,
  fixtureIds: readonly string[],
): bigint {
  return fixtureIds.reduce(
    (sum, fixtureId) => sum + (population.byFixtureId.get(fixtureId)?.value ?? 0n),
    0n,
  );
}

function unavailableMetricReasons(
  baseline: ClassifiedCoveragePopulation,
  candidate: ClassifiedCoveragePopulation,
  paired: ClassifiedCoveragePopulation,
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
  baseline: ClassifiedCoveragePopulation,
  candidate: ClassifiedCoveragePopulation,
  paired: ClassifiedCoveragePopulation,
  observedPairedFixtureIds: readonly string[],
  metric: CoverageComparisonMetric,
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
 * Counts criterion-scoped logical fixtures with observed, abstained, errored, or decided outcomes.
 * A retained zero is distinct from a missing criterion outcome, and only exact paired observations
 * enter the delta arithmetic.
 */
export function deriveComparisonCoverageMetrics(
  input: PairComparisonEvidenceInput,
): ComparisonCoverageMetricDerivation {
  const pairing = pairComparisonEvidence(input);
  const cases = caseMap(pairing.cases);
  const baselineFixtures = fixtureMap(input.baseline);
  const candidateFixtures = fixtureMap(input.candidate);
  const strata = new Map(input.comparison.strata.map((entry) => [entry.stratumId, entry]));
  const metricResults: ComparisonMetricResult[] = [];

  for (const metric of input.comparison.metrics) {
    if (metric.kind !== "coverage_count") continue;
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
    const pairedByFixtureId = new Map<string, ClassifiedCoverageObservation>();
    for (const fixtureId of stratum.fixtureIds) {
      if (cases.get(fixtureId)?.state !== "paired") continue;
      const baselineObservation = baseline.byFixtureId.get(fixtureId) ?? { state: "invalid" };
      const candidateObservation = candidate.byFixtureId.get(fixtureId) ?? { state: "invalid" };
      pairedByFixtureId.set(fixtureId, {
        state: pairedState(baselineObservation, candidateObservation),
      });
    }
    const paired = populationFromMap(pairedByFixtureId);
    const observedPairedFixtureIds = [...paired.byFixtureId]
      .filter(([, observation]) => observation.state === "observed")
      .map(([fixtureId]) => fixtureId);
    metricResults.push(metricResult(baseline, candidate, paired, observedPairedFixtureIds, metric));
  }

  return { metricResults };
}
