import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";
import {
  POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
  type PolicyEvaluationRequestDefinition,
  PolicyEvaluationRequestDefinitionSchema,
} from "./policy-evaluation-request.js";

export const POLICY_EVALUATION_REQUEST_DEFINITION_DOMAIN =
  "proofstack.policy-evaluation-request.v1" as const;
export const POLICY_EVALUATION_REQUEST_DEFINITION_ENCODING_VERSION =
  "proofstack.policy-evaluation-request-definition-jcs.v1" as const;

export interface ScopedPolicyEvaluationRequestDefinition {
  readonly definition: PolicyEvaluationRequestDefinition;
  readonly scope: EvidenceScope;
}

const ScopedPolicyEvaluationRequestDefinitionSchema = z
  .object({
    definition: PolicyEvaluationRequestDefinitionSchema,
    scope: EvidenceScopeSchema,
  })
  .strict();

/** Bind exact semantic inputs and authoritative scope, not a server receipt or computed outcome. */
export function encodePolicyEvaluationRequestDefinition(
  input: ScopedPolicyEvaluationRequestDefinition,
): Uint8Array {
  const parsed = ScopedPolicyEvaluationRequestDefinitionSchema.parse(input);
  return encodeEvaluationCanonicalJson({
    definition: parsed.definition,
    definitionDomain: POLICY_EVALUATION_REQUEST_DEFINITION_DOMAIN,
    encodingVersion: POLICY_EVALUATION_REQUEST_DEFINITION_ENCODING_VERSION,
    schemaVersion: POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
    scope: parsed.scope,
  });
}
