import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  serializeEvaluationCanonicalJson,
  policyEvaluationSourceReferenceKey,
  type PolicyEvaluationRequestDefinition,
  type ReleaseCandidateDefinition,
  type PolicyEvaluationSnapshotInputs,
  type PolicyEvaluationSnapshot,
} from "@proofstack/contracts";
import { assemblePolicyEvaluationSnapshot } from "./policy-evaluation-snapshot.js";
import { computeSealedPolicyEvaluation as compute } from "./compute-sealed-policy-evaluation.js";
import { releaseCandidateSourceReferences } from "../release/release-candidate-source-references.js";
import { digestReleaseCandidateDefinition } from "../release/release-candidate-record-validation.js";
import { digestPolicyEvaluationRequestDefinition } from "./policy-evaluation-request-record-validation.js";
import { assemblePolicyEvaluationManifest } from "./policy-evaluation-manifest.js";

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("Missing independent fixture coordinate");
  return value;
}

/** Models trusted sealed qualification reports; does not establish a real-source acquisition. */
function qualifiedModel(inputs: PolicyEvaluationSnapshotInputs, match = false) {
  inputs.policyAuthority.requirements = { status: "valid", findings: [] };
  const candidate = inputs.roots.candidate;
  const {
    scope,
    schemaVersion: _version,
    definitionSha256: _hash,
    createdAt: _at,
    createdByPrincipalId: _by,
    ...definition
  } = candidate;
  const subjects = releaseCandidateSourceReferences(definition).filter(
    (subject) =>
      subject.kind === "source_revision" ||
      subject.kind === "model_declaration" ||
      subject.kind === "runtime_adapter",
  );
  const observation = {
    status: "observed" as const,
    scope,
    evaluationTime: inputs.request.evaluationTime,
    startedAt: inputs.capturedAt,
    completedAt: inputs.capturedAt,
    unavailableParents: [],
    occurrences: subjects.map((subject, edgeIndex) => ({
      subject,
      edgeIndex,
      availability: "available" as const,
      parent: inputs.applicability.candidate.source as Extract<
        typeof inputs.applicability.candidate.source,
        { kind: "release_candidate" }
      >,
      parentRecordSha256: inputs.applicability.candidate.recordSha256,
      path:
        subject.kind === "source_revision"
          ? "/source"
          : `/runtimeComponents/${candidate.runtimeComponents.findIndex((component) => component.kind === "model" && component.role === subject.role)}${subject.kind === "runtime_adapter" ? "/adapter" : ""}`,
    })),
  };
  inputs.candidateAuthority = {
    beforeArtifacts: structuredClone(observation),
    afterArtifacts: structuredClone(observation),
  };
  for (const dimension of inputs.applicability.dimensions) {
    dimension.status = dimension.field === "purpose" ? "mismatch" : "match";
    dimension.reason =
      dimension.field === "purpose"
        ? "not_equal"
        : dimension.field === "locale"
          ? "member"
          : dimension.field === "populationTags"
            ? "contains_all"
            : "equal";
  }
  inputs.applicability.conjunction = "mismatch";
  if (!match) return;
  // A distinct candidate/request/manifest identity is necessary when changing the target.
  const oldDefinition = candidate.definitionSha256;
  const oldBody = inputs.applicability.candidate.recordSha256;
  candidate.target.purpose =
    inputs.roots.policy.applicability.purpose.operator === "equals"
      ? inputs.roots.policy.applicability.purpose.value
      : candidate.target.purpose;
  const nextDefinition = {
    ...definition,
    target: candidate.target,
  } satisfies ReleaseCandidateDefinition;
  candidate.definitionSha256 = digestReleaseCandidateDefinition(scope, nextDefinition);
  const bodyHash = createHash("sha256")
    .update(serializeEvaluationCanonicalJson(candidate))
    .digest("hex");
  const replace = (value: unknown, old: string, next: string): unknown => {
    if (typeof value === "string") return value === old ? next : value;
    if (Array.isArray(value)) return value.map((child) => replace(child, old, next));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, replace(child, old, next)]),
      );
    return value;
  };
  Object.assign(
    inputs,
    replace(replace(inputs, oldDefinition, candidate.definitionSha256), oldBody, bodyHash),
  );
  const {
    scope: requestScope,
    schemaVersion: _rv,
    definitionSha256: oldRequest,
    createdAt: _ra,
    createdByPrincipalId: _rb,
    ...requestDefinition
  } = inputs.request;
  const requestDigest = digestPolicyEvaluationRequestDefinition(
    requestScope,
    requestDefinition satisfies PolicyEvaluationRequestDefinition,
  );
  Object.assign(inputs, replace(inputs, oldRequest, requestDigest));
  inputs.manifest = assemblePolicyEvaluationManifest({
    manifestId: inputs.manifest.manifest.manifestId,
    request: inputs.sources.records.request,
    scope,
    entries: inputs.sources.records.records.map(({ entry }) => entry),
  });
  inputs.applicability.dimensions[4].targetValue = inputs.roots.candidate.target.purpose;
  inputs.applicability.dimensions[4].status = "match";
  inputs.applicability.dimensions[4].reason = "equal";
  inputs.applicability.conjunction = "match";
  if (inputs.schemaVersion === "0.2") {
    // Model a rule-specific closure: unrelated missing assessments remain in the complete
    // witness inventory and their original unavailable checks remain intact.
    const records = inputs.sources.records.records;
    for (const row of [inputs.closure.rootContext, requiredAt(inputs.closure.rules, 1)]) {
      row.sourceIndexes = row.sourceIndexes.filter(
        (index) =>
          !["assessment", "model_assurance_assessment"].includes(
            requiredAt(records, index).entry.source.kind,
          ),
      );
      const own = new Set(
        row.sourceIndexes.map((index) =>
          policyEvaluationSourceReferenceKey(requiredAt(records, index).entry.source),
        ),
      );
      row.checkIndexes = inputs.closure.checks.flatMap((check, index) =>
        check.context === "semantic" &&
        own.has(policyEvaluationSourceReferenceKey(check.parent)) &&
        own.has(policyEvaluationSourceReferenceKey(check.owner))
          ? [index]
          : [],
      );
    }
  }
}

