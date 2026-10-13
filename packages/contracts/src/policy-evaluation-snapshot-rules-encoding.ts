import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import {
  PolicyEvaluationSnapshotRuleInputsSchema,
  type PolicyEvaluationSnapshotRuleInputs,
} from "./policy-evaluation-snapshot-rules.js";

export const POLICY_EVALUATION_SNAPSHOT_RULES_DOMAIN =
  "proofstack.policy-evaluation-snapshot-rules.v1" as const;
export const POLICY_EVALUATION_SNAPSHOT_RULES_ENCODING_VERSION =
  "proofstack.policy-evaluation-snapshot-rules-jcs.v1" as const;

/** Source body authenticity and guarded publication are owning-domain responsibilities. */
export function encodePolicyEvaluationSnapshotRuleInputs(
  input: PolicyEvaluationSnapshotRuleInputs,
): Uint8Array {
  return encodeEvaluationCanonicalJson({
    ...PolicyEvaluationSnapshotRuleInputsSchema.parse(input),
    definitionDomain: POLICY_EVALUATION_SNAPSHOT_RULES_DOMAIN,
    encodingVersion: POLICY_EVALUATION_SNAPSHOT_RULES_ENCODING_VERSION,
  });
}
