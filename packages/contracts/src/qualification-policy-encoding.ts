import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";
import {
  QUALIFICATION_POLICY_SCHEMA_VERSION,
  type QualificationPolicyDefinition,
  QualificationPolicyDefinitionSchema,
} from "./qualification-policy.js";

export const QUALIFICATION_POLICY_DOMAIN = "proofstack.qualification-policy.v1" as const;
export const QUALIFICATION_POLICY_ENCODING_VERSION =
  "proofstack.qualification-policy-jcs.v1" as const;

const InputSchema = z
  .object({ definition: QualificationPolicyDefinitionSchema, scope: EvidenceScopeSchema })
  .strict();

/** Exact immutable semantics and scope; original publication receipts are retained separately. */
export function encodeQualificationPolicy(input: {
  readonly definition: QualificationPolicyDefinition;
  readonly scope: EvidenceScope;
}): Uint8Array {
  const parsed = InputSchema.parse(input);
  return encodeEvaluationCanonicalJson({
    definition: parsed.definition,
    definitionDomain: QUALIFICATION_POLICY_DOMAIN,
    encodingVersion: QUALIFICATION_POLICY_ENCODING_VERSION,
    schemaVersion: QUALIFICATION_POLICY_SCHEMA_VERSION,
    scope: parsed.scope,
  });
}
