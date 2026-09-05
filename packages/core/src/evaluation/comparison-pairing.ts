import {
  type ComparisonCase,
  ComparisonCaseSchema,
  type ComparisonComparability,
  ComparisonComparabilitySchema,
  type ComparisonDefinition,
  ComparisonDefinitionRecordSchema,
  type ComparisonEvidenceFixtureSnapshot,
  type ComparisonEvidenceSnapshot,
  ComparisonEvidenceSnapshotSchema,
  type ComparisonInvalidCaseReasonSchema,
  ComparisonPairingSummarySchema,
  encodeEvaluationCanonicalJson,
} from "@proofstack/contracts";

export type ComparisonPairingErrorCode =
  | "comparison_reference_mismatch"
  | "dataset_reference_mismatch"
  | "invalid_comparison_definition"
  | "invalid_evidence_snapshot"
  | "role_mismatch"
  | "scope_mismatch"
  | "snapshot_subject_mismatch";

export class ComparisonPairingError extends Error {
  constructor(
    readonly code: ComparisonPairingErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ComparisonPairingError";
  }
}

export interface PairComparisonEvidenceInput {
  readonly baseline: ComparisonEvidenceSnapshot;
  readonly candidate: ComparisonEvidenceSnapshot;
  readonly comparison: ComparisonDefinition;
}

export interface ComparisonPairingResult {
  readonly cases: readonly ComparisonCase[];
  readonly comparability: ComparisonComparability;
  readonly pairing: ReturnType<typeof ComparisonPairingSummarySchema.parse>;
}

type SubjectFixture = ComparisonDefinition["baseline"]["fixtures"][number];
type ComparisonInvalidCaseReason = ReturnType<typeof ComparisonInvalidCaseReasonSchema.parse>;

function canonicalEqual(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    Buffer.from(encodeEvaluationCanonicalJson(right)),
  );
}

function exactComparisonReference(comparison: ComparisonDefinition) {
  return {
    comparisonId: comparison.comparisonId,
    comparisonVersionId: comparison.comparisonVersionId,
    definitionSha256: comparison.definitionSha256,
  };
}

function fixtureReferenceKey(value: {
  readonly definitionSha256: string;
  readonly fixtureId: string;
  readonly fixtureVersionId: string;
}): string {
  return `${value.fixtureId}:${value.fixtureVersionId}:${value.definitionSha256}`;
}

function assessmentReferenceKey(value: {
  readonly assessmentId: string;
  readonly definitionSha256: string;
}): string {
  return `${value.assessmentId}:${value.definitionSha256}`;
}

function modelAssuranceReferenceKey(value: {
  readonly assessmentExtensionId: string;
  readonly definitionSha256: string;
}): string {
  return `${value.assessmentExtensionId}:${value.definitionSha256}`;
}

