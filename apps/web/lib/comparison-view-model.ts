import type {
  ComparisonArtifactChange,
  ComparisonExactValue,
  ComparisonMetricResult,
  ComparisonSafetyCount,
  ComparisonVerdictMarginal,
  ComparisonVerdictTransition,
} from "@proofstack/contracts";
import type { ComparisonView } from "./proofstack-api.js";

export interface ExactValueDisplay {
  readonly denominator?: string;
  readonly numerator?: string;
  readonly representation: "decimal" | "rational";
  readonly text: string;
  readonly unit: string;
  readonly value?: string;
}

export interface SampleClassDisplay {
  readonly invalid: number;
  readonly missing: number;
  readonly observed: number;
  readonly total: number;
  readonly unavailable: number;
}

export interface MetricDisplay {
  readonly baseline?: ExactValueDisplay;
  readonly candidate?: ExactValueDisplay;
  readonly delta?: ExactValueDisplay;
  readonly direction?: "decreased" | "increased" | "unchanged";
  readonly kind: string;
  readonly label: string;
  readonly metricId: string;
  readonly reasons: readonly string[];
  readonly samples: {
    readonly baseline: SampleClassDisplay;
    readonly candidate: SampleClassDisplay;
    readonly paired: SampleClassDisplay;
  };
  readonly status: "available" | "incomparable" | "unavailable";
  readonly unit: string;
  readonly usageProvenance?: {
    readonly baseline: string;
    readonly candidate: string;
  };
}

export interface ComparisonDisplayModel {
  readonly artifacts: readonly ArtifactDisplay[];
  readonly cases: readonly CaseDisplay[];
  readonly comparability: {
    readonly reasons: readonly string[];
    readonly status: "comparable" | "incomparable" | "partially_comparable";
  };
  readonly comparison: {
    readonly comparisonId: string;
    readonly comparisonVersionId: string;
    readonly createdAt: string;
    readonly definitionSha256: string;
    readonly description?: string;
    readonly name: string;
  };
  readonly distributions: readonly DistributionDisplay[];
  readonly limitations: {
    readonly baseline: readonly string[];
    readonly candidate: readonly string[];
    readonly result: readonly string[];
  };
  readonly metrics: readonly MetricDisplay[];
  readonly pairing: {
    readonly baselineOnly: number;
    readonly candidateOnly: number;
    readonly invalid: number;
    readonly paired: number;
    readonly requested: number;
  };
  readonly policy: readonly { readonly label: string; readonly value: string }[];
  readonly result: {
    readonly createdAt: string;
    readonly definitionSha256: string;
    readonly latestSourceCutoff: string;
    readonly resultId: string;
    readonly schemaVersion: string;
    readonly scope: string;
  };
  readonly safety: readonly SafetyDisplay[];
  readonly sources: readonly SourceDisplay[];
  readonly verdictMarginals: readonly VerdictMarginalDisplay[];
  readonly verdictTransitions: readonly VerdictTransitionDisplay[];
}

export interface SourceDisplay {
  readonly createdAt: string;
  readonly dataset: string;
  readonly datasetSha256: string;
  readonly definitionSha256: string;
  readonly fixtureCount: number;
  readonly integrity: "verified";
  readonly omissionCount: number;
  readonly omissionReasons: readonly string[];
  readonly role: "baseline" | "candidate";
  readonly snapshotId: string;
  readonly sourceCutoff: string;
  readonly targetReleaseIds: readonly string[];
}

export interface CaseDisplay {
  readonly baselineDigest?: string;
  readonly baselineVersion?: string;
  readonly candidateDigest?: string;
  readonly candidateVersion?: string;
  readonly fixtureId: string;
  readonly reasons: readonly string[];
  readonly state: "baseline_only" | "candidate_only" | "invalid" | "paired";
}

