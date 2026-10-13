import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { EvidenceScopeSchema, type EvidenceScope } from "./evidence.js";
import {
  PolicyEvaluationSnapshotInputsSchema,
  type PolicyEvaluationSnapshotInputs,
} from "./policy-evaluation-snapshot-inputs.js";
import {
  PolicyEvaluationSnapshotDefinitionSchema,
  PolicyEvaluationSnapshotPageDefinitionSchema,
  type PolicyEvaluationSnapshotDefinition,
  type PolicyEvaluationSnapshotPageDefinition,
} from "./policy-evaluation-snapshot.js";

export const POLICY_EVALUATION_SNAPSHOT_INPUTS_DOMAIN =
  "proofstack.policy-evaluation-snapshot-inputs.v1" as const;
export const POLICY_EVALUATION_SNAPSHOT_INPUTS_ENCODING_VERSION =
  "proofstack.policy-evaluation-snapshot-inputs-jcs.v1" as const;
export const POLICY_EVALUATION_SNAPSHOT_DOMAIN =
  "proofstack.policy-evaluation-snapshot.v1" as const;
export const POLICY_EVALUATION_SNAPSHOT_ENCODING_VERSION =
  "proofstack.policy-evaluation-snapshot-jcs.v1" as const;
export const POLICY_EVALUATION_SNAPSHOT_PAGE_DOMAIN =
  "proofstack.policy-evaluation-snapshot-page.v1" as const;
export const POLICY_EVALUATION_SNAPSHOT_PAGE_ENCODING_VERSION =
  "proofstack.policy-evaluation-snapshot-page-jcs.v1" as const;

/** Metadata and typed evidence only. No classified event/artifact bytes or key/locator material. */
export function encodePolicyEvaluationSnapshotInputs(
  inputs: PolicyEvaluationSnapshotInputs,
): Uint8Array {
  return encodeEvaluationCanonicalJson({
    ...PolicyEvaluationSnapshotInputsSchema.parse(inputs),
    definitionDomain: POLICY_EVALUATION_SNAPSHOT_INPUTS_DOMAIN,
    encodingVersion: POLICY_EVALUATION_SNAPSHOT_INPUTS_ENCODING_VERSION,
  });
}
export function encodePolicyEvaluationSnapshotDefinition(input: {
  definition: PolicyEvaluationSnapshotDefinition;
  scope: EvidenceScope;
}): Uint8Array {
  return encodeEvaluationCanonicalJson({
    ...PolicyEvaluationSnapshotDefinitionSchema.parse(input.definition),
    scope: EvidenceScopeSchema.parse(input.scope),
    definitionDomain: POLICY_EVALUATION_SNAPSHOT_DOMAIN,
    encodingVersion: POLICY_EVALUATION_SNAPSHOT_ENCODING_VERSION,
  });
}
export function encodePolicyEvaluationSnapshotPageDefinition(input: {
  definition: PolicyEvaluationSnapshotPageDefinition;
  scope: EvidenceScope;
}): Uint8Array {
  return encodeEvaluationCanonicalJson({
    ...PolicyEvaluationSnapshotPageDefinitionSchema.parse(input.definition),
    scope: EvidenceScopeSchema.parse(input.scope),
    definitionDomain: POLICY_EVALUATION_SNAPSHOT_PAGE_DOMAIN,
    encodingVersion: POLICY_EVALUATION_SNAPSHOT_PAGE_ENCODING_VERSION,
  });
}
