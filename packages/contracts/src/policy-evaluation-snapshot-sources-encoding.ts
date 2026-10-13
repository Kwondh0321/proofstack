import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import {
  PolicyEvaluationSnapshotSourceInputsSchema,
  type PolicyEvaluationSnapshotSourceInputs,
} from "./policy-evaluation-snapshot-sources.js";

export const POLICY_EVALUATION_SNAPSHOT_SOURCES_DOMAIN =
  "proofstack.policy-evaluation-snapshot-sources.v1" as const;
export const POLICY_EVALUATION_SNAPSHOT_SOURCES_ENCODING_VERSION =
  "proofstack.policy-evaluation-snapshot-sources-jcs.v1" as const;

/** Canonical relationship metadata; owning bodies and publication authority remain separate. */
export function encodePolicyEvaluationSnapshotSourceInputs(
  input: PolicyEvaluationSnapshotSourceInputs,
): Uint8Array {
  return encodeEvaluationCanonicalJson({
    ...PolicyEvaluationSnapshotSourceInputsSchema.parse(input),
    definitionDomain: POLICY_EVALUATION_SNAPSHOT_SOURCES_DOMAIN,
    encodingVersion: POLICY_EVALUATION_SNAPSHOT_SOURCES_ENCODING_VERSION,
  });
}
