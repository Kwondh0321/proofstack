import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EvidenceScope, PolicyEvaluationJobSnapshot } from "@proofstack/contracts";
import {
  digestPolicyEvaluationJobDefinition,
  InvalidPolicyEvaluationJobGraphError,
  validatePolicyEvaluationJobSnapshotRecord,
} from "./policy-evaluation-job-record-validation.js";
const vector = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/policy-evaluation-job-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  definition: { jobId: string; request: { evaluationRequestId: string; definitionSha256: string } };
  scope: EvidenceScope;
  sha256: string;
  snapshot: PolicyEvaluationJobSnapshot;
};
const expected = {
  scope: vector.scope,
  job: { jobId: vector.definition.jobId, definitionSha256: vector.sha256 },
};
describe("exact policy job record integrity", () => {
  it("matches independent canonical digest and retains native receipts", () => {
    expect(digestPolicyEvaluationJobDefinition(vector.scope, vector.definition)).toBe(
      vector.sha256,
    );
    expect(
      validatePolicyEvaluationJobSnapshotRecord({ expected, snapshot: vector.snapshot }),
    ).toEqual(vector.snapshot);
  });
  it.each([
    "job",
    "job_digest",
    "request_digest",
    "source_semantics",
    "request_scope",
    "deadline",
    "invalid",
  ])("rejects changed %s", (kind) => {
    const snapshot = structuredClone(vector.snapshot);
    if (kind === "job") snapshot.job.jobId = "job_other";
    else if (kind === "job_digest") snapshot.job.definitionSha256 = "f".repeat(64);
    else if (kind === "request_digest") snapshot.request.definitionSha256 = "e".repeat(64);
    else if (kind === "source_semantics")
      snapshot.request.evaluationTime = "2026-09-07T11:59:58.000Z";
    else if (kind === "request_scope") snapshot.request.scope.tenantId = "tenant_other";
    else if (kind === "deadline") snapshot.job.deadlineAt = "2026-09-07T12:11:00.000Z";
    else snapshot.job.stateVersion = 0;
    expect(() => validatePolicyEvaluationJobSnapshotRecord({ expected, snapshot })).toThrow(
      InvalidPolicyEvaluationJobGraphError,
    );
  });
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects independently expected outside %s",
    (field) => {
      expect(() =>
        validatePolicyEvaluationJobSnapshotRecord({
          expected: { ...expected, scope: { ...expected.scope, [field]: "outside_scope" } },
          snapshot: vector.snapshot,
        }),
      ).toThrow(InvalidPolicyEvaluationJobGraphError);
    },
  );
  it("rejects caller-selected expected job identity or digest", () => {
    expect(() =>
      validatePolicyEvaluationJobSnapshotRecord({
        expected: { ...expected, job: { ...expected.job, jobId: "job_other" } },
        snapshot: vector.snapshot,
      }),
    ).toThrow(InvalidPolicyEvaluationJobGraphError);
    expect(() =>
      validatePolicyEvaluationJobSnapshotRecord({
        expected: { ...expected, job: { ...expected.job, definitionSha256: "f".repeat(64) } },
        snapshot: vector.snapshot,
      }),
    ).toThrow(InvalidPolicyEvaluationJobGraphError);
  });
});