function fixture(version = "v2", configure?: (inputs: PolicyEvaluationSnapshotInputs) => void) {
  const inputs = JSON.parse(
    readFileSync(
      new URL(
        `../../../contracts/vectors/policy-evaluation-snapshot-inputs-${version}.fixture.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as PolicyEvaluationSnapshotInputs;
  configure?.(inputs);
  const pageSet = assemblePolicyEvaluationSnapshot({ snapshotId: "snapshot_compute", inputs });
  const record: PolicyEvaluationSnapshot = {
    ...pageSet.definition,
    scope: pageSet.scope,
    definitionSha256: pageSet.definitionSha256,
    schemaVersion: "0.1",
    sealedAt: inputs.capturedAt,
    recordedAt: inputs.capturedAt,
    jobId: "job_compute",
    attemptId: "attempt_compute",
    workerId: "worker_compute",
    sealedByPrincipalId: "worker_compute",
    leaseId: "lease_compute",
    fencingToken: 1,
    recoveryEpoch: 0,
  };
  return {
    evaluationId: "evaluation_compute",
    record,
    pageSet,
    expected: {
      scope: structuredClone(record.scope),
      jobId: record.jobId,
      request: structuredClone(record.request),
      snapshot: { snapshotId: record.snapshotId, definitionSha256: record.definitionSha256 },
    },
  };
}

describe("historical computation from authoritative job-bound sealed inputs", () => {
  it("preserves the complete rule inventory while invalid sealed policy prerequisites remain unresolved", () => {
    const value = fixture(),
      before = structuredClone(value);
    const result = compute(value);
    expect(value).toEqual(before);
    expect(result.snapshot).toEqual(value.expected.snapshot);
    expect(result.request).toEqual(value.expected.request);
    expect(result.ruleCount).toBe(7);
    expect(result.rules.map((rule) => rule.ruleIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.rules[0]).toMatchObject({
      outcome: "indeterminate",
      evidence: { reason: "approval_not_evaluated" },
    });
    expect(
      result.rules
        .slice(1)
        .every(
          (rule) =>
            rule.outcome === "indeterminate" &&
            rule.evidence.kind === "not_evaluated" &&
            rule.evidence.reason === "policy_authority_unverified",
        ),
    ).toBe(true);
    expect(result.outcomeCounts).toEqual({
      satisfied: 0,
      violated: 0,
      indeterminate: 7,
      not_applicable: 0,
    });
    expect(compute(value)).toEqual(result);
  });
  it("does not promote a legacy input without complete closure into the current algorithm", () => {
    expect(() => compute(fixture("v1"))).toThrow();
  });
  it("does not treat a synthetic valid policy report as candidate authority", () => {
    const value = fixture("v2", (inputs) => {
      // Unit model of a trusted sealed report, not an independently accepted source authority.
      inputs.policyAuthority.requirements = { status: "valid", findings: [] };
    });
    const result = compute(value);
    expect(result.rules[0]).toMatchObject({ evidence: { reason: "approval_not_evaluated" } });
    expect(
      result.rules
        .slice(1)
        .every(
          (rule) =>
            rule.evidence.kind === "not_evaluated" &&
            rule.evidence.reason === "candidate_authority_unverified",
        ),
    ).toBe(true);
  });
  it("retains a real selector mismatch with qualified modeled authority and never invents approval", () => {
    const result = compute(fixture("v2", (inputs) => qualifiedModel(inputs)));
    expect(result.outcomeCounts).toEqual({
      satisfied: 0,
      violated: 0,
      indeterminate: 1,
      not_applicable: 6,
    });
    expect(
      result.rules.slice(1).every((rule) => rule.evidence.kind === "applicability_mismatch"),
    ).toBe(true);
    expect(
      result.rules.every((rule) => rule.limitations.includes("declared_reference_authority_only")),
    ).toBe(true);
  });
  it("computes the known artifact type violation from a distinct matching modeled sealed candidate", () => {
    const result = compute(fixture("v2", (inputs) => qualifiedModel(inputs, true)));
    expect(result.rules[1]).toMatchObject({
      outcome: "violated",
      evidence: { kind: "artifact", status: "media_type_disallowed" },
    });
    expect(result.rules[0]).toMatchObject({
      outcome: "indeterminate",
      evidence: { reason: "approval_not_evaluated" },
    });
  });
  it("rejects forged applicability success even when all pages and digests are recomputed", () => {
    const value = fixture("v2", (inputs) => {
      qualifiedModel(inputs);
      inputs.applicability.dimensions[4].status = "match";
      inputs.applicability.dimensions[4].reason = "equal";
      inputs.applicability.conjunction = "match";
    });
    expect(() => compute(value)).toThrow();
  });
  it.each(["mismatch", "unavailable"] as const)(
    "keeps a required semantic %s from becoming an artifact verdict",
    (status) => {
      const value = fixture("v2", (inputs) => {
        qualifiedModel(inputs, true);
        if (inputs.schemaVersion !== "0.2") throw new Error("Missing complete closure");
        const check = requiredAt(inputs.closure.checks, 0);
        check.status = status;
        check.reasons = ["fixture_unavailable"];
      });
      expect(compute(value).rules[1]).toMatchObject({
        outcome: "indeterminate",
        evidence: {
          reason: status === "mismatch" ? "evidence_unqualified" : "source_unavailable",
        },
      });
    },
  );
  it.each(["policy_expired_at_evaluation", "policy_not_effective_at_evaluation"] as const)(
    "retains the sealed %s authority reason",
    (reason) => {
      const value = fixture("v2", (inputs) => {
        inputs.policyAuthority.requirements = { status: "invalid", findings: [{ reason }] };
      });
      expect(compute(value).rules[1]).toMatchObject({
        evidence: {
          reason:
            reason === "policy_expired_at_evaluation" ? "policy_expired" : "policy_not_effective",
        },
      });
    },
  );
  it("rejects a changed candidate authority report instead of mixing the two observations", () => {
    const value = fixture("v2", (inputs) => {
      qualifiedModel(inputs);
      const after = inputs.candidateAuthority.afterArtifacts;
      if (after.status !== "observed") throw new Error("Missing candidate observation");
      requiredAt(after.occurrences, 0).availability = "not_verified";
    });
    expect(() => compute(value)).toThrow();
  });
  it("recomputes lifecycle material instead of trusting three matching forged observation digests", () => {
    const value = fixture("v2", (inputs) => {
      for (const lifecycle of [
        inputs.applicability.lifecycle,
        ...Object.values(inputs.policyLifecycle),
      ])
        lifecycle.observationSha256 = "0".repeat(64);
    });
    expect(() => compute(value)).toThrow();
  });
  it.each(["applicability_candidate", "applicability_policy", "policy_authority"] as const)(
    "rejects substituted full root hashes in %s",
    (target) => {
      const value = fixture("v2", (inputs) => {
        if (target === "applicability_candidate")
          inputs.applicability.candidate.recordSha256 = "0".repeat(64);
        if (target === "applicability_policy") {
          inputs.applicability.policy.recordSha256 = "0".repeat(64);
          inputs.applicability.lifecycle.policyRecordSha256 = "0".repeat(64);
        }
        if (target === "policy_authority") inputs.policyAuthority.recordSha256 = "0".repeat(64);
      });
      expect(() => compute(value)).toThrow();
    },
  );
  it.each([
    "candidate_observation",
    "applicability_candidate",
    "policy_authority",
    "candidate_witness",
    "policy_witness",
  ] as const)(
    "rejects an exact parent reference digest substitution in %s despite unchanged logical ID/body hash",
    (target) => {
      const value = fixture("v2", (inputs) => {
        qualifiedModel(inputs, true);
        if (target === "candidate_observation") {
          for (const observation of Object.values(inputs.candidateAuthority))
            if (observation.status === "observed") {
              const parent = requiredAt(observation.occurrences, 0).parent;
              if (parent.kind !== "release_candidate") throw new Error("Missing candidate parent");
              parent.reference.definitionSha256 = "0".repeat(64);
            }
        } else if (target === "candidate_witness" || target === "policy_witness") {
          const kind = target === "candidate_witness" ? "release_candidate" : "release_policy";
          const witness = inputs.sources.records.records.find(
            (record) => record.entry.source.kind === kind,
          );
          if (
            !witness ||
            (witness.entry.source.kind !== "release_candidate" &&
              witness.entry.source.kind !== "release_policy")
          )
            throw new Error("Missing original root witness");
          // Recompute a coherent forged source inventory, retaining the authoritative
          // request and original root body. An ID-only lookup must not accept it.
          const originalDigest = witness.entry.source.reference.definitionSha256;
          inputs.sources = JSON.parse(
            JSON.stringify(inputs.sources).replaceAll(originalDigest, "0".repeat(64)),
          );
          inputs.manifest = assemblePolicyEvaluationManifest({
            manifestId: inputs.manifest.manifest.manifestId,
            request: inputs.sources.records.request,
            scope: inputs.request.scope,
            entries: inputs.sources.records.records.map(({ entry }) => entry),
          });
        } else {
          const source =
            target === "applicability_candidate"
              ? inputs.applicability.candidate.source
              : inputs.policyAuthority.source;
          if (source.kind !== "release_candidate" && source.kind !== "release_policy")
            throw new Error("Missing original root source");
          source.reference.definitionSha256 = "0".repeat(64);
        }
      });
      expect(() => compute(value)).toThrow();
    },
  );
  it.each(["omitted", "subject", "path", "hash", "availability"] as const)(
    "does not qualify %s candidate reference observations",
    (change) => {
      const value = fixture("v2", (inputs) => {
        qualifiedModel(inputs);
        for (const observation of Object.values(inputs.candidateAuthority))
          if (observation.status === "observed") {
            const occurrence = requiredAt(observation.occurrences, 0);
            if (change === "omitted") observation.occurrences.pop();
            if (change === "subject" && occurrence.subject.kind === "source_revision")
              occurrence.subject.source.commit.value = "a".repeat(40);
            if (change === "path") occurrence.path = "/target";
            if (change === "hash") occurrence.parentRecordSha256 = "0".repeat(64);
            if (change === "availability") occurrence.availability = "not_verified";
          }
      });
      expect(compute(value).rules[1]).toMatchObject({
        outcome: "indeterminate",
        evidence: { reason: "candidate_authority_unverified" },
      });
    },
  );
  it.each(["job", "scope", "request", "snapshot"] as const)(
    "rejects another owning %s identity",
    (kind) => {
      const value = fixture();
      if (kind === "job") value.expected.jobId = "job_other";
      if (kind === "scope") value.expected.scope.environmentId = "environment_other";
      if (kind === "request") value.expected.request.evaluationRequestId = "request_other";
      if (kind === "snapshot") value.expected.snapshot.definitionSha256 = "0".repeat(64);
      expect(() => compute(value)).toThrow();
    },
  );
  it("rejects missing complete input pages before producing any rule result", () => {
    const value = fixture();
    value.pageSet.pages.pop();
    expect(() => compute(value)).toThrow();
  });
  it("rejects a substituted snapshot worker identity even with unchanged input pages", () => {
    const value = fixture();
    value.record.sealedByPrincipalId = "worker_other";
    expect(() => compute(value)).toThrow();
  });
});