function exactSorted(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = exactSorted(left);
  const sortedRight = exactSorted(right);
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function fixtureIntegrityReasons(
  expected: SubjectFixture,
  actual: ComparisonEvidenceFixtureSnapshot,
): readonly ComparisonInvalidCaseReason[] {
  const reasons = new Set<ComparisonInvalidCaseReason>();
  if (
    expected.fixture.fixtureId !== actual.fixture.fixtureId ||
    expected.fixture.fixtureVersionId !== actual.fixture.fixtureVersionId
  ) {
    reasons.add("unresolved_lineage");
  } else if (expected.fixture.definitionSha256 !== actual.fixture.definitionSha256) {
    reasons.add("digest_mismatch");
  }
  if (!canonicalEqual(expected.replay, actual.replay)) {
    reasons.add("unresolved_lineage");
  }
  const expectedAssessments = expected.assessments.map(assessmentReferenceKey);
  const expectedAssessmentSet = new Set(expectedAssessments);
  const actualAssessments = actual.assurance
    .filter((value) => value.kind === "assessment")
    .map((value) => assessmentReferenceKey(value.reference));
  if (!sameStringSet(expectedAssessments, actualAssessments)) {
    reasons.add("unresolved_lineage");
  }
  if (
    actual.evaluationOutcomes.some(
      ({ assessment }) => !expectedAssessmentSet.has(assessmentReferenceKey(assessment)),
    )
  ) {
    reasons.add("unresolved_lineage");
  }
  const expectedModelAssurance = expected.modelAssuranceAssessments.map(modelAssuranceReferenceKey);
  const actualModelAssurance = actual.assurance
    .filter((value) => value.kind === "model_assurance")
    .map((value) => modelAssuranceReferenceKey(value.reference));
  if (!sameStringSet(expectedModelAssurance, actualModelAssurance)) {
    reasons.add("unresolved_lineage");
  }
  return [...reasons].sort();
}

function parseComparison(value: unknown): ComparisonDefinition {
  const parsed = ComparisonDefinitionRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw new ComparisonPairingError(
      "invalid_comparison_definition",
      "The comparison definition is invalid",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function parseSnapshot(value: unknown, role: "baseline" | "candidate"): ComparisonEvidenceSnapshot {
  const parsed = ComparisonEvidenceSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new ComparisonPairingError(
      "invalid_evidence_snapshot",
      `The ${role} snapshot is invalid`,
      {
        cause: parsed.error,
      },
    );
  }
  if (parsed.data.role !== role) {
    throw new ComparisonPairingError("role_mismatch", `The ${role} snapshot has the wrong role`);
  }
  return parsed.data;
}

function assertSnapshotEnvelope(
  comparison: ComparisonDefinition,
  snapshot: ComparisonEvidenceSnapshot,
  role: "baseline" | "candidate",
): void {
  if (!canonicalEqual(snapshot.scope, comparison.scope)) {
    throw new ComparisonPairingError(
      "scope_mismatch",
      `The ${role} snapshot is outside the comparison scope`,
    );
  }
  if (!canonicalEqual(snapshot.comparison, exactComparisonReference(comparison))) {
    throw new ComparisonPairingError(
      "comparison_reference_mismatch",
      `The ${role} snapshot does not bind the exact comparison definition`,
    );
  }
  if (!canonicalEqual(snapshot.dataset, comparison[role].dataset)) {
    throw new ComparisonPairingError(
      "dataset_reference_mismatch",
      `The ${role} snapshot does not bind the exact subject dataset`,
    );
  }
}

function fixtureMap<Fixture extends { readonly fixture: { readonly fixtureId: string } }>(
  fixtures: readonly Fixture[],
): ReadonlyMap<string, Fixture> {
  return new Map(fixtures.map((fixture) => [fixture.fixture.fixtureId, fixture]));
}

function assertNoUnexpectedFixtures(
  expected: ReadonlyMap<string, SubjectFixture>,
  actual: ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot>,
  role: "baseline" | "candidate",
): void {
  for (const fixtureId of actual.keys()) {
    if (!expected.has(fixtureId)) {
      throw new ComparisonPairingError(
        "snapshot_subject_mismatch",
        `The ${role} snapshot contains a fixture outside the exact subject`,
      );
    }
  }
}

function missingReason(
  expected: SubjectFixture | undefined,
): "fixture_absent" | "snapshot_omission" {
  return expected ? "snapshot_omission" : "fixture_absent";
}

function caseForFixture(
  fixtureId: string,
  baselineExpected: SubjectFixture | undefined,
  candidateExpected: SubjectFixture | undefined,
  baselineActual: ComparisonEvidenceFixtureSnapshot | undefined,
  candidateActual: ComparisonEvidenceFixtureSnapshot | undefined,
): ComparisonCase {
  const baselineReasons =
    baselineExpected && baselineActual
      ? fixtureIntegrityReasons(baselineExpected, baselineActual)
      : [];
  const candidateReasons =
    candidateExpected && candidateActual
      ? fixtureIntegrityReasons(candidateExpected, candidateActual)
      : [];
  const reasons = exactSorted([...baselineReasons, ...candidateReasons]).filter(
    (reason, index, values) => index === 0 || values[index - 1] !== reason,
  );
  if (!baselineActual && !candidateActual) {
    return ComparisonCaseSchema.parse({
      baseline: baselineExpected?.fixture,
      candidate: candidateExpected?.fixture,
      fixtureId,
      reasons: ["unresolved_lineage"],
      state: "invalid",
    });
  }
  if (reasons.length > 0) {
    return ComparisonCaseSchema.parse({
      baseline: baselineActual?.fixture ?? baselineExpected?.fixture,
      candidate: candidateActual?.fixture ?? candidateExpected?.fixture,
      fixtureId,
      reasons,
      state: "invalid",
    });
  }
  if (baselineActual && candidateActual) {
    return ComparisonCaseSchema.parse({
      baseline: baselineActual.fixture,
      candidate: candidateActual.fixture,
      fixtureId,
      state: "paired",
    });
  }
  if (baselineActual) {
    return ComparisonCaseSchema.parse({
      baseline: baselineActual.fixture,
      candidateMissingReason: missingReason(candidateExpected),
      fixtureId,
      state: "baseline_only",
    });
  }
  return ComparisonCaseSchema.parse({
    baselineMissingReason: missingReason(baselineExpected),
    candidate: candidateActual?.fixture,
    fixtureId,
    state: "candidate_only",
  });
}

function exactDatasetKey(value: ComparisonDefinition["baseline"]["dataset"]): string {
  return `${value.datasetId}:${value.datasetVersionId}:${value.definitionSha256}`;
}

function deriveComparability(
  comparison: ComparisonDefinition,
  cases: readonly ComparisonCase[],
): ComparisonComparability {
  const reasons = new Set<
    | "dataset_mismatch"
    | "fixture_mismatch"
    | "insufficient_paired_coverage"
    | "invalid_source_integrity"
    | "missing_source_evidence"
  >();
  if (
    exactDatasetKey(comparison.baseline.dataset) !== exactDatasetKey(comparison.candidate.dataset)
  ) {
    reasons.add("dataset_mismatch");
  }
  const paired = cases.filter((value) => value.state === "paired");
  if (
    paired.length * 10_000 <
    cases.length * comparison.calculationPolicy.minimumPairedCoverageBasisPoints
  ) {
    reasons.add("insufficient_paired_coverage");
  }
  if (cases.some((value) => value.state === "invalid")) reasons.add("invalid_source_integrity");
  if (cases.some((value) => value.state === "baseline_only" || value.state === "candidate_only")) {
    reasons.add("missing_source_evidence");
  }
  if (
    paired.some(
      (value) =>
        value.state === "paired" &&
        fixtureReferenceKey(value.baseline) !== fixtureReferenceKey(value.candidate),
    )
  ) {
    reasons.add("fixture_mismatch");
  }
  const orderedReasons = [...reasons].sort();
  return ComparisonComparabilitySchema.parse({
    reasons: orderedReasons,
    status:
      orderedReasons.length === 0
        ? "comparable"
        : paired.length === 0
          ? "incomparable"
          : "partially_comparable",
  });
}

export function pairComparisonEvidence(
  input: PairComparisonEvidenceInput,
): ComparisonPairingResult {
  const comparison = parseComparison(input.comparison);
  const baseline = parseSnapshot(input.baseline, "baseline");
  const candidate = parseSnapshot(input.candidate, "candidate");
  assertSnapshotEnvelope(comparison, baseline, "baseline");
  assertSnapshotEnvelope(comparison, candidate, "candidate");
  if (baseline.snapshotId === candidate.snapshotId) {
    throw new ComparisonPairingError(
      "snapshot_subject_mismatch",
      "Baseline and candidate must use distinct evidence snapshots",
    );
  }

  const baselineExpected = fixtureMap(comparison.baseline.fixtures);
  const candidateExpected = fixtureMap(comparison.candidate.fixtures);
  const baselineActual = fixtureMap(baseline.fixtures);
  const candidateActual = fixtureMap(candidate.fixtures);
  assertNoUnexpectedFixtures(baselineExpected, baselineActual, "baseline");
  assertNoUnexpectedFixtures(candidateExpected, candidateActual, "candidate");

  const fixtureIds = [...new Set([...baselineExpected.keys(), ...candidateExpected.keys()])].sort();
  const cases = fixtureIds.map((fixtureId) =>
    caseForFixture(
      fixtureId,
      baselineExpected.get(fixtureId),
      candidateExpected.get(fixtureId),
      baselineActual.get(fixtureId),
      candidateActual.get(fixtureId),
    ),
  );
  const pairing = ComparisonPairingSummarySchema.parse({
    baselineOnlyCount: cases.filter(({ state }) => state === "baseline_only").length,
    candidateOnlyCount: cases.filter(({ state }) => state === "candidate_only").length,
    invalidCount: cases.filter(({ state }) => state === "invalid").length,
    pairedCount: cases.filter(({ state }) => state === "paired").length,
    requestedCount: cases.length,
  });
  return {
    cases,
    comparability: deriveComparability(comparison, cases),
    pairing,
  };
}
