import { createHash } from "node:crypto";
import {
  type ComparisonDefinition,
  type ComparisonDefinitionReference,
  type ComparisonEvidenceFixtureSnapshot,
  type ComparisonEvidenceSnapshot,
  type ComparisonEvidenceSnapshotReference,
  type ComparisonResult,
  type EvidenceScope,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationComparisonInventory,
  PolicyEvaluationExpectedSourcesSchema,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  policyEvaluationTimestampOrderKey,
  type ReleaseCandidate,
  type ReleaseCandidateComparisonReference,
  type ReleasePolicy,
} from "@proofstack/contracts";
import { validateComparisonRecord } from "../evaluation/comparison-record-validation.js";
import { deriveComparisonResultDefinition } from "../evaluation/derive-comparison-result.js";
import {
  releaseCandidateReference,
  validateReleaseCandidateRecord,
} from "../release/release-candidate-record-validation.js";
import {
  type PolicyEvaluationComparisonAcquisition,
  type ResolvePolicyEvaluationComparisonsInput,
  resolvePolicyEvaluationComparisons,
} from "./policy-evaluation-comparison-selection.js";
import { validatePolicyEvaluationRequestRecord } from "./policy-evaluation-request-record-validation.js";
import {
  releasePolicyReference,
  validateReleasePolicyRecord,
} from "./release-policy-record-validation.js";

type AssessmentReference =
  ComparisonDefinition["baseline"]["fixtures"][number]["assessments"][number];
type ModelAssuranceAssessmentReference =
  ComparisonDefinition["baseline"]["fixtures"][number]["modelAssuranceAssessments"][number];

export type PolicyEvaluationComparisonLineageErrorCode =
  | "candidate_lineage_mismatch"
  | "comparison_record_invalid"
  | "comparison_reference_mismatch"
  | "lineage_chronology_invalid"
  | "result_derivation_mismatch"
  | "scope_mismatch"
  | "selection_not_unique"
  | "selection_result_mismatch"
  | "snapshot_record_invalid"
  | "snapshot_subject_mismatch"
  | "source_not_yet_available"
  | "source_reference_conflict";

export class PolicyEvaluationComparisonLineageError extends Error {
  constructor(
    readonly code: PolicyEvaluationComparisonLineageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PolicyEvaluationComparisonLineageError";
  }
}

export interface ResolvePolicyEvaluationComparisonLineageInput
  extends ResolvePolicyEvaluationComparisonsInput {
  readonly baselineSnapshot: unknown;
  readonly candidateSnapshot: unknown;
  readonly comparison: unknown;
}

/**
 * Direct, independently verified comparison roots. Underlying dataset, fixture, replay,
 * assessment and model-assurance records still have to be acquired and verified before sealing.
 */
export interface PolicyEvaluationComparisonLineage {
  readonly baselineSnapshot: ComparisonEvidenceSnapshot;
  readonly candidateSnapshot: ComparisonEvidenceSnapshot;
  readonly comparison: ComparisonDefinition;
  readonly directSources: readonly PolicyEvaluationSourceReference[];
  readonly inventory: PolicyEvaluationComparisonInventory;
  readonly result: ComparisonResult;
}

const comparisonReceiptKeys = [
  "createdAt",
  "createdByPrincipalId",
  "definitionSha256",
  "schemaVersion",
  "scope",
] as const;

