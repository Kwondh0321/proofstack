import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  EnqueuePolicyEvaluationRequestSchema,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  MAX_POLICY_EVALUATION_ARTIFACT_READ_BYTES,
  MAX_POLICY_EVALUATION_ATTEMPT_MILLISECONDS,
  MAX_POLICY_EVALUATION_ATTEMPTS,
  MAX_POLICY_EVALUATION_BACKOFF_MILLISECONDS,
  MAX_POLICY_EVALUATION_DEADLINE_MILLISECONDS,
  MAX_POLICY_EVALUATION_HEARTBEAT_MILLISECONDS,
  MAX_POLICY_EVALUATION_LEASE_MILLISECONDS,
  MAX_POLICY_EVALUATION_RULE_EVALUATIONS,
  POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
  PolicyEvaluationExecutionLimitsSchema,
  type PolicyEvaluationRequestDefinition,
  PolicyEvaluationRequestDefinitionSchema,
  PolicyEvaluationRequestReferenceSchema,
  PolicyEvaluationRequestSchema,
  PolicyEvaluationRetryableErrorSchema,
} from "./policy-evaluation-request.js";

const vector = JSON.parse(
  readFileSync(
    new URL("../vectors/policy-evaluation-request-definition-v1.json", import.meta.url),
    "utf8",
  ),
).vectors[0] as {
  readonly input: {
    readonly definition: PolicyEvaluationRequestDefinition;
    readonly scope: {
      readonly tenantId: string;
      readonly projectId: string;
      readonly environmentId: string;
    };
  };
  readonly sha256: string;
};

function definition() {
  return structuredClone(vector.input.definition);
}
function record() {
  return {
    ...definition(),
    createdAt: "2026-09-07T12:00:00.000Z",
    createdByPrincipalId: "principal_evaluation_control",
    definitionSha256: vector.sha256,
    schemaVersion: POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
    scope: vector.input.scope,
  };
}

const numericBounds = [
  ["heartbeatIntervalMilliseconds", 100, MAX_POLICY_EVALUATION_HEARTBEAT_MILLISECONDS],
  ["leaseDurationMilliseconds", 1_000, MAX_POLICY_EVALUATION_LEASE_MILLISECONDS],
  ["maxAcquisitionRecordBytes", 1, MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES],
  ["maxAcquisitionRecords", 2, MAX_POLICY_EVALUATION_ACQUISITION_RECORDS],
  ["maxArtifactReadBytes", 0, MAX_POLICY_EVALUATION_ARTIFACT_READ_BYTES],
  ["maxAttempts", 1, MAX_POLICY_EVALUATION_ATTEMPTS],
  ["maxRuleEvaluations", 1, MAX_POLICY_EVALUATION_RULE_EVALUATIONS],
  ["perAttemptTimeoutMilliseconds", 1_000, MAX_POLICY_EVALUATION_ATTEMPT_MILLISECONDS],
  ["retryBackoffMilliseconds", 0, MAX_POLICY_EVALUATION_BACKOFF_MILLISECONDS],
  ["totalDeadlineMilliseconds", 1_000, MAX_POLICY_EVALUATION_DEADLINE_MILLISECONDS],
] as const;

const invalidBounds = numericBounds.flatMap(([field, minimum, maximum]) =>
  [
    minimum - 1,
    maximum + 1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "1000",
    null,
    undefined,
    true,
    1n,
  ].map((value, index) => ({ field, index, value })),
);

