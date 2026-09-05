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

type AssuranceComparisonMetric = Extract<
  ComparisonMetric,
  { readonly kind: "assurance_state_count" }
>;
type AssuranceState = ComparisonEvidenceFixtureSnapshot["assurance"][number];
type ModelAssuranceState = Extract<AssuranceState, { readonly kind: "model_assurance" }>;
type AssuranceObservationState = "invalid" | "missing" | "observed";

interface ClassifiedAssuranceObservation {
  readonly state: AssuranceObservationState;
  readonly value?: bigint;
}

interface ClassifiedAssurancePopulation {
  readonly byFixtureId: ReadonlyMap<string, ClassifiedAssuranceObservation>;
  readonly invalidCount: number;
  readonly missingCount: number;
  readonly observedCount: number;
  readonly totalCount: number;
}

export interface ComparisonAssuranceMetricDerivation {
  readonly metricResults: readonly ComparisonMetricResult[];
}

const CALIBRATION_REASONS = [
  "calibration_incompatible",
  "calibration_stale",
  "calibration_unavailable",
] as const;

const DISAGREEMENT_REASONS = ["order_sensitive_result", "unresolved_disagreement"] as const;

const HUMAN_REVIEW_REASONS = [
  "human_review_conflicted",
  "human_review_expired",
  "human_review_invalid",
  "human_review_missing",
  "human_review_protocol_mismatch",
  "human_review_quorum_shortfall",
] as const;

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

function hasAnyReason(
  state: ModelAssuranceState,
  reasons: readonly ModelAssuranceState["reasons"][number][],
): boolean {
  return reasons.some((reason) => state.reasons.includes(reason));
}

function assuranceStateMatches(
  state: AssuranceState,
  condition: AssuranceComparisonMetric["condition"],
): boolean {
  switch (condition) {
    case "assessment_eligible":
      return state.kind === "assessment" && state.eligibility === "eligible";
    case "assessment_ineligible":
      return state.kind === "assessment" && state.eligibility === "ineligible";
    case "model_assurance_eligible":
      return state.kind === "model_assurance" && state.eligibility === "eligible";
    case "model_assurance_ineligible":
      return state.kind === "model_assurance" && state.eligibility === "ineligible";
    case "calibration_available":
      return state.kind === "model_assurance" && !hasAnyReason(state, CALIBRATION_REASONS);
    case "calibration_incompatible":
    case "calibration_stale":
    case "calibration_unavailable":
      return state.kind === "model_assurance" && state.reasons.includes(condition);
    case "critical_counterevidence_absent":
      return (
        state.kind === "model_assurance" && !state.reasons.includes("critical_counterevidence")
      );
    case "critical_counterevidence_present":
      return state.kind === "model_assurance" && state.reasons.includes("critical_counterevidence");
    case "disagreement_absent":
      return state.kind === "model_assurance" && !hasAnyReason(state, DISAGREEMENT_REASONS);
    case "order_sensitive_result":
    case "unresolved_disagreement":
      return state.kind === "model_assurance" && state.reasons.includes(condition);
    case "human_review_available":
      return state.kind === "model_assurance" && !hasAnyReason(state, HUMAN_REVIEW_REASONS);
    case "human_review_conflicted":
    case "human_review_expired":
    case "human_review_invalid":
    case "human_review_missing":
    case "human_review_protocol_mismatch":
    case "human_review_quorum_shortfall":
      return state.kind === "model_assurance" && state.reasons.includes(condition);
  }
}

function classifyAssuranceObservation(
  fixtures: ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot>,
  comparisonCase: ComparisonCase | undefined,
  fixtureId: string,
  metric: AssuranceComparisonMetric,
): ClassifiedAssuranceObservation {
  if (!comparisonCase || comparisonCase.state === "invalid") return { state: "invalid" };
  const fixture = fixtures.get(fixtureId);
  if (!fixture) return { state: "missing" };
  return {
    state: "observed",
    value: BigInt(
      fixture.assurance.filter((state) => assuranceStateMatches(state, metric.condition)).length,
    ),
  };
}

function populationFromMap(
  byFixtureId: ReadonlyMap<string, ClassifiedAssuranceObservation>,
): ClassifiedAssurancePopulation {
  const values = [...byFixtureId.values()];
  const count = (state: AssuranceObservationState) =>
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
  metric: AssuranceComparisonMetric,
): ClassifiedAssurancePopulation {
  return populationFromMap(
    new Map(
      fixtureIds.map((fixtureId) => [
        fixtureId,
        classifyAssuranceObservation(fixtures, cases.get(fixtureId), fixtureId, metric),
      ]),
    ),
  );
}

function pairedState(
  baseline: ClassifiedAssuranceObservation,
  candidate: ClassifiedAssuranceObservation,
): AssuranceObservationState {
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
  population: ClassifiedAssurancePopulation,
  fixtureIds: readonly string[],
): bigint {
  return fixtureIds.reduce(
    (sum, fixtureId) => sum + (population.byFixtureId.get(fixtureId)?.value ?? 0n),
    0n,
  );
}

function unavailableMetricReasons(
  baseline: ClassifiedAssurancePopulation,
  candidate: ClassifiedAssurancePopulation,
  paired: ClassifiedAssurancePopulation,
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
  baseline: ClassifiedAssurancePopulation,
  candidate: ClassifiedAssurancePopulation,
  paired: ClassifiedAssurancePopulation,
  observedPairedFixtureIds: readonly string[],
  metric: AssuranceComparisonMetric,
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
 * Counts exact retained assurance states for every declared condition. Healthy states are derived
 * from the absence of their complete reason family, while absent or invalid fixtures remain
 * outside paired arithmetic and exact empty assurance sets remain observed zeroes.
 */
export function deriveComparisonAssuranceMetrics(
  input: PairComparisonEvidenceInput,
): ComparisonAssuranceMetricDerivation {
  const pairing = pairComparisonEvidence(input);
  const cases = caseMap(pairing.cases);
  const baselineFixtures = fixtureMap(input.baseline);
  const candidateFixtures = fixtureMap(input.candidate);
  const strata = new Map(input.comparison.strata.map((entry) => [entry.stratumId, entry]));
  const metricResults: ComparisonMetricResult[] = [];

  for (const metric of input.comparison.metrics) {
    if (metric.kind !== "assurance_state_count") continue;
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
    const pairedByFixtureId = new Map<string, ClassifiedAssuranceObservation>();
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
