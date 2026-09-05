import {
  type ComparisonArtifactChange,
  ComparisonArtifactChangeSchema,
  type ComparisonCase,
  type ComparisonEvidenceFixtureSnapshot,
  type ComparisonEvidenceSnapshot,
  type ComparisonExactValue,
  type ComparisonMetric,
  type ComparisonMetricResult,
  ComparisonMetricResultSchema,
  ComparisonMetricSampleCountsSchema,
  MAX_COMPARISON_ARTIFACTS,
} from "@proofstack/contracts";
import {
  compareComparisonExactValues,
  subtractComparisonExactValues,
} from "./comparison-exact-arithmetic.js";
import { type PairComparisonEvidenceInput, pairComparisonEvidence } from "./comparison-pairing.js";

type ArtifactComparisonMetric = Extract<ComparisonMetric, { readonly kind: "artifact_set" }>;
type ArtifactState = ComparisonEvidenceFixtureSnapshot["artifacts"][number];
type ArtifactReference = ArtifactState["artifact"];
type ArtifactObservationState = "invalid" | "missing" | "observed";

interface ClassifiedArtifactObservation {
  readonly artifacts?: readonly ArtifactState[];
  readonly state: ArtifactObservationState;
  readonly value?: bigint;
}

interface ClassifiedArtifactPopulation {
  readonly byFixtureId: ReadonlyMap<string, ClassifiedArtifactObservation>;
  readonly invalidCount: number;
  readonly missingCount: number;
  readonly observedCount: number;
  readonly totalCount: number;
}

export type ComparisonArtifactDerivationErrorCode =
  | "artifact_change_conflict"
  | "artifact_change_limit_exceeded"
  | "artifact_owner_mismatch";

export class ComparisonArtifactDerivationError extends Error {
  constructor(
    readonly code: ComparisonArtifactDerivationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ComparisonArtifactDerivationError";
  }
}

export interface ComparisonArtifactMetricDerivation {
  readonly artifactChanges: readonly ComparisonArtifactChange[];
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

function exactStringOrder(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function subjectFixtureIds(
  input: PairComparisonEvidenceInput,
  role: "baseline" | "candidate",
  stratumFixtureIds: readonly string[],
): readonly string[] {
  const subject = new Set(input.comparison[role].fixtures.map(({ fixture }) => fixture.fixtureId));
  return stratumFixtureIds.filter((fixtureId) => subject.has(fixtureId));
}

function classifyArtifactObservation(
  fixtures: ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot>,
  comparisonCase: ComparisonCase | undefined,
  fixtureId: string,
): ClassifiedArtifactObservation {
  if (!comparisonCase || comparisonCase.state === "invalid") return { state: "invalid" };
  const fixture = fixtures.get(fixtureId);
  if (!fixture) return { state: "missing" };
  return {
    artifacts: fixture.artifacts,
    state: "observed",
    value: BigInt(fixture.artifacts.length),
  };
}

function populationFromMap(
  byFixtureId: ReadonlyMap<string, ClassifiedArtifactObservation>,
): ClassifiedArtifactPopulation {
  const values = [...byFixtureId.values()];
  const count = (state: ArtifactObservationState) =>
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
): ClassifiedArtifactPopulation {
  return populationFromMap(
    new Map(
      fixtureIds.map((fixtureId) => [
        fixtureId,
        classifyArtifactObservation(fixtures, cases.get(fixtureId), fixtureId),
      ]),
    ),
  );
}

function pairedState(
  baseline: ClassifiedArtifactObservation,
  candidate: ClassifiedArtifactObservation,
): ArtifactObservationState {
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
  population: ClassifiedArtifactPopulation,
  fixtureIds: readonly string[],
): bigint {
  return fixtureIds.reduce(
    (sum, fixtureId) => sum + (population.byFixtureId.get(fixtureId)?.value ?? 0n),
    0n,
  );
}

function unavailableMetricReasons(
  baseline: ClassifiedArtifactPopulation,
  candidate: ClassifiedArtifactPopulation,
  paired: ClassifiedArtifactPopulation,
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
  baseline: ClassifiedArtifactPopulation,
  candidate: ClassifiedArtifactPopulation,
  paired: ClassifiedArtifactPopulation,
  observedPairedFixtureIds: readonly string[],
  metric: ArtifactComparisonMetric,
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

function artifactReferenceEqual(left: ArtifactReference, right: ArtifactReference): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.classification === right.classification &&
    left.mediaType === right.mediaType &&
    left.redactedAt === right.redactedAt &&
    left.sha256 === right.sha256 &&
    left.sizeBytes === right.sizeBytes
  );
}

function artifactChangeEqual(
  left: ComparisonArtifactChange,
  right: ComparisonArtifactChange,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.baselineAvailability === right.baselineAvailability &&
    left.candidateAvailability === right.candidateAvailability &&
    left.status === right.status &&
    ((left.baseline === undefined && right.baseline === undefined) ||
      (left.baseline !== undefined &&
        right.baseline !== undefined &&
        artifactReferenceEqual(left.baseline, right.baseline))) &&
    ((left.candidate === undefined && right.candidate === undefined) ||
      (left.candidate !== undefined &&
        right.candidate !== undefined &&
        artifactReferenceEqual(left.candidate, right.candidate)))
  );
}

