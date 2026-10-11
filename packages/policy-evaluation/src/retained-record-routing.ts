import {
  type EvidenceScope,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  inspectPolicyEvaluationControlCapture,
  inspectPolicyEvaluationEvidenceCapture,
  type PolicyEvaluationControlCapture,
  type PolicyEvaluationControlSource,
  type PolicyEvaluationEvidenceCapture,
  type PolicyEvaluationEvidenceSource,
} from "@proofstack/core";
import {
  inspectPolicyEvaluationDatasetCapture,
  type PolicyEvaluationDatasetCapture,
  type PolicyEvaluationDatasetSource,
} from "@proofstack/datasets";
import { PolicyRecordGraphError } from "./acquisition-budget.js";

export type PolicyRetainedRecordCapture =
  | PolicyEvaluationControlCapture
  | PolicyEvaluationEvidenceCapture
  | PolicyEvaluationDatasetCapture;
export type PolicyRetainedRecordStorage = NonNullable<PolicyRetainedRecordCapture["storage"]>;
export interface PolicyRecordContext {
  readonly scope: EvidenceScope;
  readonly evaluationTime: string;
  readonly source: PolicyEvaluationSourceReference;
}

/** Fixed owning validators, retaining actual receipts without moving the semantic cut. */
export function inspectRetainedPolicyRecord(
  context: PolicyRecordContext,
  body: unknown,
): PolicyRetainedRecordCapture | null {
  const { source, scope, evaluationTime } = context;
  switch (source.kind) {
    case "comparison_definition":
    case "comparison_snapshot":
    case "comparison_result":
    case "release_candidate":
    case "release_policy":
    case "policy_installation_binding":
      return inspectPolicyEvaluationControlCapture(
        { source: source as PolicyEvaluationControlSource, scope, evaluationTime },
        body,
      );
    case "dataset_version":
    case "regression_fixture_version":
      return inspectPolicyEvaluationDatasetCapture(
        { source: source as PolicyEvaluationDatasetSource, scope, evaluationTime },
        body,
      );
    case "protocol_definition":
    case "endpoint_profile":
    case "qualification_policy":
    case "evaluation_implementation_registration":
    case "replay_plan":
    case "replay_result":
    case "target_release":
    case "replay_runtime_profile":
    case "replay_isolation_profile":
    case "runtime_adapter":
      return null;
    default:
      return inspectPolicyEvaluationEvidenceCapture(
        { source: source as PolicyEvaluationEvidenceSource, scope, evaluationTime },
        body,
      );
  }
}

/** Reject substituted retained bodies, receipts, hashes or promoted future observations. */
export function validateRetainedPolicyRecord(
  context: PolicyRecordContext,
  capture: PolicyRetainedRecordCapture,
): PolicyRetainedRecordCapture {
  const inspected = inspectRetainedPolicyRecord(context, capture.storage?.record ?? null);
  if (
    !inspected ||
    serializeEvaluationCanonicalJson(inspected) !== serializeEvaluationCanonicalJson(capture)
  )
    throw new PolicyRecordGraphError(
      "observation_conflict",
      policyEvaluationSourceReferenceKey(context.source),
    );
  return inspected;
}
