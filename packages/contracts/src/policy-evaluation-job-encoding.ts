import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { EvidenceScopeSchema, type EvidenceScope } from "./evidence.js";
import {
  PolicyEvaluationJobDefinitionSchema,
  POLICY_EVALUATION_JOB_SCHEMA_VERSION,
  type PolicyEvaluationJobDefinition,
} from "./policy-evaluation-job.js";

export const POLICY_EVALUATION_JOB_DEFINITION_DOMAIN =
  "proofstack.policy-evaluation-job.v1" as const;
export const POLICY_EVALUATION_JOB_DEFINITION_ENCODING_VERSION =
  "proofstack.policy-evaluation-job-definition-jcs.v1" as const;
const Scoped = z
  .object({ definition: PolicyEvaluationJobDefinitionSchema, scope: EvidenceScopeSchema })
  .strict();
/** Immutable identity and request; scheduling, leases, counters and receipts are excluded. */
export function encodePolicyEvaluationJobDefinition(input: {
  readonly definition: PolicyEvaluationJobDefinition;
  readonly scope: EvidenceScope;
}): Uint8Array {
  return encodeEvaluationCanonicalJson({
    ...Scoped.parse(input),
    definitionDomain: POLICY_EVALUATION_JOB_DEFINITION_DOMAIN,
    encodingVersion: POLICY_EVALUATION_JOB_DEFINITION_ENCODING_VERSION,
    schemaVersion: POLICY_EVALUATION_JOB_SCHEMA_VERSION,
  });
}
