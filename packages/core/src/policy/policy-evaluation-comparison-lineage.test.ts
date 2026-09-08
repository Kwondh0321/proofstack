import {
  COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  COMPARISON_RESULT_SCHEMA_VERSION,
  type ComparisonDefinition,
  type ComparisonEvidenceSnapshot,
  type ComparisonEvidenceSnapshotDefinition,
  type ComparisonResult,
  type ComparisonResultDefinition,
  type EvidenceScope,
  POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
  type PolicyEvaluationRequest,
  type PolicyEvaluationRequestDefinition,
  policyEvaluationSourceReferenceKey,
  RELEASE_CANDIDATE_SCHEMA_VERSION,
  RELEASE_POLICY_SCHEMA_VERSION,
  type ReleaseCandidate,
  type ReleaseCandidateDefinition,
  type ReleasePolicy,
  type ReleasePolicyDefinition,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { digestComparisonRecordDefinition } from "../evaluation/comparison-record-validation.js";
import { deriveComparisonResultDefinition } from "../evaluation/derive-comparison-result.js";
import { digestReleaseCandidateDefinition } from "../release/release-candidate-record-validation.js";
import {
  comparisonDefinitionFixture,
  comparisonFixtureScope,
  comparisonSnapshotFixture,
} from "../testing/comparison-repository-fixtures.js";
import { releaseCandidateFixture } from "../testing/release-candidate-repository-fixtures.js";
import { releasePolicyRepositoryFixture } from "../testing/release-policy-repository-fixtures.js";
import {
  PolicyEvaluationComparisonLineageError,
  resolvePolicyEvaluationComparisonLineage,
} from "./policy-evaluation-comparison-lineage.js";
import { digestPolicyEvaluationRequestDefinition } from "./policy-evaluation-request-record-validation.js";
import { digestReleasePolicyDefinition } from "./release-policy-record-validation.js";

const recordReceiptKeys = [
  "createdAt",
  "createdByPrincipalId",
  "definitionSha256",
  "schemaVersion",
  "scope",
] as const;
const policyReceiptKeys = [
  "definitionSha256",
  "publishedAt",
  "publishedByPrincipalId",
  "schemaVersion",
  "scope",
] as const;

function definitionOf<RecordType extends object, Definition>(
  record: RecordType,
  keys: readonly string[],
): Definition {
  const value = structuredClone(record) as Record<string, unknown>;
  for (const key of keys) delete value[key];
  return value as Definition;
}

function required<T>(value: T | undefined, message = "Expected test fixture member"): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function comparisonReference(comparison: ComparisonDefinition) {
  return {
    comparisonId: comparison.comparisonId,
    comparisonVersionId: comparison.comparisonVersionId,
    definitionSha256: comparison.definitionSha256,
  };
}

function resultReference(result: ComparisonResult) {
  return { definitionSha256: result.definitionSha256, resultId: result.resultId };
}

function buildSnapshot(
  namespace: string,
  scope: EvidenceScope,
  comparison: ComparisonDefinition,
  role: "baseline" | "candidate",
): ComparisonEvidenceSnapshot {
  const template = comparisonSnapshotFixture(namespace, scope, comparison, role);
  const templateFixture = template.fixtures[0];
  const templateOutcome = templateFixture?.evaluationOutcomes[0];
  if (!templateFixture || !templateOutcome) throw new Error("Expected comparison fixture template");
  const subject = comparison[role];
  const definition: ComparisonEvidenceSnapshotDefinition = {
    comparison: comparisonReference(comparison),
    dataset: structuredClone(subject.dataset),
    fixtures: subject.fixtures.map((fixture) => ({
      ...structuredClone(templateFixture),
      assurance: [
        ...fixture.assessments.map((reference) => ({
          eligibility: "eligible" as const,
          kind: "assessment" as const,
          reasons: [],
          reference: structuredClone(reference),
        })),
        ...fixture.modelAssuranceAssessments.map((reference) => ({
          eligibility: "eligible" as const,
          kind: "model_assurance" as const,
          reasons: [],
          reference: structuredClone(reference),
        })),
      ],
      evaluationOutcomes: fixture.assessments.map((reference) => ({
        ...structuredClone(templateOutcome),
        assessment: structuredClone(reference),
      })),
      fixture: structuredClone(fixture.fixture),
      replay: structuredClone(fixture.replay),
    })),
    integrity: "verified",
    knownLimitations: ["Synthetic exact lineage fixture"],
    omissions: [],
    role,
    snapshotId: `snapshot_${namespace}_${role}`,
    sourceCutoff: role === "baseline" ? "2026-09-02T01:00:01.000Z" : "2026-09-02T01:05:01.000Z",
  };
  return {
    ...definition,
    createdAt: "2026-09-02T03:00:00.000Z",
    createdByPrincipalId: `principal_${namespace}`,
    definitionSha256: digestComparisonRecordDefinition(
      "comparison_evidence_snapshot",
      scope,
      definition,
    ),
    schemaVersion: COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
    scope: structuredClone(scope),
  };
}

function buildResult(
  namespace: string,
  scope: EvidenceScope,
  comparison: ComparisonDefinition,
  baseline: ComparisonEvidenceSnapshot,
  candidate: ComparisonEvidenceSnapshot,
): ComparisonResult {
  const definition = deriveComparisonResultDefinition({
    baseline,
    candidate,
    comparison,
    resultId: `result_${namespace}`,
  });
  return {
    ...definition,
    createdAt: "2026-09-02T04:00:00.000Z",
    createdByPrincipalId: `principal_${namespace}`,
    definitionSha256: digestComparisonRecordDefinition("comparison_result", scope, definition),
    schemaVersion: COMPARISON_RESULT_SCHEMA_VERSION,
    scope: structuredClone(scope),
  };
}

function bindCandidate(
  candidate: ReleaseCandidate,
  comparison: ComparisonDefinition,
  result: ComparisonResult,
): ReleaseCandidate {
  const definition = definitionOf<ReleaseCandidate, ReleaseCandidateDefinition>(
    candidate,
    recordReceiptKeys,
  );
  definition.assessments = comparison.candidate.fixtures
    .flatMap(({ assessments }) => assessments)
    .sort((left, right) => left.assessmentId.localeCompare(right.assessmentId));
  definition.comparisons = [resultReference(result)];
  definition.datasets = [structuredClone(comparison.candidate.dataset)];
  definition.modelAssuranceAssessments = comparison.candidate.fixtures
    .flatMap(({ modelAssuranceAssessments }) => modelAssuranceAssessments)
    .sort((left, right) => left.assessmentExtensionId.localeCompare(right.assessmentExtensionId));
  const targetRelease = comparison.candidate.fixtures[0]?.replay.targetRelease;
  if (!targetRelease) throw new Error("Expected candidate replay target");
  definition.targetRelease = structuredClone(targetRelease);
  return {
    ...definition,
    createdAt: candidate.createdAt,
    createdByPrincipalId: candidate.createdByPrincipalId,
    definitionSha256: digestReleaseCandidateDefinition(candidate.scope, definition),
    schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
    scope: structuredClone(candidate.scope),
  };
}

function bindPolicy(policy: ReleasePolicy, comparison: ComparisonDefinition): ReleasePolicy {
  const definition = definitionOf<ReleasePolicy, ReleasePolicyDefinition>(
    policy,
    policyReceiptKeys,
  );
  definition.rules = definition.rules.map((rule) =>
    "comparison" in rule.predicate
      ? {
          ...rule,
          predicate: { ...rule.predicate, comparison: comparisonReference(comparison) },
        }
      : rule,
  );
  return {
    ...definition,
    definitionSha256: digestReleasePolicyDefinition(policy.scope, definition),
    publishedAt: policy.publishedAt,
    publishedByPrincipalId: policy.publishedByPrincipalId,
    schemaVersion: RELEASE_POLICY_SCHEMA_VERSION,
    scope: structuredClone(policy.scope),
  };
}

function buildRequest(
  candidate: ReleaseCandidate,
  policy: ReleasePolicy,
  evaluationTime = "2026-09-07T12:00:00.123456789012345678901234567890Z",
): PolicyEvaluationRequest {
  const definition: PolicyEvaluationRequestDefinition = {
    algorithm: { id: "proofstack.deterministic-policy", version: "1.0.0" },
    candidate: {
      candidateId: candidate.candidateId,
      candidateVersionId: candidate.candidateVersionId,
      definitionSha256: candidate.definitionSha256,
    },
    evaluationRequestId: "request_lineage",
    evaluationTime,
    limits: {
      heartbeatIntervalMilliseconds: 1_000,
      leaseDurationMilliseconds: 5_000,
      maxAcquisitionRecordBytes: 8_388_608,
      maxAcquisitionRecords: 10_000,
      maxArtifactReadBytes: 16_777_216,
      maxAttempts: 2,
      maxRuleEvaluations: 256,
      perAttemptTimeoutMilliseconds: 20_000,
      retryBackoffMilliseconds: 100,
      retryableErrors: ["source_revision_changed"],
      totalDeadlineMilliseconds: 60_000,
    },
    policy: {
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
      definitionSha256: policy.definitionSha256,
    },
  };
  return {
    ...definition,
    createdAt: "2026-09-07T13:00:00.000Z",
    createdByPrincipalId: "principal_requester",
    definitionSha256: digestPolicyEvaluationRequestDefinition(candidate.scope, definition),
    schemaVersion: POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
    scope: structuredClone(candidate.scope),
  };
}

function fixture(namespace = "lineage") {
  const scope = comparisonFixtureScope(namespace);
  const comparison = comparisonDefinitionFixture(namespace, scope);
  const baselineSnapshot = buildSnapshot(namespace, scope, comparison, "baseline");
  const candidateSnapshot = buildSnapshot(namespace, scope, comparison, "candidate");
  const result = buildResult(namespace, scope, comparison, baselineSnapshot, candidateSnapshot);
  const candidate = bindCandidate(releaseCandidateFixture(namespace, scope), comparison, result);
  const policy = bindPolicy(releasePolicyRepositoryFixture(namespace, scope), comparison);
  const request = buildRequest(candidate, policy);
  return {
    acquisitions: [{ reference: resultReference(result), result }],
    baselineSnapshot,
    candidate,
    candidateSnapshot,
    comparison,
    policy,
    request,
    result,
    scope,
  };
}

function replaceResult(
  value: ReturnType<typeof fixture>,
  result: ComparisonResult,
): ReturnType<typeof fixture> {
  const candidate = bindCandidate(value.candidate, value.comparison, result);
  return {
    ...value,
    acquisitions: [{ reference: resultReference(result), result }],
    candidate,
    request: buildRequest(candidate, value.policy),
    result,
  };
}

function rebuildResult(
  value: ReturnType<typeof fixture>,
  baselineSnapshot = value.baselineSnapshot,
  candidateSnapshot = value.candidateSnapshot,
  comparison = value.comparison,
): ReturnType<typeof fixture> {
  const result = buildResult(
    value.result.resultId.replace(/^result_/u, ""),
    value.scope,
    comparison,
    baselineSnapshot,
    candidateSnapshot,
  );
  const candidate = bindCandidate(value.candidate, comparison, result);
  const policy = bindPolicy(value.policy, comparison);
  return {
    ...value,
    acquisitions: [{ reference: resultReference(result), result }],
    baselineSnapshot,
    candidate,
    candidateSnapshot,
    comparison,
    policy,
    request: buildRequest(candidate, policy),
    result,
  };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("Expected lineage validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyEvaluationComparisonLineageError);
    expect((error as PolicyEvaluationComparisonLineageError).code).toBe(code);
  }
}

describe("selected policy evaluation comparison lineage", () => {
  it("revalidates and re-derives one exact lineage before exposing ordered direct sources", () => {
    const value = fixture();
    const output = resolvePolicyEvaluationComparisonLineage(value);
    expect(output.result).toEqual(value.result);
    const keys = output.directSources.map(policyEvaluationSourceReferenceKey);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining([
        `assessment:${value.comparison.candidate.fixtures[0]?.assessments[0]?.assessmentId}`,
        `comparison_definition:${value.comparison.comparisonVersionId}`,
        `comparison_result:${value.result.resultId}`,
        `comparison_snapshot:${value.baselineSnapshot.snapshotId}`,
        `comparison_snapshot:${value.candidateSnapshot.snapshotId}`,
        `dataset_version:${value.comparison.candidate.dataset.datasetVersionId}`,
        `model_assurance_assessment:${value.comparison.candidate.fixtures[0]?.modelAssuranceAssessments[0]?.assessmentExtensionId}`,
        `release_candidate:${value.candidate.candidateVersionId}`,
        `release_policy:${value.policy.policyVersionId}`,
        `replay_result:${value.comparison.candidate.fixtures[0]?.replay.attemptId}`,
        `target_release:${value.candidate.targetRelease.targetReleaseId}`,
      ]),
    );
  });

  it("returns defensive records, inventory and source references", () => {
    const value = fixture("lineage_clone");
    const before = structuredClone(value);
    const output = resolvePolicyEvaluationComparisonLineage(value);
    output.result.resultId = "result_mutated";
    required(output.inventory.members[0]).reference.resultId = "result_mutated";
    (
      required(output.directSources[0]).reference as {
        definitionSha256: string;
      }
    ).definitionSha256 = "f".repeat(64);
    expect(value).toEqual(before);
  });

  it.each([
    "candidate",
    "policy",
    "request",
    "comparison",
    "baselineSnapshot",
    "candidateSnapshot",
  ] as const)("keeps validated inputs stable when acquisition mutates caller-owned %s", (kind) => {
    const value = fixture(`lineage_mut_${kind.toLowerCase()}`);
    const original = structuredClone(value[kind]);
    const expected = resolvePolicyEvaluationComparisonLineage(value);
    const acquisition = {
      reference: resultReference(value.result),
      get result(): unknown {
        if (kind === "candidate") {
          const definition = definitionOf<ReleaseCandidate, ReleaseCandidateDefinition>(
            value.candidate,
            recordReceiptKeys,
          );
          definition.knownLimitations = ["Changed after root validation"];
          value.candidate.knownLimitations = definition.knownLimitations;
          value.candidate.definitionSha256 = digestReleaseCandidateDefinition(
            value.scope,
            definition,
          );
        } else if (kind === "policy") {
          const definition = definitionOf<ReleasePolicy, ReleasePolicyDefinition>(
            value.policy,
            policyReceiptKeys,
          );
          definition.knownLimitations = ["Changed after root validation"];
          value.policy.knownLimitations = definition.knownLimitations;
          value.policy.definitionSha256 = digestReleasePolicyDefinition(value.scope, definition);
        } else if (kind === "request") {
          const definition = definitionOf<
            PolicyEvaluationRequest,
            PolicyEvaluationRequestDefinition
          >(value.request, recordReceiptKeys);
          definition.evaluationTime = "2026-09-07T12:00:00.124Z";
          value.request.evaluationTime = definition.evaluationTime;
          value.request.definitionSha256 = digestPolicyEvaluationRequestDefinition(
            value.scope,
            definition,
          );
        } else {
          value[kind].createdAt = "2026-10-01T00:00:00.000Z";
        }
        return value.result;
      },
    };
    const output = resolvePolicyEvaluationComparisonLineage({
      ...value,
      acquisitions: [acquisition],
    });
    expect(value[kind]).not.toEqual(original);
    expect(output).toEqual(expected);
  });

  it.each(["comparison", "baselineSnapshot", "candidateSnapshot"])(
    "rejects an invalid %s canonical digest",
    (record) => {
      const suffix =
        record === "comparison" ? "cmp" : record === "baselineSnapshot" ? "base" : "cand";
      const value = fixture(`lineage_digest_${suffix}`);
      (value[record as "comparison"] as { definitionSha256: string }).definitionSha256 = "f".repeat(
        64,
      );
      expectCode(
        () => resolvePolicyEvaluationComparisonLineage(value),
        record === "comparison" ? "comparison_record_invalid" : "snapshot_record_invalid",
      );
    },
  );

  it("requires complete-inventory selection to remain unique", () => {
    const value = fixture("lineage_selection");
    const changed = {
      ...value,
      acquisitions: [{ reference: resultReference(value.result), result: null }],
    };
    expectCode(() => resolvePolicyEvaluationComparisonLineage(changed), "selection_not_unique");
  });

  it.each(["null", "invalid", "different", "changed_receipt"])(
    "rejects a selected acquisition that changes after inventory validation: %s",
    (mode) => {
      const suffix = mode === "changed_receipt" ? "receipt" : mode;
      const value = fixture(`lineage_race_${suffix}`);
      const second =
        mode === "null"
          ? null
          : mode === "invalid"
            ? { ...value.result, definitionSha256: "f".repeat(64) }
            : mode === "different"
              ? buildResult(
                  "lineage_race_other",
                  value.scope,
                  value.comparison,
                  value.baselineSnapshot,
                  value.candidateSnapshot,
                )
              : { ...value.result, createdAt: "2026-09-02T04:00:00.001Z" };
      let reads = 0;
      const acquisition = {
        reference: resultReference(value.result),
        get result(): unknown {
          reads += 1;
          return reads === 1 ? value.result : second;
        },
      };
      expectCode(
        () =>
          resolvePolicyEvaluationComparisonLineage({
            ...value,
            acquisitions: [acquisition],
          }),
        "selection_result_mismatch",
      );
    },
  );

  it("rejects a snapshot supplied in the opposite role", () => {
    const value = fixture("lineage_role");
    expectCode(
      () =>
        resolvePolicyEvaluationComparisonLineage({
          ...value,
          baselineSnapshot: value.candidateSnapshot,
        }),
      "comparison_reference_mismatch",
    );
  });

  it("rejects a cross-scope snapshot even when its canonical digest is valid", () => {
    const value = fixture("lineage_scope");
    const snapshot = structuredClone(value.baselineSnapshot);
    snapshot.scope.environmentId = "env_other";
    const definition = definitionOf<
      ComparisonEvidenceSnapshot,
      ComparisonEvidenceSnapshotDefinition
    >(snapshot, recordReceiptKeys);
    snapshot.definitionSha256 = digestComparisonRecordDefinition(
      "comparison_evidence_snapshot",
      snapshot.scope,
      definition,
    );
    const changed = { ...value, baselineSnapshot: snapshot };
    expectCode(() => resolvePolicyEvaluationComparisonLineage(changed), "scope_mismatch");
  });

  it("rejects subordinate records later than full-precision evaluation time", () => {
    const value = fixture("lineage_future");
    value.comparison.createdAt = "2026-09-07T12:00:00.124Z";
    expectCode(() => resolvePolicyEvaluationComparisonLineage(value), "source_not_yet_available");
  });

  it("rejects impossible publication and replay-cutoff chronology", () => {
    const value = fixture("lineage_chronology");
    value.comparison.createdAt = "2026-09-03T00:00:00.000Z";
    expectCode(() => resolvePolicyEvaluationComparisonLineage(value), "lineage_chronology_invalid");
  });

  it("rejects a replay completion beyond its claimed source cutoff", () => {
    const value = fixture("lineage_cutoff");
    const candidateSnapshot = structuredClone(value.candidateSnapshot);
    candidateSnapshot.sourceCutoff = "2026-09-02T01:04:59.999Z";
    const definition = definitionOf<
      ComparisonEvidenceSnapshot,
      ComparisonEvidenceSnapshotDefinition
    >(candidateSnapshot, recordReceiptKeys);
    candidateSnapshot.definitionSha256 = digestComparisonRecordDefinition(
      "comparison_evidence_snapshot",
      value.scope,
      definition,
    );
    const changed = rebuildResult(
      { ...value, candidateSnapshot },
      value.baselineSnapshot,
      candidateSnapshot,
    );
    expectCode(
      () => resolvePolicyEvaluationComparisonLineage(changed),
      "lineage_chronology_invalid",
    );
  });

  it("rejects a substituted exact snapshot reference", () => {
    const value = fixture("lineage_reference");
    value.baselineSnapshot.snapshotId = "snapshot_other";
    const definition = definitionOf<
      ComparisonEvidenceSnapshot,
      ComparisonEvidenceSnapshotDefinition
    >(value.baselineSnapshot, recordReceiptKeys);
    value.baselineSnapshot.definitionSha256 = digestComparisonRecordDefinition(
      "comparison_evidence_snapshot",
      value.scope,
      definition,
    );
    expectCode(
      () => resolvePolicyEvaluationComparisonLineage(value),
      "comparison_reference_mismatch",
    );
  });

  it("rejects snapshot fixture or replay substitution even when the result reflects it", () => {
    const value = fixture("lineage_subject");
    const candidateSnapshot = structuredClone(value.candidateSnapshot);
    const fixtureSnapshot = required(candidateSnapshot.fixtures[0]);
    fixtureSnapshot.replay = {
      ...fixtureSnapshot.replay,
      attemptId: "attempt_substituted",
    };
    const definition = definitionOf<
      ComparisonEvidenceSnapshot,
      ComparisonEvidenceSnapshotDefinition
    >(candidateSnapshot, recordReceiptKeys);
    candidateSnapshot.definitionSha256 = digestComparisonRecordDefinition(
      "comparison_evidence_snapshot",
      value.scope,
      definition,
    );
    const changed = rebuildResult(
      { ...value, candidateSnapshot },
      value.baselineSnapshot,
      candidateSnapshot,
    );
    expectCode(
      () => resolvePolicyEvaluationComparisonLineage(changed),
      "snapshot_subject_mismatch",
    );
  });

  it("accepts one explicit optional-assessment omission without dropping the expected source", () => {
    const value = fixture("lineage_omission");
    const candidateSnapshot = structuredClone(value.candidateSnapshot);
    const fixtureSnapshot = required(candidateSnapshot.fixtures[0]);
    const expected = required(value.comparison.candidate.fixtures[0]);
    const expectedAssessment = required(expected.assessments[0]);
    fixtureSnapshot.assurance = fixtureSnapshot.assurance.filter(
      (entry) => entry.kind !== "assessment",
    );
    fixtureSnapshot.evaluationOutcomes = [];
    candidateSnapshot.omissions = [
      {
        assessment: structuredClone(expectedAssessment),
        fixtureId: fixtureSnapshot.fixture.fixtureId,
        reason: "optional_assessment_missing",
        sourceKind: "assessment",
      },
    ];
    const definition = definitionOf<
      ComparisonEvidenceSnapshot,
      ComparisonEvidenceSnapshotDefinition
    >(candidateSnapshot, recordReceiptKeys);
    candidateSnapshot.definitionSha256 = digestComparisonRecordDefinition(
      "comparison_evidence_snapshot",
      value.scope,
      definition,
    );
    const changed = rebuildResult(
      { ...value, candidateSnapshot },
      value.baselineSnapshot,
      candidateSnapshot,
    );
    const output = resolvePolicyEvaluationComparisonLineage(changed);
    expect(output.directSources).toContainEqual({
      kind: "assessment",
      reference: expectedAssessment,
    });
  });

  it("rejects unaccounted or extra assurance lineage", () => {
    const value = fixture("lineage_assurance");
    const candidateSnapshot = structuredClone(value.candidateSnapshot);
    required(candidateSnapshot.fixtures[0]).evaluationOutcomes = [];
    const definition = definitionOf<
      ComparisonEvidenceSnapshot,
      ComparisonEvidenceSnapshotDefinition
    >(candidateSnapshot, recordReceiptKeys);
    candidateSnapshot.definitionSha256 = digestComparisonRecordDefinition(
      "comparison_evidence_snapshot",
      value.scope,
      definition,
    );
    const changed = rebuildResult(
      { ...value, candidateSnapshot },
      value.baselineSnapshot,
      candidateSnapshot,
    );
    expectCode(
      () => resolvePolicyEvaluationComparisonLineage(changed),
      "snapshot_subject_mismatch",
    );
  });

  it.each(["dataset", "assessment", "model_assurance", "target"])(
    "rejects comparison lineage absent from candidate %s declarations",
    (kind) => {
      const value = fixture(`lineage_candidate_${kind}`);
      const definition = definitionOf<ReleaseCandidate, ReleaseCandidateDefinition>(
        value.candidate,
        recordReceiptKeys,
      );
      if (kind === "dataset") {
        definition.datasets = [
          { ...required(definition.datasets[0]), definitionSha256: "f".repeat(64) },
        ];
      } else if (kind === "assessment") {
        definition.assessments = [
          { ...required(definition.assessments[0]), definitionSha256: "f".repeat(64) },
        ];
      } else if (kind === "model_assurance") {
        definition.modelAssuranceAssessments = [
          {
            ...required(definition.modelAssuranceAssessments[0]),
            definitionSha256: "f".repeat(64),
          },
        ];
      } else {
        definition.targetRelease = {
          ...definition.targetRelease,
          definitionSha256: "f".repeat(64),
        };
      }
      const candidate: ReleaseCandidate = {
        ...definition,
        createdAt: value.candidate.createdAt,
        createdByPrincipalId: value.candidate.createdByPrincipalId,
        definitionSha256: digestReleaseCandidateDefinition(value.scope, definition),
        schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
        scope: structuredClone(value.scope),
      };
      const changed = { ...value, candidate, request: buildRequest(candidate, value.policy) };
      expectCode(
        () => resolvePolicyEvaluationComparisonLineage(changed),
        "candidate_lineage_mismatch",
      );
    },
  );

  it("rejects a canonical but non-derived comparison result", () => {
    const value = fixture("lineage_result");
    const definition = definitionOf<ComparisonResult, ComparisonResultDefinition>(
      value.result,
      recordReceiptKeys,
    );
    definition.knownLimitations = [
      ...definition.knownLimitations,
      "Synthetic modified result",
    ].sort();
    const result: ComparisonResult = {
      ...definition,
      createdAt: value.result.createdAt,
      createdByPrincipalId: value.result.createdByPrincipalId,
      definitionSha256: digestComparisonRecordDefinition(
        "comparison_result",
        value.scope,
        definition,
      ),
      schemaVersion: COMPARISON_RESULT_SCHEMA_VERSION,
      scope: structuredClone(value.scope),
    };
    const changed = replaceResult(value, result);
    expectCode(
      () => resolvePolicyEvaluationComparisonLineage(changed),
      "result_derivation_mismatch",
    );
  });

  it("rejects two digests for one direct-source repository identity", () => {
    const value = fixture("lineage_conflict");
    const definition = definitionOf<ComparisonDefinition, ComparisonDefinition>(
      value.comparison,
      recordReceiptKeys,
    );
    definition.candidate.dataset = {
      ...definition.baseline.dataset,
      definitionSha256: "f".repeat(64),
    };
    const comparison: ComparisonDefinition = {
      ...definition,
      createdAt: value.comparison.createdAt,
      createdByPrincipalId: value.comparison.createdByPrincipalId,
      definitionSha256: digestComparisonRecordDefinition(
        "comparison_definition",
        value.scope,
        definition,
      ),
      schemaVersion: value.comparison.schemaVersion,
      scope: structuredClone(value.scope),
    };
    const baselineSnapshot = buildSnapshot("lineage_conflict", value.scope, comparison, "baseline");
    const candidateSnapshot = buildSnapshot(
      "lineage_conflict",
      value.scope,
      comparison,
      "candidate",
    );
    const changed = rebuildResult(
      { ...value, baselineSnapshot, candidateSnapshot, comparison },
      baselineSnapshot,
      candidateSnapshot,
      comparison,
    );
    expectCode(
      () => resolvePolicyEvaluationComparisonLineage(changed),
      "source_reference_conflict",
    );
  });
});
