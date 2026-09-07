import { createHash } from "node:crypto";
import {
  type ComparisonDefinition,
  type ComparisonResult,
  type EvidenceScope,
  encodeEvaluationCanonicalJson,
  POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
  type PolicyEvaluationRequest,
  type PolicyEvaluationRequestDefinition,
  RELEASE_CANDIDATE_SCHEMA_VERSION,
  RELEASE_POLICY_SCHEMA_VERSION,
  type ReleaseCandidate,
  type ReleaseCandidateComparisonReference,
  type ReleaseCandidateDefinition,
  type ReleasePolicy,
  type ReleasePolicyDefinition,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { digestReleaseCandidateDefinition } from "../release/release-candidate-record-validation.js";
import {
  comparisonDefinitionFixture,
  comparisonFixtureScope,
  comparisonResultFixture,
  comparisonSnapshotFixture,
} from "../testing/comparison-repository-fixtures.js";
import { releaseCandidateFixture } from "../testing/release-candidate-repository-fixtures.js";
import { releasePolicyRepositoryFixture } from "../testing/release-policy-repository-fixtures.js";
import {
  type PolicyEvaluationComparisonAcquisition,
  PolicyEvaluationComparisonSelectionError,
  resolvePolicyEvaluationComparisons,
} from "./policy-evaluation-comparison-selection.js";
import {
  digestPolicyEvaluationRequestDefinition,
  policyEvaluationRequestReference,
  validatePolicyEvaluationRequestRecord,
} from "./policy-evaluation-request-record-validation.js";
import { digestReleasePolicyDefinition } from "./release-policy-record-validation.js";

const candidateReceiptKeys = [
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
const requestReceiptKeys = [
  "createdAt",
  "createdByPrincipalId",
  "definitionSha256",
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
function candidateReference(candidate: ReleaseCandidate) {
  return {
    candidateId: candidate.candidateId,
    candidateVersionId: candidate.candidateVersionId,
    definitionSha256: candidate.definitionSha256,
  };
}
function policyReference(policy: ReleasePolicy) {
  return {
    policyId: policy.policyId,
    policyVersionId: policy.policyVersionId,
    definitionSha256: policy.definitionSha256,
  };
}
function resultReference(result: ComparisonResult): ReleaseCandidateComparisonReference {
  return { resultId: result.resultId, definitionSha256: result.definitionSha256 };
}
function bindCandidate(
  candidate: ReleaseCandidate,
  results: readonly ComparisonResult[],
): ReleaseCandidate {
  const definition = definitionOf<ReleaseCandidate, ReleaseCandidateDefinition>(
    candidate,
    candidateReceiptKeys,
  );
  definition.comparisons = results
    .map(resultReference)
    .sort((left, right) => left.resultId.localeCompare(right.resultId));
  return {
    ...definition,
    createdAt: candidate.createdAt,
    createdByPrincipalId: candidate.createdByPrincipalId,
    definitionSha256: digestReleaseCandidateDefinition(candidate.scope, definition),
    schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
    scope: structuredClone(candidate.scope),
  };
}
function bindPolicy(
  policy: ReleasePolicy,
  comparisons: readonly ComparisonDefinition[],
): ReleasePolicy {
  const definition = definitionOf<ReleasePolicy, ReleasePolicyDefinition>(
    policy,
    policyReceiptKeys,
  );
  let index = 0;
  definition.rules = definition.rules.map((rule) => {
    if (!("comparison" in rule.predicate)) return rule;
    const comparison = comparisons[Math.min(index, comparisons.length - 1)];
    index += 1;
    if (!comparison) throw new Error("Expected comparison fixture");
    return {
      ...rule,
      predicate: {
        ...rule.predicate,
        comparison: {
          comparisonId: comparison.comparisonId,
          comparisonVersionId: comparison.comparisonVersionId,
          definitionSha256: comparison.definitionSha256,
        },
      },
    };
  });
  return {
    ...definition,
    definitionSha256: digestReleasePolicyDefinition(policy.scope, definition),
    publishedAt: policy.publishedAt,
    publishedByPrincipalId: policy.publishedByPrincipalId,
    schemaVersion: RELEASE_POLICY_SCHEMA_VERSION,
    scope: structuredClone(policy.scope),
  };
}
function request(
  candidate: ReleaseCandidate,
  policy: ReleasePolicy,
  options: { evaluationTime?: string; scope?: EvidenceScope } = {},
): PolicyEvaluationRequest {
  const definition: PolicyEvaluationRequestDefinition = {
    algorithm: { id: "proofstack.deterministic-policy", version: "1.0.0" },
    candidate: candidateReference(candidate),
    evaluationRequestId: "request_selection",
    evaluationTime: options.evaluationTime ?? "2026-09-07T12:00:00.123456789012345678901234567890Z",
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
    policy: policyReference(policy),
  };
  const scope = options.scope ?? candidate.scope;
  return {
    ...definition,
    createdAt: "2026-09-07T13:00:00.000Z",
    createdByPrincipalId: "principal_requester",
    definitionSha256: digestPolicyEvaluationRequestDefinition(scope, definition),
    schemaVersion: POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
    scope: structuredClone(scope),
  };
}
function result(
  namespace: string,
  scope: EvidenceScope,
  comparison: ComparisonDefinition,
): ComparisonResult {
  const baseline = comparisonSnapshotFixture(
    `${namespace}_baseline`,
    scope,
    comparison,
    "baseline",
  );
  const candidate = comparisonSnapshotFixture(
    `${namespace}_candidate`,
    scope,
    comparison,
    "candidate",
  );
  return comparisonResultFixture(namespace, scope, comparison, baseline, candidate);
}
function acquired(
  results: readonly ComparisonResult[],
  missing: ReadonlySet<string> = new Set(),
): PolicyEvaluationComparisonAcquisition[] {
  return results
    .map((record) => ({
      reference: resultReference(record),
      result: missing.has(record.resultId) ? null : record,
    }))
    .sort((left, right) => left.reference.resultId.localeCompare(right.reference.resultId));
}
function fixture(resultsForComparison = 1) {
  const scope = comparisonFixtureScope("selection");
  const comparison = comparisonDefinitionFixture("selection", scope);
  const results = Array.from({ length: resultsForComparison }, (_, index) =>
    result(`selection_${index}`, scope, comparison),
  );
  const candidate = bindCandidate(releaseCandidateFixture("selection", scope), results);
  const policy = bindPolicy(releasePolicyRepositoryFixture("selection", scope), [comparison]);
  return { scope, comparison, results, candidate, policy, request: request(candidate, policy) };
}
function expectCode(
  run: () => unknown,
  code: PolicyEvaluationComparisonSelectionError["code"],
): void {
  try {
    run();
    throw new Error("Expected comparison selection rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyEvaluationComparisonSelectionError);
    expect((error as PolicyEvaluationComparisonSelectionError).code).toBe(code);
  }
}

describe("policy evaluation request record validation", () => {
  it("recomputes the request digest and returns its exact reference", () => {
    const value = fixture();
    const parsed = validatePolicyEvaluationRequestRecord(value.request);
    expect(parsed).toEqual(value.request);
    expect(parsed).not.toBe(value.request);
    expect(policyEvaluationRequestReference(parsed)).toEqual({
      evaluationRequestId: value.request.evaluationRequestId,
      definitionSha256: value.request.definitionSha256,
    });
  });
  it.each([
    "definitionSha256",
    "candidate",
    "policy",
    "evaluationTime",
    "limits",
    "scope",
    "schemaVersion",
  ])("rejects request %s corruption", (field) => {
    const { request: value } = fixture();
    const changed: Record<string, unknown> = structuredClone(value);
    if (field === "definitionSha256") changed[field] = "f".repeat(64);
    else if (field === "candidate")
      changed[field] = { ...value.candidate, candidateId: "candidate_other" };
    else if (field === "policy") changed[field] = { ...value.policy, policyId: "policy_other" };
    else if (field === "evaluationTime") changed[field] = "invalid";
    else if (field === "limits") changed[field] = { ...value.limits, maxAttempts: 99 };
    else if (field === "scope") changed[field] = { ...value.scope, projectId: "project_other" };
    else changed[field] = "9.9";
    expect(() => validatePolicyEvaluationRequestRecord(changed)).toThrow();
  });
});

describe("complete candidate comparison selection", () => {
  it("selects one exact result only after every candidate member is verified", () => {
    const value = fixture();
    const inventory = resolvePolicyEvaluationComparisons({
      ...value,
      acquisitions: acquired(value.results),
    });
    expect(inventory.policyComparisons).toHaveLength(1);
    expect(inventory.policyComparisons[0]).toEqual({
      comparison: value.results[0]?.comparison,
      result: resultReference(value.results[0] as ComparisonResult),
      status: "unique",
    });
    expect(inventory.members[0]?.observation.status).toBe("verified");
    if (inventory.members[0]?.observation.status !== "verified")
      throw new Error("Expected verified member");
    expect(inventory.members[0].observation.recordSha256).toBe(
      createHash("sha256").update(encodeEvaluationCanonicalJson(value.results[0])).digest("hex"),
    );
  });

  it("deduplicates the same exact policy comparison across multiple rules", () => {
    const value = fixture();
    expect(
      value.policy.rules.filter(({ predicate }) => "comparison" in predicate).length,
    ).toBeGreaterThan(1);
    expect(
      resolvePolicyEvaluationComparisons({ ...value, acquisitions: acquired(value.results) })
        .policyComparisons,
    ).toHaveLength(1);
  });

  it("orders distinct policy comparison identities independently of rule order", () => {
    const scope = comparisonFixtureScope("selection_order");
    const comparisonZ = comparisonDefinitionFixture("selection_z", scope);
    const comparisonA = comparisonDefinitionFixture("selection_a", scope);
    const resultZ = result("selection_z", scope, comparisonZ);
    const resultA = result("selection_a", scope, comparisonA);
    const candidate = bindCandidate(releaseCandidateFixture("selection_order", scope), [
      resultA,
      resultZ,
    ]);
    const policy = bindPolicy(releasePolicyRepositoryFixture("selection_order", scope), [
      comparisonZ,
      comparisonA,
    ]);

    const output = resolvePolicyEvaluationComparisons({
      acquisitions: acquired([resultA, resultZ]),
      candidate,
      policy,
      request: request(candidate, policy),
    });
    expect(
      output.policyComparisons.map(({ comparison }) => comparison.comparisonVersionId),
    ).toEqual([comparisonA.comparisonVersionId, comparisonZ.comparisonVersionId]);
  });

  it("reports exact missing evidence only after all candidate results are readable", () => {
    const value = fixture();
    const other = comparisonDefinitionFixture("selection_other", value.scope);
    const otherResult = result("selection_other", value.scope, other);
    const candidate = bindCandidate(value.candidate, [otherResult]);
    const evaluationRequest = request(candidate, value.policy);
    const output = resolvePolicyEvaluationComparisons({
      candidate,
      policy: value.policy,
      request: evaluationRequest,
      acquisitions: acquired([otherResult]),
    });
    expect(output.policyComparisons).toEqual([
      { comparison: value.results[0]?.comparison, status: "missing" },
    ]);
  });

  it("reports every matching result as ambiguous even when values and lineage are identical", () => {
    const value = fixture(2);
    const output = resolvePolicyEvaluationComparisons({
      ...value,
      acquisitions: acquired(value.results),
    });
    expect(output.policyComparisons[0]).toEqual({
      comparison: value.results[0]?.comparison,
      matches: value.results
        .map(resultReference)
        .sort((a, b) => a.resultId.localeCompare(b.resultId)),
      status: "ambiguous",
      unresolvedMembers: [],
    });
  });

  it.each(["with_match", "without_match"])("keeps an unreadable member unresolved %s", (mode) => {
    const value = fixture();
    const other = comparisonDefinitionFixture("selection_unknown", value.scope);
    const otherResult = result("selection_unknown", value.scope, other);
    const records =
      mode === "with_match" ? [value.results[0] as ComparisonResult, otherResult] : [otherResult];
    const candidate = bindCandidate(value.candidate, records);
    const evaluationRequest = request(candidate, value.policy);
    const acquisitions = acquired(records, new Set([otherResult.resultId]));
    const output = resolvePolicyEvaluationComparisons({
      candidate,
      policy: value.policy,
      request: evaluationRequest,
      acquisitions,
    });
    expect(output.policyComparisons[0]?.status).toBe("unresolved");
    if (output.policyComparisons[0]?.status !== "unresolved")
      throw new Error("Expected unresolved selection");
    expect(output.policyComparisons[0].knownMatches).toHaveLength(mode === "with_match" ? 1 : 0);
    expect(output.policyComparisons[0].unresolvedMembers).toEqual([resultReference(otherResult)]);
  });

  it("remains ambiguous when two matches exist and another member is unreadable", () => {
    const value = fixture(2);
    const other = comparisonDefinitionFixture("selection_unreadable", value.scope);
    const otherResult = result("selection_unreadable", value.scope, other);
    const records = [...value.results, otherResult];
    const candidate = bindCandidate(value.candidate, records);
    const output = resolvePolicyEvaluationComparisons({
      candidate,
      policy: value.policy,
      request: request(candidate, value.policy),
      acquisitions: acquired(records, new Set([otherResult.resultId])),
    });
    expect(output.policyComparisons[0]?.status).toBe("ambiguous");
    if (output.policyComparisons[0]?.status !== "ambiguous")
      throw new Error("Expected ambiguous selection");
    expect(output.policyComparisons[0].matches).toHaveLength(2);
    expect(output.policyComparisons[0].unresolvedMembers).toEqual([resultReference(otherResult)]);
  });

  it.each(["invalid", "reference", "future"])(
    "retains %s subordinate evidence as unavailable instead of zero or a dropped member",
    (mode) => {
      const value = fixture();
      let record = structuredClone(value.results[0]) as ComparisonResult;
      if (mode === "invalid") record.definitionSha256 = "f".repeat(64);
      if (mode === "reference")
        record = result("selection_reference_other", value.scope, value.comparison);
      if (mode === "future") record.createdAt = "2026-09-07T12:00:00.124Z";
      const output = resolvePolicyEvaluationComparisons({
        ...value,
        acquisitions: [
          { reference: resultReference(value.results[0] as ComparisonResult), result: record },
        ],
      });
      expect(output.members[0]?.observation).toEqual({
        reason:
          mode === "invalid"
            ? "record_invalid"
            : mode === "reference"
              ? "reference_mismatch"
              : "not_yet_available",
        status: "unavailable",
      });
      expect(output.policyComparisons[0]?.status).toBe("unresolved");
    },
  );

  it("rejects cross-scope results even when all referenced bytes and digests are otherwise valid", () => {
    const value = fixture();
    const otherScope = { ...value.scope, environmentId: "env_selection_other" };
    const crossScope = result("selection_cross_scope", otherScope, value.comparison);
    const candidate = bindCandidate(value.candidate, [crossScope]);
    const output = resolvePolicyEvaluationComparisons({
      candidate,
      policy: value.policy,
      request: request(candidate, value.policy),
      acquisitions: acquired([crossScope]),
    });
    expect(output.members[0]?.observation).toEqual({
      reason: "reference_mismatch",
      status: "unavailable",
    });
  });

  it.each(["missing", "extra", "reordered", "reference"])(
    "rejects a %s acquisition inventory before selection",
    (mode) => {
      const value = fixture(2);
      const acquisitions = acquired(value.results);
      if (mode === "missing") acquisitions.pop();
      if (mode === "extra")
        acquisitions.push(acquisitions[0] as PolicyEvaluationComparisonAcquisition);
      if (mode === "reordered") acquisitions.reverse();
      if (mode === "reference")
        acquisitions[0] = {
          ...(acquisitions[0] as PolicyEvaluationComparisonAcquisition),
          reference: {
            ...(acquisitions[0] as PolicyEvaluationComparisonAcquisition).reference,
            definitionSha256: "f".repeat(64),
          },
        };
      expectCode(
        () => resolvePolicyEvaluationComparisons({ ...value, acquisitions }),
        "candidate_inventory_mismatch",
      );
    },
  );

  it.each([
    null,
    [null],
    [{ reference: resultReference(fixture().results[0] as ComparisonResult) }],
  ])("rejects malformed acquisition input %# before canonical comparison", (acquisitions) => {
    const value = fixture();
    expectCode(
      () => resolvePolicyEvaluationComparisons({ ...value, acquisitions } as never),
      "candidate_inventory_mismatch",
    );
  });

  it.each(["request", "candidate", "policy"])("rejects an invalid %s root digest", (root) => {
    const value = fixture();
    const input: Record<string, unknown> = { ...value, acquisitions: acquired(value.results) };
    input[root] = { ...(input[root] as object), definitionSha256: "f".repeat(64) };
    expectCode(
      () => resolvePolicyEvaluationComparisons(input as never),
      `invalid_${root}` as never,
    );
  });

  it.each(["candidate", "policy"])("rejects request-to-%s reference substitution", (root) => {
    const value = fixture();
    const evaluationRequest = structuredClone(value.request);
    if (root === "candidate") evaluationRequest.candidate.candidateId = "candidate_other";
    else evaluationRequest.policy.policyId = "policy_other";
    const definition = definitionOf<PolicyEvaluationRequest, PolicyEvaluationRequestDefinition>(
      evaluationRequest,
      requestReceiptKeys,
    );
    evaluationRequest.definitionSha256 = digestPolicyEvaluationRequestDefinition(
      evaluationRequest.scope,
      definition,
    );
    expectCode(
      () =>
        resolvePolicyEvaluationComparisons({
          ...value,
          request: evaluationRequest,
          acquisitions: acquired(value.results),
        }),
      "root_reference_mismatch",
    );
  });

  it.each(["candidate", "policy"])("rejects cross-scope %s roots", (root) => {
    const value = fixture();
    if (root === "candidate") {
      const candidate = bindCandidate(
        releaseCandidateFixture("selection_scope", {
          ...value.scope,
          environmentId: "env_selection_other",
        }),
        value.results,
      );
      const evaluationRequest = request(candidate, value.policy, { scope: value.scope });
      expectCode(
        () =>
          resolvePolicyEvaluationComparisons({
            candidate,
            policy: value.policy,
            request: evaluationRequest,
            acquisitions: acquired(value.results),
          }),
        "root_scope_mismatch",
      );
    } else {
      const policy = bindPolicy(
        releasePolicyRepositoryFixture("selection_scope", {
          ...value.scope,
          environmentId: "env_selection_other",
        }),
        [value.comparison],
      );
      const evaluationRequest = request(value.candidate, policy, { scope: value.scope });
      expectCode(
        () =>
          resolvePolicyEvaluationComparisons({
            candidate: value.candidate,
            policy,
            request: evaluationRequest,
            acquisitions: acquired(value.results),
          }),
        "root_scope_mismatch",
      );
    }
  });

  it.each(["candidate", "policy"])("rejects a %s root created after evaluationTime", (root) => {
    const value = fixture();
    if (root === "candidate") value.candidate.createdAt = "2026-09-07T12:00:00.124Z";
    else value.policy.publishedAt = "2026-09-07T12:00:00.124Z";
    const evaluationRequest = request(value.candidate, value.policy);
    expectCode(
      () =>
        resolvePolicyEvaluationComparisons({
          ...value,
          request: evaluationRequest,
          acquisitions: acquired(value.results),
        }),
      "root_not_yet_available",
    );
  });

  it("rejects two different comparison references with one repository identity inside the policy", () => {
    const value = fixture();
    const definition = definitionOf<ReleasePolicy, ReleasePolicyDefinition>(
      value.policy,
      policyReceiptKeys,
    );
    let changed = false;
    definition.rules = definition.rules.map((rule) => {
      if (!("comparison" in rule.predicate) || changed) return rule;
      changed = true;
      return {
        ...rule,
        predicate: {
          ...rule.predicate,
          comparison: {
            ...rule.predicate.comparison,
            comparisonId: "comparison_conflict",
            definitionSha256: "f".repeat(64),
          },
        },
      };
    });
    const policy: ReleasePolicy = {
      ...definition,
      definitionSha256: digestReleasePolicyDefinition(value.scope, definition),
      publishedAt: value.policy.publishedAt,
      publishedByPrincipalId: value.policy.publishedByPrincipalId,
      schemaVersion: RELEASE_POLICY_SCHEMA_VERSION,
      scope: value.scope,
    };
    expectCode(
      () =>
        resolvePolicyEvaluationComparisons({
          candidate: value.candidate,
          policy,
          request: request(value.candidate, policy),
          acquisitions: acquired(value.results),
        }),
      "policy_comparison_reference_conflict",
    );
  });

  it("returns defensive output and does not mutate roots, results, or acquisition order", () => {
    const value = fixture(2);
    const acquisitions = acquired(value.results);
    const before = structuredClone({ value, acquisitions });
    const output = resolvePolicyEvaluationComparisons({ ...value, acquisitions });
    const firstMember = output.members[0];
    if (firstMember) firstMember.reference.resultId = "result_mutated";
    expect({ value, acquisitions }).toEqual(before);
  });
});
