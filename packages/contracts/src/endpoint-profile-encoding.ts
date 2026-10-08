import { z } from "zod";
import {
  ENDPOINT_PROFILE_SCHEMA_VERSION,
  type EndpointProfileDefinition,
  EndpointProfileDefinitionSchema,
} from "./endpoint-profile.js";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";

export const ENDPOINT_PROFILE_DOMAIN = "proofstack.endpoint-profile.v1" as const;
export const ENDPOINT_PROFILE_ENCODING_VERSION = "proofstack.endpoint-profile-jcs.v1" as const;

const InputSchema = z
  .object({ definition: EndpointProfileDefinitionSchema, scope: EvidenceScopeSchema })
  .strict();

/** Binds all declarations, exact configuration descriptor and scope; receipts remain separate. */
export function encodeEndpointProfile(input: {
  readonly definition: EndpointProfileDefinition;
  readonly scope: EvidenceScope;
}): Uint8Array {
  const parsed = InputSchema.parse(input);
  return encodeEvaluationCanonicalJson({
    definition: parsed.definition,
    definitionDomain: ENDPOINT_PROFILE_DOMAIN,
    encodingVersion: ENDPOINT_PROFILE_ENCODING_VERSION,
    schemaVersion: ENDPOINT_PROFILE_SCHEMA_VERSION,
    scope: parsed.scope,
  });
}