export interface ArtifactRoleDisplay {
  readonly availability: "available" | "revoked" | "unavailable";
  readonly classification: string;
  readonly mediaType: string;
  readonly redactedAt?: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ArtifactDisplay {
  readonly artifactId: string;
  readonly baseline?: ArtifactRoleDisplay;
  readonly candidate?: ArtifactRoleDisplay;
  readonly status: "added" | "metadata_changed" | "removed" | "unavailable" | "unchanged";
}

export interface DistributionDisplay {
  readonly invalid: number;
  readonly method: string;
  readonly metricId: string;
  readonly missing: number;
  readonly observed: number;
  readonly role: "baseline" | "candidate";
  readonly total: number;
  readonly unavailable: number;
  readonly value: ExactValueDisplay;
}

export interface SafetyDisplay {
  readonly baseline: number;
  readonly candidate: number;
  readonly delta: number;
  readonly kind: string;
}

export interface VerdictMarginalDisplay {
  readonly baseline: string;
  readonly candidate: string;
  readonly criterionId: string;
  readonly transition: string;
}

export interface VerdictTransitionDisplay {
  readonly baseline: string;
  readonly candidate: string;
  readonly count: number;
  readonly criterionId: string;
}

export function exactValueDisplay(value: ComparisonExactValue): ExactValueDisplay {
  if (value.representation === "decimal") {
    return {
      representation: "decimal",
      text: `${value.value} ${value.unit}`,
      unit: value.unit,
      value: value.value,
    };
  }
  return {
    denominator: value.denominator,
    numerator: value.numerator,
    representation: "rational",
    text: `${value.numerator}/${value.denominator} ${value.unit}`,
    unit: value.unit,
  };
}

function sampleClass(
  samples: ComparisonMetricResult["samples"],
  role: "baseline" | "candidate" | "paired",
): SampleClassDisplay {
  return {
    invalid: samples[`${role}InvalidCount`],
    missing: samples[`${role}MissingCount`],
    observed: samples[`${role}ObservedCount`],
    total: samples[`${role}TotalCount`],
    unavailable: samples[`${role}UnavailableCount`],
  };
}

function provenanceText(
  provenance: NonNullable<ComparisonMetricResult["usageProvenance"]>["baseline"],
): string {
  const sources =
    provenance.observedSources.length > 0 ? provenance.observedSources.join(", ") : "none";
  const reasons =
    provenance.unavailableReasons.length > 0 ? provenance.unavailableReasons.join(", ") : "none";
  return `complete ${provenance.completeCount}; partial ${provenance.partialCount}; unavailable ${provenance.unavailableCount}; sources ${sources}; reasons ${reasons}`;
}

function metricDisplay(
  metric: ComparisonMetricResult,
  labels: ReadonlyMap<string, string>,
): MetricDisplay {
  const samples = {
    baseline: sampleClass(metric.samples, "baseline"),
    candidate: sampleClass(metric.samples, "candidate"),
    paired: sampleClass(metric.samples, "paired"),
  };
  const usageProvenance = metric.usageProvenance
    ? {
        baseline: provenanceText(metric.usageProvenance.baseline),
        candidate: provenanceText(metric.usageProvenance.candidate),
      }
    : undefined;
  if (metric.value.status === "available") {
    return {
      baseline: exactValueDisplay(metric.value.baseline),
      candidate: exactValueDisplay(metric.value.candidate),
      delta: exactValueDisplay(metric.value.delta),
      direction: metric.value.direction,
      kind: metric.kind,
      label: labels.get(metric.metricId) ?? metric.metricId,
      metricId: metric.metricId,
      reasons: [],
      samples,
      status: "available",
      unit: metric.unit,
      ...(usageProvenance ? { usageProvenance } : {}),
    };
  }
  return {
    ...(metric.value.status === "incomparable" && metric.value.baseline
      ? { baseline: exactValueDisplay(metric.value.baseline) }
      : {}),
    ...(metric.value.status === "incomparable" && metric.value.candidate
      ? { candidate: exactValueDisplay(metric.value.candidate) }
      : {}),
    kind: metric.kind,
    label: labels.get(metric.metricId) ?? metric.metricId,
    metricId: metric.metricId,
    reasons: metric.value.reasons,
    samples,
    status: metric.value.status,
    unit: metric.unit,
    ...(usageProvenance ? { usageProvenance } : {}),
  };
}

function sourceDisplay(view: ComparisonView, role: "baseline" | "candidate"): SourceDisplay {
  const snapshot = view[role];
  const subject = view.definition[role];
  return {
    createdAt: snapshot.createdAt,
    dataset: `${snapshot.dataset.datasetId}@${snapshot.dataset.datasetVersionId}`,
    datasetSha256: snapshot.dataset.definitionSha256,
    definitionSha256: snapshot.definitionSha256,
    fixtureCount: snapshot.fixtures.length,
    integrity: snapshot.integrity,
    omissionCount: snapshot.omissions.length,
    omissionReasons: [...new Set(snapshot.omissions.map(({ reason }) => reason))].sort(),
    role,
    snapshotId: snapshot.snapshotId,
    sourceCutoff: snapshot.sourceCutoff,
    targetReleaseIds: [
      ...new Set(subject.fixtures.map(({ replay }) => replay.targetRelease.targetReleaseId)),
    ].sort(),
  };
}

function caseDisplay(entry: ComparisonView["result"]["cases"][number]): CaseDisplay {
  const baseline = "baseline" in entry ? entry.baseline : undefined;
  const candidate = "candidate" in entry ? entry.candidate : undefined;
  const reasons =
    entry.state === "invalid"
      ? entry.reasons
      : entry.state === "baseline_only"
        ? [entry.candidateMissingReason]
        : entry.state === "candidate_only"
          ? [entry.baselineMissingReason]
          : [];
  return {
    ...(baseline
      ? { baselineDigest: baseline.definitionSha256, baselineVersion: baseline.fixtureVersionId }
      : {}),
    ...(candidate
      ? {
          candidateDigest: candidate.definitionSha256,
          candidateVersion: candidate.fixtureVersionId,
        }
      : {}),
    fixtureId: entry.fixtureId,
    reasons,
    state: entry.state,
  };
}

function artifactRole(
  change: ComparisonArtifactChange,
  role: "baseline" | "candidate",
): ArtifactRoleDisplay | undefined {
  const artifact = change[role];
  const availability = change[`${role}Availability`];
  if (!artifact || !availability) return undefined;
  return {
    availability,
    classification: artifact.classification,
    mediaType: artifact.mediaType,
    ...(artifact.redactedAt ? { redactedAt: artifact.redactedAt } : {}),
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
  };
}

function artifactDisplay(change: ComparisonArtifactChange): ArtifactDisplay {
  const baseline = artifactRole(change, "baseline");
  const candidate = artifactRole(change, "candidate");
  return {
    artifactId: change.artifactId,
    ...(baseline ? { baseline } : {}),
    ...(candidate ? { candidate } : {}),
    status: change.status,
  };
}

function safetyDisplay(value: ComparisonSafetyCount): SafetyDisplay {
  return { ...value.counts, kind: value.kind };
}

function verdictCounts(value: ComparisonVerdictMarginal["baseline"]): string {
  return `pass ${value.pass}; fail ${value.fail}; abstain ${value.abstain}; error ${value.error}; not applicable ${value.notApplicable}; total ${value.total}`;
}

function verdictMarginalDisplay(value: ComparisonVerdictMarginal): VerdictMarginalDisplay {
  return {
    baseline: verdictCounts(value.baseline),
    candidate: verdictCounts(value.candidate),
    criterionId: value.criterion.criterionId,
    transition:
      value.transition.status === "available"
        ? `available; paired ${value.transition.pairedCount}`
        : `unavailable; ${value.transition.reasons.join(", ")}`,
  };
}

function verdictTransitionDisplay(value: ComparisonVerdictTransition): VerdictTransitionDisplay {
  return {
    baseline: value.baseline,
    candidate: value.candidate,
    count: value.count,
    criterionId: value.criterion.criterionId,
  };
}

export function buildComparisonDisplay(view: ComparisonView): ComparisonDisplayModel {
  const labels = new Map(view.definition.metrics.map(({ label, metricId }) => [metricId, label]));
  const policy = view.definition.calculationPolicy;
  return {
    artifacts: view.result.artifactChanges.map(artifactDisplay),
    cases: view.result.cases.map(caseDisplay),
    comparability: view.result.comparability,
    comparison: {
      comparisonId: view.definition.comparisonId,
      comparisonVersionId: view.definition.comparisonVersionId,
      createdAt: view.definition.createdAt,
      definitionSha256: view.definition.definitionSha256,
      ...(view.definition.description ? { description: view.definition.description } : {}),
      name: view.definition.name,
    },
    distributions: view.result.distributions.map((distribution) => ({
      invalid: distribution.invalidCount,
      method:
        distribution.method.method === "nearest_rank_quantile"
          ? `${distribution.method.method} ${distribution.method.basisPoints}bp @ ${distribution.method.methodVersion}`
          : `${distribution.method.method} @ ${distribution.method.methodVersion}`,
      metricId: distribution.metricId,
      missing: distribution.missingCount,
      observed: distribution.observedCount,
      role: distribution.role,
      total: distribution.totalCount,
      unavailable: distribution.unavailableCount,
      value: exactValueDisplay(distribution.value),
    })),
    limitations: {
      baseline: view.baseline.knownLimitations,
      candidate: view.candidate.knownLimitations,
      result: view.result.knownLimitations,
    },
    metrics: view.result.metricResults.map((metric) => metricDisplay(metric, labels)),
    pairing: {
      baselineOnly: view.result.pairing.baselineOnlyCount,
      candidateOnly: view.result.pairing.candidateOnlyCount,
      invalid: view.result.pairing.invalidCount,
      paired: view.result.pairing.pairedCount,
      requested: view.result.pairing.requestedCount,
    },
    policy: [
      { label: "Fixture pairing", value: policy.fixturePairing },
      { label: "Missingness", value: policy.missingness },
      { label: "Invalid cases", value: policy.invalidCases },
      { label: "Denominators", value: policy.denominators },
      { label: "Decimal arithmetic", value: policy.decimalArithmetic },
      { label: "Mean", value: policy.mean },
      { label: "Quantile", value: policy.quantile },
      { label: "Confidence intervals", value: policy.confidenceIntervals },
      {
        label: "Minimum paired coverage",
        value: `${policy.minimumPairedCoverageBasisPoints} basis points`,
      },
      { label: "Numeric multiplicity", value: policy.numericObservationMultiplicity },
      { label: "Classified projection", value: view.definition.classifiedContentProjection },
    ],
    result: {
      createdAt: view.result.createdAt,
      definitionSha256: view.result.definitionSha256,
      latestSourceCutoff: view.result.latestSourceCutoff,
      resultId: view.result.resultId,
      schemaVersion: view.result.schemaVersion,
      scope: `${view.result.scope.tenantId}/${view.result.scope.projectId}/${view.result.scope.environmentId}`,
    },
    safety: view.result.safetyCounts.map(safetyDisplay),
    sources: [sourceDisplay(view, "baseline"), sourceDisplay(view, "candidate")],
    verdictMarginals: view.result.verdictMarginals.map(verdictMarginalDisplay),
    verdictTransitions: view.result.verdictTransitions.map(verdictTransitionDisplay),
  };
}
