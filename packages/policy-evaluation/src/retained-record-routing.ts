import {
  type EvidenceScope,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  enumeratePolicyEvaluationStoredControlReferences,
  enumeratePolicyEvaluationStoredEndpointProfileReferences,
  enumeratePolicyEvaluationStoredEvidenceReferences,
  enumeratePolicyEvaluationStoredImplementationReferences,
  enumeratePolicyEvaluationStoredProtocolReferences,
  enumeratePolicyEvaluationStoredQualificationPolicyReferences,
  enumeratePolicyEvaluationStoredRuntimeReferences,
  inspectPolicyEvaluationControlCapture,
  inspectPolicyEvaluationEndpointProfileCapture,
  inspectPolicyEvaluationEvidenceCapture,
  inspectPolicyEvaluationImplementationCapture,
  inspectPolicyEvaluationProtocolCapture,
  inspectPolicyEvaluationQualificationPolicyCapture,
  inspectPolicyEvaluationRuntimeCapture,
  type PolicyEvaluationControlCapture,
  type PolicyEvaluationControlSource,
  type PolicyEvaluationEvidenceCapture,
  type PolicyEvaluationEvidenceReferenceLimits,
  type PolicyEvaluationEvidenceSource,
  type PolicyEvaluationEndpointProfileCapture,
  type PolicyEvaluationImplementationCapture,
  type PolicyEvaluationProtocolCapture,
  type PolicyEvaluationQualificationPolicyCapture,
  type PolicyEvaluationRuntimeCapture,
} from "@proofstack/core";
import {
  enumeratePolicyEvaluationStoredDatasetReferences,
  inspectPolicyEvaluationDatasetCapture,
  type PolicyEvaluationDatasetCapture,
  type PolicyEvaluationDatasetSource,
} from "@proofstack/datasets";
import {
  enumeratePolicyEvaluationStoredReplayDefinitionReferences,
  enumeratePolicyEvaluationStoredReplayResultReferences,
  inspectPolicyEvaluationReplayDefinitionCapture,
  inspectPolicyEvaluationReplayResultCapture,
  type PolicyEvaluationReplayDefinitionCapture,
  type PolicyEvaluationReplayResultCapture,
  type PolicyEvaluationReplayResultReadInput,
} from "@proofstack/replay";
import { PolicyRecordGraphError } from "./acquisition-budget.js";

export type PolicyRetainedRecordCapture =
  | PolicyEvaluationControlCapture
  | PolicyEvaluationEvidenceCapture
  | PolicyEvaluationDatasetCapture
  | PolicyEvaluationEndpointProfileCapture
  | PolicyEvaluationImplementationCapture
  | PolicyEvaluationProtocolCapture
  | PolicyEvaluationQualificationPolicyCapture
  | PolicyEvaluationRuntimeCapture
  | PolicyEvaluationReplayDefinitionCapture
  | PolicyEvaluationReplayResultCapture;
export type PolicyRetainedRecordStorage = NonNullable<PolicyRetainedRecordCapture["storage"]>;
export interface PolicyRecordContext {
  readonly scope: EvidenceScope;
  readonly evaluationTime: string;
  readonly source: PolicyEvaluationSourceReference;
  readonly replayLimits?: PolicyEvaluationReplayResultReadInput["limits"];
}

function requiredReplayLimits(context: PolicyRecordContext) {
  if (!context.replayLimits)
    throw new TypeError("Replay retention requires original finite read limits");
  return context.replayLimits;
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
      return inspectPolicyEvaluationProtocolCapture({ source, scope, evaluationTime }, body);
    case "endpoint_profile":
      return inspectPolicyEvaluationEndpointProfileCapture({ source, scope, evaluationTime }, body);
    case "qualification_policy":
      return inspectPolicyEvaluationQualificationPolicyCapture(
        { source, scope, evaluationTime },
        body,
      );
    case "evaluation_implementation_registration":
      return inspectPolicyEvaluationImplementationCapture({ source, scope, evaluationTime }, body);
    case "replay_plan":
    case "target_release":
      return inspectPolicyEvaluationReplayDefinitionCapture(
        { source, scope, evaluationTime },
        body,
      );
    case "replay_result":
      return inspectPolicyEvaluationReplayResultCapture(
        { source, scope, evaluationTime, limits: requiredReplayLimits(context) },
        body,
      );
    case "replay_runtime_profile":
    case "replay_isolation_profile":
    case "runtime_adapter":
      return inspectPolicyEvaluationRuntimeCapture({ source, scope, evaluationTime }, body);
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

/**
 * Fixed owning storage-declaration dispatcher for every installed source kind.
 * These declarations do not become semantic graph edges or current authority.
 */
export function enumerateRetainedPolicyRecord(
  context: PolicyRecordContext,
  capture: PolicyRetainedRecordCapture,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const { source, scope, evaluationTime } = context;
  switch (source.kind) {
    case "comparison_definition":
    case "comparison_snapshot":
    case "comparison_result":
    case "release_candidate":
    case "release_policy":
    case "policy_installation_binding":
      return enumeratePolicyEvaluationStoredControlReferences(
        { source: source as PolicyEvaluationControlSource, scope, evaluationTime },
        capture as PolicyEvaluationControlCapture,
        limits,
      );
    case "dataset_version":
    case "regression_fixture_version":
      return enumeratePolicyEvaluationStoredDatasetReferences(
        { source: source as PolicyEvaluationDatasetSource, scope, evaluationTime },
        capture as PolicyEvaluationDatasetCapture,
        limits,
      );
    case "protocol_definition":
      return enumeratePolicyEvaluationStoredProtocolReferences(
        { source, scope, evaluationTime },
        capture as PolicyEvaluationProtocolCapture,
        limits,
      );
    case "endpoint_profile":
      return enumeratePolicyEvaluationStoredEndpointProfileReferences(
        { source, scope, evaluationTime },
        capture as PolicyEvaluationEndpointProfileCapture,
        limits,
      );
    case "qualification_policy":
      return enumeratePolicyEvaluationStoredQualificationPolicyReferences(
        { source, scope, evaluationTime },
        capture as PolicyEvaluationQualificationPolicyCapture,
        limits,
      );
    case "evaluation_implementation_registration":
      return enumeratePolicyEvaluationStoredImplementationReferences(
        { source, scope, evaluationTime },
        capture as PolicyEvaluationImplementationCapture,
        limits,
      );
    case "replay_plan":
    case "target_release":
      return enumeratePolicyEvaluationStoredReplayDefinitionReferences(
        { source, scope, evaluationTime },
        capture as PolicyEvaluationReplayDefinitionCapture,
        limits,
      );
    case "replay_result":
      return enumeratePolicyEvaluationStoredReplayResultReferences(
        { source, scope, evaluationTime, limits: requiredReplayLimits(context) },
        capture as PolicyEvaluationReplayResultCapture,
        limits,
      );
    case "replay_runtime_profile":
    case "replay_isolation_profile":
    case "runtime_adapter":
      return enumeratePolicyEvaluationStoredRuntimeReferences(
        { source, scope, evaluationTime },
        capture as PolicyEvaluationRuntimeCapture,
        limits,
      );
    default:
      return enumeratePolicyEvaluationStoredEvidenceReferences(
        { source: source as PolicyEvaluationEvidenceSource, scope, evaluationTime },
        capture as PolicyEvaluationEvidenceCapture,
        limits,
      );
  }
}
