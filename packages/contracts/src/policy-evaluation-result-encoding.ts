import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";
import {
  type PolicyEvaluationDefinition,
  PolicyEvaluationDefinitionSchema,
  POLICY_EVALUATION_RESULT_SCHEMA_VERSION,
} from "./policy-evaluation-result.js";

export const POLICY_EVALUATION_RESULT_DEFINITION_DOMAIN =
  "proofstack.policy-evaluation-result.v1" as const;
export const POLICY_EVALUATION_RESULT_DEFINITION_ENCODING_VERSION =
  "proofstack.policy-evaluation-result-definition-jcs.v1" as const;
const Scoped = z
  .object({ definition: PolicyEvaluationDefinitionSchema, scope: EvidenceScopeSchema })
  .strict();
/** Exact semantic outcomes and scope, excluding execution identity and server receipt time. */
export function encodePolicyEvaluationDefinition(input: {
  readonly definition: PolicyEvaluationDefinition;
  readonly scope: EvidenceScope;
}): Uint8Array {
  const parsed = Scoped.parse(input);
  return encodeEvaluationCanonicalJson({
    ...parsed,
    definition: JSON.parse(JSON.stringify(parsed.definition)) as PolicyEvaluationDefinition,
    definitionDomain: POLICY_EVALUATION_RESULT_DEFINITION_DOMAIN,
    encodingVersion: POLICY_EVALUATION_RESULT_DEFINITION_ENCODING_VERSION,
    schemaVersion: POLICY_EVALUATION_RESULT_SCHEMA_VERSION,
  });
}
