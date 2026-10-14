import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  PolicyEvaluationDefinition,
  PolicyEvaluationSnapshotInputs,
  PolicyEvaluationSnapshot,
} from "@proofstack/contracts";
import { assemblePolicyEvaluationSnapshot } from "./policy-evaluation-snapshot.js";
import { computeSealedPolicyEvaluation } from "./compute-sealed-policy-evaluation.js";
import {
  digestPolicyEvaluationDefinition,
  validatePolicyEvaluationResultRecord as validate,
} from "./policy-evaluation-result-record-validation.js";

/** Historical owning-receipt unit model, not native result publication or live worker authority. */
function fixture() {
  const inputs = JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/vectors/policy-evaluation-snapshot-inputs-v2.fixture.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as PolicyEvaluationSnapshotInputs;
  const pageSet = assemblePolicyEvaluationSnapshot({
    snapshotId: "snapshot_result_record",
    inputs,
  });
  const fence = {
    jobId: "job_result_record",
    attemptId: "attempt_result_record",
    workerId: "worker_result_record",
    leaseId: "lease_result_record",
    fencingToken: 1,
    recoveryEpoch: 0,
  };
  const snapshotRecord: PolicyEvaluationSnapshot = {
    ...pageSet.definition,
    scope: pageSet.scope,
    schemaVersion: "0.1",
    definitionSha256: pageSet.definitionSha256,
    ...fence,
    sealedAt: inputs.capturedAt,
    recordedAt: inputs.capturedAt,
    sealedByPrincipalId: fence.workerId,
  };
  const expected = {
    scope: structuredClone(pageSet.scope),
    jobId: fence.jobId,
    request: structuredClone(pageSet.definition.request),
    snapshot: {
      snapshotId: pageSet.definition.snapshotId,
      definitionSha256: pageSet.definitionSha256,
    },
    fence,
    completedAt: inputs.capturedAt,
    result: { evaluationId: "result_record", definitionSha256: "0".repeat(64) },
  };
  const definition = computeSealedPolicyEvaluation({
    evaluationId: expected.result.evaluationId,
    expected,
    record: snapshotRecord,
    pageSet,
  });
  expected.result.definitionSha256 = digestPolicyEvaluationDefinition(pageSet.scope, definition);
  const record = {
    ...definition,
    ...fence,
    scope: structuredClone(pageSet.scope),
    schemaVersion: "0.1" as const,
    definitionSha256: expected.result.definitionSha256,
    recordedAt: expected.completedAt,
    recordedByPrincipalId: fence.workerId,
  };
  return { expected, record, snapshotRecord, pageSet, definition };
}
describe("owning immutable policy result and deterministic evidence validation", () => {
  it("recomputes all retained rule evidence and preserves the original historical receipt", () => {
    const value = fixture();
    const before = structuredClone(value);
    const record = validate(value);
    expect(record).toEqual(value.record);
    expect(record.ruleCount).toBe(7);
    expect(value).toEqual(before);
  });
  it("rejects rehashed forged rule evidence even if the owning result reference is replaced consistently", () => {
    const value = fixture();
    const rule = value.record.rules[1];
    if (rule?.evidence.kind !== "not_evaluated")
      throw new Error("Missing unavailable original prerequisite");
    rule.evidence.reason = "source_unavailable";
    const definition = {
      ...value.definition,
      rules: value.record.rules,
    } satisfies PolicyEvaluationDefinition;
    value.record.definitionSha256 = digestPolicyEvaluationDefinition(
      value.expected.scope,
      definition,
    );
    value.expected.result.definitionSha256 = value.record.definitionSha256;
    expect(() => validate(value)).toThrow("Invalid owning policy result");
  });
  it.each([
    "jobId",
    "attemptId",
    "workerId",
    "leaseId",
    "fencingToken",
    "recoveryEpoch",
    "recordedByPrincipalId",
    "recordedAt",
  ] as const)("rejects substituted receipt %s without accepting a valid semantic digest", (key) => {
    const value = fixture();
    if (key === "fencingToken" || key === "recoveryEpoch") value.record[key]++;
    else if (key === "recordedAt") value.record[key] = "2026-10-02T00:00:00Z";
    else value.record[key] = "foreign_result_receipt";
    expect(() => validate(value)).toThrow();
  });
  it.each(["scope", "job", "result", "snapshot", "request"] as const)(
    "rejects another owning %s identity",
    (kind) => {
      const value = fixture();
      if (kind === "scope") value.expected.scope.environmentId = "env_other";
      if (kind === "job") value.expected.jobId = "job_other";
      if (kind === "result") value.expected.result.evaluationId = "result_other";
      if (kind === "snapshot") value.expected.snapshot.definitionSha256 = "0".repeat(64);
      if (kind === "request") value.expected.request.evaluationRequestId = "request_other";
      expect(() => validate(value)).toThrow();
    },
  );
  it("rejects a result receipt before the actual seal even if the purported terminal receipt agrees", () => {
    const value = fixture();
    value.record.recordedAt = value.record.evaluationTime;
    value.expected.completedAt = value.record.evaluationTime;
    expect(() => validate(value)).toThrow();
  });
  it("rejects canonical digest substitution and missing complete original snapshot pages", () => {
    const value = fixture();
    expect(() =>
      validate({ ...value, record: { ...value.record, definitionSha256: "0".repeat(64) } }),
    ).toThrow();
    value.pageSet.pages.pop();
    expect(() => validate(value)).toThrow();
  });
});
