import {
  type ComparisonDefinitionReference,
  type ComparisonMetricResult,
  type ComparisonResultDefinition,
  ComparisonResultDefinitionSchema,
} from "@proofstack/contracts";
import { deriveComparisonArtifactMetrics } from "./comparison-artifact-metrics.js";
import { deriveComparisonAssuranceMetrics } from "./comparison-assurance-metrics.js";
import { deriveComparisonCoverageMetrics } from "./comparison-coverage-metrics.js";
import { deriveComparisonNumericMetrics } from "./comparison-numeric-metrics.js";
import { type PairComparisonEvidenceInput, pairComparisonEvidence } from "./comparison-pairing.js";
import {
  deriveComparisonSafetyCounts,
  deriveComparisonSafetyMetrics,
} from "./comparison-safety-metrics.js";
import { deriveComparisonTraceMetrics } from "./comparison-trace-metrics.js";
import { deriveComparisonUsageMetrics } from "./comparison-usage-metrics.js";
import { deriveComparisonVerdictMetrics } from "./comparison-verdict-metrics.js";
import { deriveComparisonVerdictTransitions } from "./comparison-verdict-transitions.js";

export interface DeriveComparisonResultDefinitionInput extends PairComparisonEvidenceInput {
  readonly resultId: string;
}

export type ComparisonResultDerivationErrorCode = "metric_derivation_mismatch";

export class ComparisonResultDerivationError extends Error {
  constructor(
    readonly code: ComparisonResultDerivationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ComparisonResultDerivationError";
  }
}

function exactStringOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparisonReference(
  input: DeriveComparisonResultDefinitionInput,
): ComparisonDefinitionReference {
  return {
    comparisonId: input.comparison.comparisonId,
    comparisonVersionId: input.comparison.comparisonVersionId,
    definitionSha256: input.comparison.definitionSha256,
  };
}

function snapshotReference(
  input: DeriveComparisonResultDefinitionInput,
  role: "baseline" | "candidate",
) {
  const snapshot = input[role];
  return {
    definitionSha256: snapshot.definitionSha256,
    role,
    snapshotId: snapshot.snapshotId,
  } as const;
}

function orderedMetricResults(
  input: DeriveComparisonResultDefinitionInput,
  fragments: readonly (readonly ComparisonMetricResult[])[],
): readonly ComparisonMetricResult[] {
  const metricResults = fragments
    .flat()
    .sort((left, right) => exactStringOrder(left.metricId, right.metricId));
  const expectedMetricIds = input.comparison.metrics.map(({ metricId }) => metricId);
  const derivedMetricIds = metricResults.map(({ metricId }) => metricId);
  if (
    expectedMetricIds.length !== derivedMetricIds.length ||
    expectedMetricIds.some((metricId, index) => metricId !== derivedMetricIds[index])
  ) {
    throw new ComparisonResultDerivationError(
      "metric_derivation_mismatch",
      "Comparison metric derivation did not reconstruct every exact declared metric once",
    );
  }
  return metricResults;
}

/**
 * Builds the immutable, policy-independent comparison result definition from the exact
 * definition and snapshot records. Every declared metric must be reconstructed exactly once;
 * missing or incomparable evidence remains explicit in the derived fragments.
 */
export function deriveComparisonResultDefinition(
  input: DeriveComparisonResultDefinitionInput,
): ComparisonResultDefinition {
  const pairing = pairComparisonEvidence(input);
  const numeric = deriveComparisonNumericMetrics(input);
  const usage = deriveComparisonUsageMetrics(input);
  const trace = deriveComparisonTraceMetrics(input);
  const verdictMetrics = deriveComparisonVerdictMetrics(input);
  const safetyMetrics = deriveComparisonSafetyMetrics(input);
  const artifacts = deriveComparisonArtifactMetrics(input);
  const assurance = deriveComparisonAssuranceMetrics(input);
  const coverage = deriveComparisonCoverageMetrics(input);
  const safety = deriveComparisonSafetyCounts(input);
  const verdicts = deriveComparisonVerdictTransitions(input);
  const metricResults = orderedMetricResults(input, [
    artifacts.metricResults,
    assurance.metricResults,
    coverage.metricResults,
    numeric.metricResults,
    safetyMetrics.metricResults,
    trace.metricResults,
    usage.metricResults,
    verdictMetrics.metricResults,
  ]);
  const distributions = [...numeric.distributions, ...usage.distributions].sort((left, right) =>
    exactStringOrder(`${left.metricId}:${left.role}`, `${right.metricId}:${right.role}`),
  );
  const knownLimitations = [
    ...new Set([...input.baseline.knownLimitations, ...input.candidate.knownLimitations]),
  ].sort(exactStringOrder);

  return ComparisonResultDefinitionSchema.parse({
    artifactChanges: artifacts.artifactChanges,
    baselineSnapshot: snapshotReference(input, "baseline"),
    candidateSnapshot: snapshotReference(input, "candidate"),
    cases: pairing.cases,
    comparability: pairing.comparability,
    comparison: comparisonReference(input),
    distributions,
    knownLimitations,
    latestSourceCutoff:
      input.baseline.sourceCutoff < input.candidate.sourceCutoff
        ? input.candidate.sourceCutoff
        : input.baseline.sourceCutoff,
    metricResults,
    pairing: pairing.pairing,
    resultId: input.resultId,
    safetyCounts: safety.safetyCounts,
    verdictMarginals: verdicts.verdictMarginals,
    verdictTransitions: verdicts.verdictTransitions,
  });
}
