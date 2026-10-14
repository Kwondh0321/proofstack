import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  PolicyEvaluationSnapshotInputs,
  PolicyEvaluationSnapshot,
} from "@proofstack/contracts";
import { assemblePolicyEvaluationSnapshot } from "./policy-evaluation-snapshot.js";
import { validatePolicyEvaluationSnapshotRecord } from "./policy-evaluation-snapshot-record-validation.js";

const inputs = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/vectors/policy-evaluation-snapshot-inputs-v1.fixture.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as PolicyEvaluationSnapshotInputs;
function fixture() {
  const pageSet = assemblePolicyEvaluationSnapshot({ snapshotId: "snapshot_record", inputs });
  const record: PolicyEvaluationSnapshot = {
    ...pageSet.definition,
    scope: pageSet.scope,
    definitionSha256: pageSet.definitionSha256,
    schemaVersion: "0.1",
    sealedAt: inputs.capturedAt,
    recordedAt: inputs.capturedAt,
    jobId: "job_sealed",
    attemptId: "attempt_sealed",
    workerId: "worker_sealed",
    sealedByPrincipalId: "worker_sealed",
    leaseId: "lease_sealed",
    fencingToken: 1,
    recoveryEpoch: 0,
  };
  return {
    record,
    pageSet,
    expected: {
      scope: record.scope,
      snapshot: { snapshotId: record.snapshotId, definitionSha256: record.definitionSha256 },
      request: record.request,
      jobId: record.jobId,
    },
  };
}
describe("owning historical snapshot record integrity", () => {
  it("joins independently expected job/request/scope with complete canonical pages", () => {
    const f = fixture();
    const result = validatePolicyEvaluationSnapshotRecord(f);
    expect(result.record).toEqual(f.record);
    expect(result.inputs).toEqual(inputs);
    result.record.workerId = "worker_changed";
    expect(f.record.workerId).toBe("worker_sealed");
  });
  it.each([
    "scope",
    "job",
    "request",
    "id",
    "digest",
    "worker",
    "definition",
    "page",
    "receipt",
    "extra",
  ])("rejects substituted %s without changing the stored material", (kind) => {
    const f = fixture();
    if (kind === "scope") f.record.scope = { ...f.record.scope, tenantId: "tenant_other" };
    if (kind === "job") f.record.jobId = "job_other";
    if (kind === "request")
      f.record.request = { ...f.record.request, evaluationRequestId: "request_other" };
    if (kind === "id") f.record.snapshotId = "snapshot_other";
    if (kind === "digest") f.record.definitionSha256 = "0".repeat(64);
    if (kind === "worker") f.record.sealedByPrincipalId = "worker_other";
    if (kind === "definition") f.record.inputSha256 = "0".repeat(64);
    if (kind === "page") f.pageSet.pages.pop();
    if (kind === "receipt") f.record.recordedAt = "2020-01-01T00:00:00.000Z";
    if (kind === "extra") Object.assign(f.record, { publicationCredential: "forbidden" });
    const original = structuredClone(f);
    expect(() => validatePolicyEvaluationSnapshotRecord(f)).toThrow();
    expect(f).toEqual(original);
  });
});