function artifactChange(
  artifactId: string,
  baseline: ArtifactState | undefined,
  candidate: ArtifactState | undefined,
): ComparisonArtifactChange {
  const unavailable =
    (baseline !== undefined && baseline.availability !== "available") ||
    (candidate !== undefined && candidate.availability !== "available");
  const status = unavailable
    ? "unavailable"
    : baseline === undefined
      ? "added"
      : candidate === undefined
        ? "removed"
        : artifactReferenceEqual(baseline.artifact, candidate.artifact)
          ? "unchanged"
          : "metadata_changed";
  return ComparisonArtifactChangeSchema.parse({
    artifactId,
    baseline: baseline?.artifact,
    baselineAvailability: baseline?.availability,
    candidate: candidate?.artifact,
    candidateAvailability: candidate?.availability,
    status,
  });
}

function artifactOwners(
  population: ClassifiedArtifactPopulation,
  observedPairedFixtureIds: readonly string[],
): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const fixtureId of observedPairedFixtureIds) {
    for (const { artifact } of population.byFixtureId.get(fixtureId)?.artifacts ?? []) {
      owners.set(artifact.artifactId, fixtureId);
    }
  }
  return owners;
}

function assertSameArtifactOwners(
  baseline: ClassifiedArtifactPopulation,
  candidate: ClassifiedArtifactPopulation,
  observedPairedFixtureIds: readonly string[],
): void {
  const baselineOwners = artifactOwners(baseline, observedPairedFixtureIds);
  const candidateOwners = artifactOwners(candidate, observedPairedFixtureIds);
  for (const [artifactId, baselineFixtureId] of baselineOwners) {
    const candidateFixtureId = candidateOwners.get(artifactId);
    if (candidateFixtureId !== undefined && candidateFixtureId !== baselineFixtureId) {
      throw new ComparisonArtifactDerivationError(
        "artifact_owner_mismatch",
        `Artifact ${artifactId} moved between logical fixtures and cannot be compared exactly`,
      );
    }
  }
}

function retainArtifactChange(
  changes: Map<string, ComparisonArtifactChange>,
  change: ComparisonArtifactChange,
): void {
  const existing = changes.get(change.artifactId);
  if (existing) {
    if (!artifactChangeEqual(existing, change)) {
      throw new ComparisonArtifactDerivationError(
        "artifact_change_conflict",
        `Artifact ${change.artifactId} produced conflicting exact changes`,
      );
    }
    return;
  }
  if (changes.size === MAX_COMPARISON_ARTIFACTS) {
    throw new ComparisonArtifactDerivationError(
      "artifact_change_limit_exceeded",
      `Exact artifact changes exceed the bounded result limit of ${MAX_COMPARISON_ARTIFACTS}`,
    );
  }
  changes.set(change.artifactId, change);
}

function deriveArtifactChanges(
  changes: Map<string, ComparisonArtifactChange>,
  baseline: ClassifiedArtifactPopulation,
  candidate: ClassifiedArtifactPopulation,
  observedPairedFixtureIds: readonly string[],
): void {
  assertSameArtifactOwners(baseline, candidate, observedPairedFixtureIds);
  for (const fixtureId of observedPairedFixtureIds) {
    const baselineArtifacts = new Map(
      (baseline.byFixtureId.get(fixtureId)?.artifacts ?? []).map((entry) => [
        entry.artifact.artifactId,
        entry,
      ]),
    );
    const candidateArtifacts = new Map(
      (candidate.byFixtureId.get(fixtureId)?.artifacts ?? []).map((entry) => [
        entry.artifact.artifactId,
        entry,
      ]),
    );
    const artifactIds = [
      ...new Set([...baselineArtifacts.keys(), ...candidateArtifacts.keys()]),
    ].sort();
    for (const artifactId of artifactIds) {
      retainArtifactChange(
        changes,
        artifactChange(
          artifactId,
          baselineArtifacts.get(artifactId),
          candidateArtifacts.get(artifactId),
        ),
      );
    }
  }
}

/**
 * Derives artifact-set counts and metadata-only changes from exact paired fixtures. Unavailable
 * references remain visible as unavailable, missing fixtures never masquerade as removals, and
 * bounded result limits fail explicitly instead of truncating evidence.
 */
export function deriveComparisonArtifactMetrics(
  input: PairComparisonEvidenceInput,
): ComparisonArtifactMetricDerivation {
  const pairing = pairComparisonEvidence(input);
  const cases = caseMap(pairing.cases);
  const baselineFixtures = fixtureMap(input.baseline);
  const candidateFixtures = fixtureMap(input.candidate);
  const strata = new Map(input.comparison.strata.map((entry) => [entry.stratumId, entry]));
  const changes = new Map<string, ComparisonArtifactChange>();
  const metricResults: ComparisonMetricResult[] = [];

  for (const metric of input.comparison.metrics) {
    if (metric.kind !== "artifact_set") continue;
    const stratum = strata.get(metric.stratumId);
    if (!stratum) {
      throw new TypeError(`Validated comparison metric ${metric.metricId} has no exact stratum`);
    }
    const baseline = classifyPopulation(
      baselineFixtures,
      cases,
      subjectFixtureIds(input, "baseline", stratum.fixtureIds),
    );
    const candidate = classifyPopulation(
      candidateFixtures,
      cases,
      subjectFixtureIds(input, "candidate", stratum.fixtureIds),
    );
    const pairedByFixtureId = new Map<string, ClassifiedArtifactObservation>();
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
    deriveArtifactChanges(changes, baseline, candidate, observedPairedFixtureIds);
  }

  return {
    artifactChanges: [...changes.values()].sort((left, right) =>
      exactStringOrder(left.artifactId, right.artifactId),
    ),
    metricResults,
  };
}
