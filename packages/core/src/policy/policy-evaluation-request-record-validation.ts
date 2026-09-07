import { createHash } from "node:crypto";
import {
  type EvidenceScope,
  encodePolicyEvaluationRequestDefinition,
  type PolicyEvaluationRequest,
  type PolicyEvaluationRequestDefinition,
  type PolicyEvaluationRequestReference,
  PolicyEvaluationRequestSchema,
} from "@proofstack/contracts";

export class InvalidPolicyEvaluationRequestRecordError extends Error {
  readonly code = "policy_evaluation_request_record_invalid";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidPolicyEvaluationRequestRecordError";
  }
}

const receiptKeys = [
  "createdAt",
  "createdByPrincipalId",
  "definitionSha256",
  "schemaVersion",
  "scope",
] as const;

function definitionOf(record: PolicyEvaluationRequest): PolicyEvaluationRequestDefinition {
  const definition = structuredClone(record) as unknown as Record<string, unknown>;
  for (const key of receiptKeys) delete definition[key];
  return definition as unknown as PolicyEvaluationRequestDefinition;
}

export function digestPolicyEvaluationRequestDefinition(
  scope: EvidenceScope,
  definition: PolicyEvaluationRequestDefinition,
): string {
  return createHash("sha256")
    .update(encodePolicyEvaluationRequestDefinition({ definition, scope }))
    .digest("hex");
}

export function validatePolicyEvaluationRequestRecord(input: unknown): PolicyEvaluationRequest {
  let record: PolicyEvaluationRequest;
  let digest: string;
  try {
    record = PolicyEvaluationRequestSchema.parse(input);
    digest = digestPolicyEvaluationRequestDefinition(record.scope, definitionOf(record));
  } catch (cause) {
    throw new InvalidPolicyEvaluationRequestRecordError(
      "Invalid policy evaluation request record",
      { cause },
    );
  }
  if (digest !== record.definitionSha256)
    throw new InvalidPolicyEvaluationRequestRecordError(
      `Policy evaluation request ${record.evaluationRequestId} has an invalid canonical definition digest`,
    );
  return record;
}

export function policyEvaluationRequestReference(
  record: PolicyEvaluationRequest,
): PolicyEvaluationRequestReference {
  return {
    definitionSha256: record.definitionSha256,
    evaluationRequestId: record.evaluationRequestId,
  };
}
