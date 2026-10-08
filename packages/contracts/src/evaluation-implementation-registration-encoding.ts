import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import {
  EVALUATION_IMPLEMENTATION_REGISTRATION_SCHEMA_VERSION,
  type EvaluationImplementationRegistrationDefinition,
  EvaluationImplementationRegistrationDefinitionSchema,
} from "./evaluation-implementation-registration.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";

export const EVALUATION_IMPLEMENTATION_REGISTRATION_DOMAIN =
  "proofstack.evaluation-implementation-registration.v1" as const;
export const EVALUATION_IMPLEMENTATION_REGISTRATION_ENCODING_VERSION =
  "proofstack.evaluation-implementation-registration-jcs.v1" as const;

const InputSchema = z
  .object({
    definition: EvaluationImplementationRegistrationDefinitionSchema,
    scope: EvidenceScopeSchema,
  })
  .strict();

/** Binds the complete descriptor and exact scope, independently of original registration receipts. */
export function encodeEvaluationImplementationRegistration(input: {
  readonly definition: EvaluationImplementationRegistrationDefinition;
  readonly scope: EvidenceScope;
}): Uint8Array {
  const parsed = InputSchema.parse(input);
  return encodeEvaluationCanonicalJson({
    definition: parsed.definition,
    definitionDomain: EVALUATION_IMPLEMENTATION_REGISTRATION_DOMAIN,
    encodingVersion: EVALUATION_IMPLEMENTATION_REGISTRATION_ENCODING_VERSION,
    schemaVersion: EVALUATION_IMPLEMENTATION_REGISTRATION_SCHEMA_VERSION,
    scope: parsed.scope,
  });
}
