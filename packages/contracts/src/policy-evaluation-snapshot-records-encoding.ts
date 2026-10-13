import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import {
  PolicyEvaluationSnapshotRecordInputsSchema,
  type PolicyEvaluationSnapshotRecordInputs,
} from "./policy-evaluation-snapshot-records.js";

export const POLICY_EVALUATION_SNAPSHOT_RECORDS_DOMAIN =
  "proofstack.policy-evaluation-snapshot-records.v1" as const;
export const POLICY_EVALUATION_SNAPSHOT_RECORDS_ENCODING_VERSION =
  "proofstack.policy-evaluation-snapshot-records-jcs.v1" as const;

/** Canonical retained metadata only; owning bodies and atomic publication remain independent. */
export function encodePolicyEvaluationSnapshotRecordInputs(
  input: PolicyEvaluationSnapshotRecordInputs,
): Uint8Array {
  const parsed = PolicyEvaluationSnapshotRecordInputsSchema.parse(input);
  return encodeEvaluationCanonicalJson({
    ...parsed,
    definitionDomain: POLICY_EVALUATION_SNAPSHOT_RECORDS_DOMAIN,
    encodingVersion: POLICY_EVALUATION_SNAPSHOT_RECORDS_ENCODING_VERSION,
  });
}