function exact(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function comparisonReference(value: ComparisonDefinition): ComparisonDefinitionReference {
  return {
    comparisonId: value.comparisonId,
    comparisonVersionId: value.comparisonVersionId,
    definitionSha256: value.definitionSha256,
  };
}

function snapshotReference(value: ComparisonEvidenceSnapshot): ComparisonEvidenceSnapshotReference {
  return {
    definitionSha256: value.definitionSha256,
    role: value.role,
    snapshotId: value.snapshotId,
  };
}

function resultReference(value: ComparisonResult): ReleaseCandidateComparisonReference {
  return { definitionSha256: value.definitionSha256, resultId: value.resultId };
}

function fullRecordSha256(value: unknown): string {
  return createHash("sha256").update(encodeEvaluationCanonicalJson(value)).digest("hex");
}

function definitionOfResult(value: ComparisonResult): Record<string, unknown> {
  const definition = structuredClone(value) as unknown as Record<string, unknown>;
  for (const key of comparisonReceiptKeys) delete definition[key];
  return definition;
}

function parseComparison(value: unknown): ComparisonDefinition {
  try {
    return validateComparisonRecord("comparison_definition", value) as ComparisonDefinition;
  } catch (cause) {
    throw new PolicyEvaluationComparisonLineageError(
      "comparison_record_invalid",
      "Selected comparison lineage requires a valid definition record",
      { cause },
    );
  }
}

function parseSnapshot(value: unknown, role: "baseline" | "candidate"): ComparisonEvidenceSnapshot {
  let parsed: ComparisonEvidenceSnapshot;
  try {
    parsed = validateComparisonRecord(
      "comparison_evidence_snapshot",
      value,
    ) as ComparisonEvidenceSnapshot;
  } catch (cause) {
    throw new PolicyEvaluationComparisonLineageError(
      "snapshot_record_invalid",
      `Selected comparison lineage requires a valid ${role} snapshot record`,
      { cause },
    );
  }
  if (parsed.role !== role) {
    throw new PolicyEvaluationComparisonLineageError(
      "comparison_reference_mismatch",
      `Selected comparison ${role} snapshot has the wrong role`,
    );
  }
  return parsed;
}

function parseResult(value: unknown): ComparisonResult {
  try {
    return validateComparisonRecord("comparison_result", value) as ComparisonResult;
  } catch (cause) {
    throw new PolicyEvaluationComparisonLineageError(
      "selection_result_mismatch",
      "Unique comparison selection no longer resolves to its valid exact result",
      { cause },
    );
  }
}

function selectedResult(
  acquisitions: readonly PolicyEvaluationComparisonAcquisition[],
  reference: ReleaseCandidateComparisonReference,
): ComparisonResult {
  const acquisition = acquisitions.find((candidate) => exact(candidate.reference, reference));
  if (!acquisition || acquisition.result === null) {
    throw new PolicyEvaluationComparisonLineageError(
      "selection_result_mismatch",
      "Unique comparison selection omitted its exact acquired result",
    );
  }
  const result = parseResult(acquisition.result);
  if (!exact(resultReference(result), reference)) {
    throw new PolicyEvaluationComparisonLineageError(
      "selection_result_mismatch",
      "Unique comparison selection and acquired result reference differ",
    );
  }
  return result;
}

function assertExactScope(
  scope: EvidenceScope,
  records: readonly { readonly label: string; readonly scope: EvidenceScope }[],
): void {
  const mismatch = records.find((record) => !sameScope(scope, record.scope));
  if (mismatch) {
    throw new PolicyEvaluationComparisonLineageError(
      "scope_mismatch",
      `${mismatch.label} is outside the exact policy evaluation scope`,
    );
  }
}

function assertAvailableAt(
  request: PolicyEvaluationRequest,
  records: readonly { readonly label: string; readonly timestamp: string }[],
): void {
  const evaluationTime = policyEvaluationTimestampOrderKey(request.evaluationTime);
  const future = records.find(
    ({ timestamp }) => policyEvaluationTimestampOrderKey(timestamp) > evaluationTime,
  );
  if (future) {
    throw new PolicyEvaluationComparisonLineageError(
      "source_not_yet_available",
      `${future.label} is later than the requested evaluation time`,
    );
  }
}

function assertChronology(
  candidate: ReleaseCandidate,
  comparison: ComparisonDefinition,
  baseline: ComparisonEvidenceSnapshot,
  candidateSnapshot: ComparisonEvidenceSnapshot,
  result: ComparisonResult,
): void {
  const order = policyEvaluationTimestampOrderKey;
  const invalid =
    order(comparison.createdAt) > order(baseline.createdAt) ||
    order(comparison.createdAt) > order(candidateSnapshot.createdAt) ||
    order(baseline.createdAt) > order(result.createdAt) ||
    order(candidateSnapshot.createdAt) > order(result.createdAt) ||
    order(result.createdAt) > order(candidate.createdAt) ||
    baseline.fixtures.some(
      ({ replay }) => order(replay.completedAt) > order(baseline.sourceCutoff),
    ) ||
    candidateSnapshot.fixtures.some(
      ({ replay }) => order(replay.completedAt) > order(candidateSnapshot.sourceCutoff),
    );
  if (invalid) {
    throw new PolicyEvaluationComparisonLineageError(
      "lineage_chronology_invalid",
      "Comparison definition, snapshots, replay completions, result and candidate are not chronologically ordered",
    );
  }
}

function referenceKey(value: AssessmentReference | ModelAssuranceAssessmentReference): string {
  return "assessmentId" in value
    ? `${value.assessmentId}:${value.definitionSha256}`
    : `${value.assessmentExtensionId}:${value.definitionSha256}`;
}

function omissionReferenceKeys(
  snapshot: ComparisonEvidenceSnapshot,
  fixtureId: string,
  kind: "assessment" | "model_assurance_assessment",
): readonly string[] {
  return snapshot.omissions.flatMap((omission) => {
    if (omission.fixtureId !== fixtureId) return [];
    if (kind === "assessment" && omission.sourceKind === "assessment") {
      return [referenceKey(omission.assessment)];
    }
    if (
      kind === "model_assurance_assessment" &&
      omission.sourceKind === "model_assurance_assessment"
    ) {
      return [referenceKey(omission.modelAssuranceAssessment)];
    }
    return [];
  });
}

function assertAssuranceLineage(
  snapshot: ComparisonEvidenceSnapshot,
  expected: ComparisonDefinition["baseline"]["fixtures"][number],
  actual: ComparisonEvidenceFixtureSnapshot,
): void {
  const expectedAssessments = new Set(expected.assessments.map(referenceKey));
  const retainedAssessments = actual.assurance
    .filter((entry) => entry.kind === "assessment")
    .map(({ reference }) => referenceKey(reference));
  const outcomeAssessments = actual.evaluationOutcomes.map(({ assessment }) =>
    referenceKey(assessment),
  );
  const omittedAssessments = omissionReferenceKeys(
    snapshot,
    actual.fixture.fixtureId,
    "assessment",
  );
  const expectedModelAssurance = new Set(expected.modelAssuranceAssessments.map(referenceKey));
  const retainedModelAssurance = actual.assurance
    .filter((entry) => entry.kind === "model_assurance")
    .map(({ reference }) => referenceKey(reference));
  const omittedModelAssurance = omissionReferenceKeys(
    snapshot,
    actual.fixture.fixtureId,
    "model_assurance_assessment",
  );

  const assessmentInputs = [...retainedAssessments, ...outcomeAssessments, ...omittedAssessments];
  const modelInputs = [...retainedModelAssurance, ...omittedModelAssurance];
  if (
    assessmentInputs.some((key) => !expectedAssessments.has(key)) ||
    modelInputs.some((key) => !expectedModelAssurance.has(key))
  ) {
    throw new PolicyEvaluationComparisonLineageError(
      "snapshot_subject_mismatch",
      "Comparison snapshot contains assurance lineage outside its exact subject",
    );
  }

  for (const key of expectedAssessments) {
    const retained = retainedAssessments.filter((candidate) => candidate === key).length;
    const outcomes = outcomeAssessments.filter((candidate) => candidate === key).length;
    const omitted = omittedAssessments.filter((candidate) => candidate === key).length;
    if (
      !(
        (retained === 1 && outcomes === 1 && omitted === 0) ||
        (retained === 0 && outcomes === 0 && omitted === 1)
      )
    ) {
      throw new PolicyEvaluationComparisonLineageError(
        "snapshot_subject_mismatch",
        "Every subject assessment must be retained with one outcome or explicitly omitted once",
      );
    }
  }
  for (const key of expectedModelAssurance) {
    const retained = retainedModelAssurance.filter((candidate) => candidate === key).length;
    const omitted = omittedModelAssurance.filter((candidate) => candidate === key).length;
    if (!((retained === 1 && omitted === 0) || (retained === 0 && omitted === 1))) {
      throw new PolicyEvaluationComparisonLineageError(
        "snapshot_subject_mismatch",
        "Every subject model-assurance assessment must be retained or explicitly omitted once",
      );
    }
  }
}

function assertSnapshotSubject(
  comparison: ComparisonDefinition,
  role: "baseline" | "candidate",
  snapshot: ComparisonEvidenceSnapshot,
): void {
  const subject = comparison[role];
  if (
    !exact(snapshot.dataset, subject.dataset) ||
    snapshot.fixtures.length !== subject.fixtures.length
  ) {
    throw new PolicyEvaluationComparisonLineageError(
      "snapshot_subject_mismatch",
      `Comparison ${role} snapshot changed its exact dataset or fixture membership`,
    );
  }
  for (const [index, expected] of subject.fixtures.entries()) {
    const actual = snapshot.fixtures[index];
    if (
      !actual ||
      !exact(actual.fixture, expected.fixture) ||
      !exact(actual.replay, expected.replay)
    ) {
      throw new PolicyEvaluationComparisonLineageError(
        "snapshot_subject_mismatch",
        `Comparison ${role} snapshot substituted exact fixture or replay lineage`,
      );
    }
    assertAssuranceLineage(snapshot, expected, actual);
  }
}

function containsExact(values: readonly unknown[], expected: unknown): boolean {
  return values.some((value) => exact(value, expected));
}

function assertCandidateLineage(
  candidate: ReleaseCandidate,
  comparison: ComparisonDefinition,
): void {
  if (!containsExact(candidate.datasets, comparison.candidate.dataset)) {
    throw new PolicyEvaluationComparisonLineageError(
      "candidate_lineage_mismatch",
      "Selected comparison candidate dataset is absent from the release candidate",
    );
  }
  for (const fixture of comparison.candidate.fixtures) {
    if (!exact(fixture.replay.targetRelease, candidate.targetRelease)) {
      throw new PolicyEvaluationComparisonLineageError(
        "candidate_lineage_mismatch",
        "Selected comparison candidate replay targets a different release",
      );
    }
    if (
      !fixture.assessments.every((reference) => containsExact(candidate.assessments, reference))
    ) {
      throw new PolicyEvaluationComparisonLineageError(
        "candidate_lineage_mismatch",
        "Selected comparison uses an assessment not declared by the release candidate",
      );
    }
    if (
      !fixture.modelAssuranceAssessments.every((reference) =>
        containsExact(candidate.modelAssuranceAssessments, reference),
      )
    ) {
      throw new PolicyEvaluationComparisonLineageError(
        "candidate_lineage_mismatch",
        "Selected comparison uses model-assurance evidence not declared by the release candidate",
      );
    }
  }
}

function assertResultDerivation(
  comparison: ComparisonDefinition,
  baseline: ComparisonEvidenceSnapshot,
  candidate: ComparisonEvidenceSnapshot,
  result: ComparisonResult,
): void {
  let expected: unknown;
  try {
    expected = deriveComparisonResultDefinition({
      baseline,
      candidate,
      comparison,
      resultId: result.resultId,
    });
  } catch (cause) {
    throw new PolicyEvaluationComparisonLineageError(
      "result_derivation_mismatch",
      "Selected comparison result cannot be reproduced from its exact records",
      { cause },
    );
  }
  if (!exact(expected, definitionOfResult(result))) {
    throw new PolicyEvaluationComparisonLineageError(
      "result_derivation_mismatch",
      "Selected comparison result differs from deterministic re-derivation",
    );
  }
}

function directSources(
  candidate: ReleaseCandidate,
  policy: ReleasePolicy,
  comparison: ComparisonDefinition,
  baseline: ComparisonEvidenceSnapshot,
  candidateSnapshot: ComparisonEvidenceSnapshot,
  result: ComparisonResult,
): readonly PolicyEvaluationSourceReference[] {
  const byIdentity = new Map<string, PolicyEvaluationSourceReference>();
  const add = (source: PolicyEvaluationSourceReference): void => {
    const key = policyEvaluationSourceReferenceKey(source);
    const previous = byIdentity.get(key);
    if (previous && !exact(previous, source)) {
      throw new PolicyEvaluationComparisonLineageError(
        "source_reference_conflict",
        `Comparison lineage uses conflicting exact references for ${key}`,
      );
    }
    byIdentity.set(key, source);
  };

  add({ kind: "release_candidate", reference: releaseCandidateReference(candidate) });
  add({ kind: "release_policy", reference: releasePolicyReference(policy) });
  add({ kind: "comparison_definition", reference: comparisonReference(comparison) });
  add({ kind: "comparison_result", reference: resultReference(result) });
  add({ kind: "comparison_snapshot", reference: snapshotReference(baseline) });
  add({ kind: "comparison_snapshot", reference: snapshotReference(candidateSnapshot) });

  for (const subject of [comparison.baseline, comparison.candidate]) {
    add({ kind: "dataset_version", reference: subject.dataset });
    for (const fixture of subject.fixtures) {
      add({ kind: "regression_fixture_version", reference: fixture.fixture });
      add({ kind: "replay_plan", reference: fixture.replay.plan });
      add({ kind: "replay_result", reference: fixture.replay });
      add({ kind: "target_release", reference: fixture.replay.targetRelease });
      for (const reference of fixture.assessments) add({ kind: "assessment", reference });
      for (const reference of fixture.modelAssuranceAssessments) {
        add({ kind: "model_assurance_assessment", reference });
      }
    }
  }
  for (const snapshot of [baseline, candidateSnapshot]) {
    for (const fixture of snapshot.fixtures) {
      for (const { criterion } of fixture.evaluationOutcomes) {
        add({ kind: "criterion_set", reference: criterion.criterionSet });
      }
      for (const { observation } of fixture.numericObservations) {
        add({ kind: "raw_observation", reference: observation });
      }
    }
  }
  const ordered = [...byIdentity.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, source]) => source);
  try {
    return PolicyEvaluationExpectedSourcesSchema.parse(ordered);
  } catch (cause) {
    throw new PolicyEvaluationComparisonLineageError(
      "source_reference_conflict",
      "Comparison lineage did not produce one bounded ordered direct-source inventory",
      { cause },
    );
  }
}

