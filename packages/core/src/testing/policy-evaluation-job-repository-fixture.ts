import type { PolicyEvaluationRequest } from "@proofstack/contracts";
/** Synthetic fixture. Built testing exports never depend on an external source-vector file. */
export const policyJobRepositoryRequestFixture: PolicyEvaluationRequest = {
  algorithm: { id: "proofstack.deterministic-policy", version: "1.0.0" },
  candidate: {
    candidateId: "candidate_reference",
    candidateVersionId: "candidate_reference_v1",
    definitionSha256: "1".repeat(64),
  },
  evaluationRequestId: "policy_evaluation_request_example",
  evaluationTime: "2026-09-07T11:59:59.999999999999999999999999999999Z",
  limits: {
    heartbeatIntervalMilliseconds: 5000,
    leaseDurationMilliseconds: 30000,
    maxAcquisitionRecordBytes: 16777216,
    maxAcquisitionRecords: 10000,
    maxArtifactReadBytes: 67108864,
    maxAttempts: 3,
    maxRuleEvaluations: 384,
    perAttemptTimeoutMilliseconds: 120000,
    retryBackoffMilliseconds: 1000,
    retryableErrors: [
      "lease_expired",
      "source_revision_changed",
      "source_temporarily_unavailable",
      "worker_interrupted",
    ],
    totalDeadlineMilliseconds: 600000,
  },
  policy: {
    definitionSha256: "2".repeat(64),
    policyId: "policy_reference",
    policyVersionId: "policy_reference_v1",
  },
  scope: { environmentId: "env_example", projectId: "project_example", tenantId: "tenant_example" },
  definitionSha256: "6df79abe573357163273d2131a480c2c419fab0d0f72416005ced3ddb2ef7f2e",
  schemaVersion: "0.1",
  createdAt: "2026-09-07T12:00:00.000Z",
  createdByPrincipalId: "principal_controller",
};
