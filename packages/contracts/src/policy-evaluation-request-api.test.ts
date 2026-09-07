import { describe, expect, it } from "vitest";
import {
  MAX_POLICY_EVALUATION_REQUEST_BYTES,
  MAX_POLICY_EVALUATION_REQUEST_RESPONSE_BYTES,
  ReadPolicyEvaluationRequestResponseSchema,
} from "./policy-evaluation-request-api.js";
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
  PolicyEvaluationRetryableErrorSchema,
} from "./policy-evaluation-request.js";

function maximumDefinition() {
  const id = "a".repeat(64);
  return EnqueuePolicyEvaluationRequestSchema.parse({
    algorithm: { id: "proofstack.deterministic-policy", version: "1.0.0" },
    candidate: { candidateId: id, candidateVersionId: id, definitionSha256: "f".repeat(64) },
    evaluationRequestId: id,
    evaluationTime: "2026-09-07T11:59:59.999999999999999999999999999999Z",
    limits: {
      heartbeatIntervalMilliseconds: MAX_POLICY_EVALUATION_HEARTBEAT_MILLISECONDS,
      leaseDurationMilliseconds: MAX_POLICY_EVALUATION_LEASE_MILLISECONDS,
      maxAcquisitionRecordBytes: MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
      maxAcquisitionRecords: MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
      maxArtifactReadBytes: MAX_POLICY_EVALUATION_ARTIFACT_READ_BYTES,
      maxAttempts: MAX_POLICY_EVALUATION_ATTEMPTS,
      maxRuleEvaluations: MAX_POLICY_EVALUATION_RULE_EVALUATIONS,
      perAttemptTimeoutMilliseconds: MAX_POLICY_EVALUATION_ATTEMPT_MILLISECONDS,
      retryBackoffMilliseconds: MAX_POLICY_EVALUATION_BACKOFF_MILLISECONDS,
      retryableErrors: PolicyEvaluationRetryableErrorSchema.options,
      totalDeadlineMilliseconds: MAX_POLICY_EVALUATION_DEADLINE_MILLISECONDS,
    },
    policy: { policyId: id, policyVersionId: id, definitionSha256: "e".repeat(64) },
  });
}

function response(requestId: string) {
  const id = "a".repeat(64);
  return {
    request: {
      ...maximumDefinition(),
      createdAt: "2026-09-07T12:00:00.000Z",
      createdByPrincipalId: id,
      definitionSha256: "d".repeat(64),
      schemaVersion: "0.1",
      scope: { environmentId: id, projectId: id, tenantId: id },
    },
    requestId,
  };
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("policy evaluation request transport contracts", () => {
  it.each([
    "x".repeat(128),
    "한".repeat(128),
    "😀".repeat(64),
    "\u0000".repeat(128),
    "\ud800".repeat(128),
    '"'.repeat(128),
    "\\".repeat(128),
  ])("bounds the largest semantic request plus complete escaped receipt %#", (requestId) => {
    const definition = maximumDefinition();
    const result = ReadPolicyEvaluationRequestResponseSchema.parse(response(requestId));
    expect(bytes(definition)).toBeLessThanOrEqual(MAX_POLICY_EVALUATION_REQUEST_BYTES);
    expect(bytes(result) - bytes(definition)).toBeLessThanOrEqual(
      MAX_POLICY_EVALUATION_REQUEST_RESPONSE_BYTES - MAX_POLICY_EVALUATION_REQUEST_BYTES,
    );
    expect(bytes(result)).toBeLessThanOrEqual(MAX_POLICY_EVALUATION_REQUEST_RESPONSE_BYTES);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("reserves response space when input integer exponents expand after parsing", () => {
    const definition = maximumDefinition();
    const incoming = JSON.stringify(definition)
      .replace(/:100000(?=[,}])/g, ":1e5")
      .replace(/:60000(?=[,}])/g, ":6e4")
      .replace(/:10000(?=[,}])/g, ":1e4")
      .replace(/:900000(?=[,}])/g, ":9e5")
      .replace(/:3600000(?=[,}])/g, ":36e5");
    const parsed = EnqueuePolicyEvaluationRequestSchema.parse(JSON.parse(incoming));
    expect(parsed).toEqual(definition);
    const expansion = bytes(parsed) - new TextEncoder().encode(incoming).byteLength;
    expect(expansion).toBeGreaterThan(0);
    const receiptBytes =
      bytes(ReadPolicyEvaluationRequestResponseSchema.parse(response("\u0000".repeat(128)))) -
      bytes(parsed);
    expect(expansion + receiptBytes).toBeLessThanOrEqual(
      MAX_POLICY_EVALUATION_REQUEST_RESPONSE_BYTES - MAX_POLICY_EVALUATION_REQUEST_BYTES,
    );
  });

  it("requires exact record and envelope identities and rejects computed-result fields", () => {
    const valid = response("req_policy_evaluation");
    expect(ReadPolicyEvaluationRequestResponseSchema.parse(valid)).toEqual(valid);
    expect(
      ReadPolicyEvaluationRequestResponseSchema.safeParse({
        ...valid,
        request: { ...valid.request, definitionSha256: "bad" },
      }).success,
    ).toBe(false);
    expect(
      ReadPolicyEvaluationRequestResponseSchema.safeParse({
        ...valid,
        request: { ...valid.request, verdict: "satisfied" },
      }).success,
    ).toBe(false);
    expect(
      ReadPolicyEvaluationRequestResponseSchema.safeParse({ ...valid, approved: true }).success,
    ).toBe(false);
    expect(
      ReadPolicyEvaluationRequestResponseSchema.safeParse({ ...valid, requestId: "x".repeat(129) })
        .success,
    ).toBe(false);
  });
});