/**
 * Recomputes complete candidate selection, validates every comparison record digest and binding,
 * re-derives the selected result, and emits only exact direct lineage references. This function
 * does not claim that the referenced subordinate records have been acquired or verified.
 */
export function resolvePolicyEvaluationComparisonLineage(
  input: ResolvePolicyEvaluationComparisonLineageInput,
): PolicyEvaluationComparisonLineage {
  // Retain parsed defensive copies before acquisition can execute caller-owned accessors.
  // Re-reading the original roots afterward could mix two independently valid graphs.
  const request = validatePolicyEvaluationRequestRecord(input.request);
  const candidate = validateReleaseCandidateRecord(input.candidate);
  const policy = validateReleasePolicyRecord(input.policy);
  const comparison = parseComparison(input.comparison);
  const baseline = parseSnapshot(input.baselineSnapshot, "baseline");
  const candidateSnapshot = parseSnapshot(input.candidateSnapshot, "candidate");
  const fixedInput = {
    acquisitions: input.acquisitions,
    candidate,
    policy,
    request,
  };
  const inventory = resolvePolicyEvaluationComparisons(fixedInput);
  const reference = comparisonReference(comparison);
  const resolution = inventory.policyComparisons.find(({ comparison: item }) =>
    exact(item, reference),
  );
  if (resolution?.status !== "unique") {
    throw new PolicyEvaluationComparisonLineageError(
      "selection_not_unique",
      "Comparison lineage requires one unique complete-inventory selection",
    );
  }
  const result = selectedResult(fixedInput.acquisitions, resolution.result);

  assertExactScope(request.scope, [
    { label: "comparison definition", scope: comparison.scope },
    { label: "baseline comparison snapshot", scope: baseline.scope },
    { label: "candidate comparison snapshot", scope: candidateSnapshot.scope },
    { label: "comparison result", scope: result.scope },
  ]);
  assertAvailableAt(request, [
    { label: "comparison definition", timestamp: comparison.createdAt },
    { label: "baseline comparison snapshot", timestamp: baseline.createdAt },
    { label: "baseline comparison source cutoff", timestamp: baseline.sourceCutoff },
    { label: "candidate comparison snapshot", timestamp: candidateSnapshot.createdAt },
    { label: "candidate comparison source cutoff", timestamp: candidateSnapshot.sourceCutoff },
    { label: "comparison result", timestamp: result.createdAt },
    { label: "comparison result source cutoff", timestamp: result.latestSourceCutoff },
  ]);
  if (
    !exact(result.comparison, reference) ||
    !exact(baseline.comparison, reference) ||
    !exact(candidateSnapshot.comparison, reference) ||
    !exact(result.baselineSnapshot, snapshotReference(baseline)) ||
    !exact(result.candidateSnapshot, snapshotReference(candidateSnapshot))
  ) {
    throw new PolicyEvaluationComparisonLineageError(
      "comparison_reference_mismatch",
      "Comparison result, definition and snapshots do not form one exact reference graph",
    );
  }
  const member = inventory.members.find(({ reference: item }) => exact(item, resolution.result));
  if (
    member?.observation.status !== "verified" ||
    member.observation.recordSha256 !== fullRecordSha256(result)
  ) {
    throw new PolicyEvaluationComparisonLineageError(
      "selection_result_mismatch",
      "Selected comparison result changed after complete-inventory classification",
    );
  }

  assertChronology(candidate, comparison, baseline, candidateSnapshot, result);
  assertSnapshotSubject(comparison, "baseline", baseline);
  assertSnapshotSubject(comparison, "candidate", candidateSnapshot);
  assertCandidateLineage(candidate, comparison);
  assertResultDerivation(comparison, baseline, candidateSnapshot, result);

  return structuredClone({
    baselineSnapshot: baseline,
    candidateSnapshot,
    comparison,
    directSources: directSources(
      candidate,
      policy,
      comparison,
      baseline,
      candidateSnapshot,
      result,
    ),
    inventory,
    result,
  });
}
