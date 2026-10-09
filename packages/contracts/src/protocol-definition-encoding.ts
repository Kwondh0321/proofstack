import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";
import {
  PROTOCOL_DEFINITION_SCHEMA_VERSION,
  type ProtocolDefinition,
  ProtocolDefinitionSchema,
} from "./protocol-definition.js";

export const PROTOCOL_DEFINITION_DOMAIN = "proofstack.protocol-definition.v1" as const;
export const PROTOCOL_DEFINITION_ENCODING_VERSION =
  "proofstack.protocol-definition-jcs.v1" as const;

const InputSchema = z
  .object({ definition: ProtocolDefinitionSchema, scope: EvidenceScopeSchema })
  .strict();

/** Binds exact family/descriptor, independently retained dependencies and scope; receipts are separate. */
export function encodeProtocolDefinition(input: {
  readonly definition: ProtocolDefinition;
  readonly scope: EvidenceScope;
}): Uint8Array {
  const parsed = InputSchema.parse(input);
  return encodeEvaluationCanonicalJson({
    definition: parsed.definition,
    definitionDomain: PROTOCOL_DEFINITION_DOMAIN,
    encodingVersion: PROTOCOL_DEFINITION_ENCODING_VERSION,
    schemaVersion: PROTOCOL_DEFINITION_SCHEMA_VERSION,
    scope: parsed.scope,
  });
}