describe("immutable policy evaluation request contracts", () => {
  it("separates caller definition, exact reference, and server-owned receipt", () => {
    expect(PolicyEvaluationRequestDefinitionSchema.parse(definition())).toEqual(definition());
    expect(EnqueuePolicyEvaluationRequestSchema.parse(definition())).toEqual(definition());
    expect(PolicyEvaluationRequestSchema.parse(record())).toEqual(record());
    const reference = {
      definitionSha256: vector.sha256,
      evaluationRequestId: definition().evaluationRequestId,
    };
    expect(PolicyEvaluationRequestReferenceSchema.parse(reference)).toEqual(reference);
    expect(PolicyEvaluationRequestDefinitionSchema.safeParse(record()).success).toBe(false);
    expect(PolicyEvaluationRequestSchema.safeParse(definition()).success).toBe(false);
  });

  it("admits explicit minimum and maximum limits without inventing defaults", () => {
    const minimum = {
      ...Object.fromEntries(numericBounds.map(([field, lower]) => [field, lower])),
      retryableErrors: [],
    };
    const maximum = {
      ...Object.fromEntries(numericBounds.map(([field, , upper]) => [field, upper])),
      retryableErrors: PolicyEvaluationRetryableErrorSchema.options,
    };
    expect(PolicyEvaluationExecutionLimitsSchema.parse(minimum)).toEqual(minimum);
    expect(PolicyEvaluationExecutionLimitsSchema.parse(maximum)).toEqual(maximum);
    for (const field of Object.keys(definition().limits)) {
      const value = { ...definition().limits } as Record<string, unknown>;
      delete value[field];
      expect(PolicyEvaluationExecutionLimitsSchema.safeParse(value).success).toBe(false);
    }
  });

  it.each(invalidBounds)(
    "rejects $field invalid value $index at its own boundary",
    ({ field, value }) => {
      const parsed = PolicyEvaluationExecutionLimitsSchema.safeParse({
        ...definition().limits,
        [field]: value,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
    },
  );

  it.each([
    { heartbeatIntervalMilliseconds: 10_000, leaseDurationMilliseconds: 29_999 },
    { leaseDurationMilliseconds: 60_000, perAttemptTimeoutMilliseconds: 59_999 },
    { perAttemptTimeoutMilliseconds: 600_001 },
    { maxRuleEvaluations: 385 },
    { maxAttempts: 1, maxRuleEvaluations: 128 },
    { retryableErrors: [] },
    {
      retryBackoffMilliseconds: 60_000,
      totalDeadlineMilliseconds: 60_000,
      perAttemptTimeoutMilliseconds: 60_000,
    },
    { retryableErrors: ["worker_interrupted", "lease_expired"] },
    { retryableErrors: ["lease_expired", "lease_expired"] },
    { retryableErrors: ["policy_violated"] },
    { retryableErrors: ["approval_missing"] },
  ])("rejects incompatible scheduling or outcome retries: %j", (change) => {
    expect(
      PolicyEvaluationExecutionLimitsSchema.safeParse({ ...definition().limits, ...change })
        .success,
    ).toBe(false);
  });

  it("validates single-attempt backoff and exact heartbeat equality", () => {
    const single = {
      ...definition().limits,
      maxAttempts: 1,
      maxRuleEvaluations: 128,
      retryableErrors: [],
      retryBackoffMilliseconds: 0,
    };
    expect(PolicyEvaluationExecutionLimitsSchema.parse(single)).toEqual(single);
    expect(
      PolicyEvaluationExecutionLimitsSchema.safeParse({ ...single, retryBackoffMilliseconds: 1 })
        .success,
    ).toBe(false);
    expect(
      PolicyEvaluationExecutionLimitsSchema.safeParse({
        ...single,
        heartbeatIntervalMilliseconds: 10_000,
      }).success,
    ).toBe(true);
  });

  it.each([
    "scope",
    "definitionSha256",
    "schemaVersion",
    "createdAt",
    "createdByPrincipalId",
    "snapshot",
    "result",
    "operand",
    "verdict",
    "approval",
    "workerId",
    "lease",
    "credential",
    "sourceUrl",
    "jobId",
  ])("rejects caller-authored %s instead of stripping it", (field) => {
    expect(
      EnqueuePolicyEvaluationRequestSchema.safeParse({ ...definition(), [field]: "forged" })
        .success,
    ).toBe(false);
  });

  it.each(["algorithm", "candidate", "policy", "limits"] as const)(
    "rejects nested authority fields in %s",
    (field) => {
      const value = definition();
      Object.assign(value[field], { workerId: "worker_forged" });
      expect(PolicyEvaluationRequestDefinitionSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each(["algorithm", "candidate", "evaluationRequestId", "evaluationTime", "limits", "policy"])(
    "requires explicit %s",
    (field) => {
      const value = definition() as unknown as Record<string, unknown>;
      delete value[field];
      expect(PolicyEvaluationRequestDefinitionSchema.safeParse(value).success).toBe(false);
    },
  );

  it("rejects unknown algorithms, mutable versions, and malformed references", () => {
    for (const change of [
      { algorithm: { id: "custom.javascript", version: "1.0.0" } },
      { algorithm: { id: "proofstack.deterministic-policy", version: "latest" } },
      { algorithm: { id: "proofstack.deterministic-policy", version: "2.0.0" } },
      { candidate: { ...definition().candidate, definitionSha256: "bad" } },
      { policy: { ...definition().policy, policyVersionId: "https://mutable.example/latest" } },
      { evaluationTime: "2026-09-07T21:00:00+09:00" },
    ])
      expect(
        PolicyEvaluationRequestDefinitionSchema.safeParse({ ...definition(), ...change }).success,
      ).toBe(false);
  });

  it("keeps semantic evaluation time distinct from receipts; capture must check future input", () => {
    const futureAtEnqueue = {
      ...record(),
      evaluationTime: "2026-09-07T12:00:01.000000000000000000000000000001Z",
    };
    expect(PolicyEvaluationRequestSchema.parse(futureAtEnqueue)).toEqual(futureAtEnqueue);
    expect(
      PolicyEvaluationRequestSchema.safeParse({
        ...record(),
        createdAt: "2026-09-07T12:00:00.0001Z",
      }).success,
    ).toBe(false);
  });

  it("requires room for the declared deadline at the end of the supported server time range", () => {
    const value = record();
    value.createdAt = "9999-12-31T23:49:59.999Z";
    expect(PolicyEvaluationRequestSchema.safeParse(value).success).toBe(true);
    value.createdAt = "9999-12-31T23:50:00.000Z";
    expect(PolicyEvaluationRequestSchema.safeParse(value).success).toBe(false);
  });

  it("does not perform deadline arithmetic on malformed child fields", () => {
    const invalid = { ...record(), createdAt: "bad" };
    const arithmetic = vi.spyOn(globalThis, "BigInt");
    try {
      expect(PolicyEvaluationRequestSchema.safeParse(invalid).success).toBe(false);
      expect(arithmetic).not.toHaveBeenCalled();
    } finally {
      arithmetic.mockRestore();
    }
  });
});
