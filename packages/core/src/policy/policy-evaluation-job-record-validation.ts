import { createHash } from "node:crypto";
import {
  encodePolicyEvaluationJobDefinition,
  PolicyEvaluationJobSnapshotSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PolicyEvaluationJobDefinition,
  type PolicyEvaluationJobReference,
  type PolicyEvaluationJobSnapshot,
} from "@proofstack/contracts";
import { validatePolicyEvaluationRequestRecord } from "./policy-evaluation-request-record-validation.js";

export class InvalidPolicyEvaluationJobGraphError extends Error {
  readonly code = "policy_evaluation_job_graph_invalid";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidPolicyEvaluationJobGraphError";
  }
}
export function digestPolicyEvaluationJobDefinition(
  scope: EvidenceScope,
  definition: PolicyEvaluationJobDefinition,
): string {
  return createHash("sha256")
    .update(encodePolicyEvaluationJobDefinition({ scope, definition }))
    .digest("hex");
}
/** Integrity and complete graph validation, not permission to revive a stored lease or publish. */
export function validatePolicyEvaluationJobSnapshotRecord(input: {
  readonly expected: { readonly scope: EvidenceScope; readonly job: PolicyEvaluationJobReference };
  readonly snapshot: unknown;
}): PolicyEvaluationJobSnapshot {
  try {
    const snapshot = PolicyEvaluationJobSnapshotSchema.parse(input.snapshot);
    validatePolicyEvaluationRequestRecord(snapshot.request);
    const { job } = snapshot;
    const digest = digestPolicyEvaluationJobDefinition(job.scope, {
      jobId: job.jobId,
      request: job.request,
    });
    if (
      digest !== job.definitionSha256 ||
      job.jobId !== input.expected.job.jobId ||
      digest !== input.expected.job.definitionSha256 ||
      serializeEvaluationCanonicalJson(job.scope) !==
        serializeEvaluationCanonicalJson(input.expected.scope)
    )
      throw new Error("Exact job identity, scope or canonical digest mismatch");
    return snapshot;
  } catch (cause) {
    throw new InvalidPolicyEvaluationJobGraphError("Invalid exact policy job graph", { cause });
  }
}
