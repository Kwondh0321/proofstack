import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";
import {
  RUNTIME_DEFINITION_SCHEMA_VERSION,
  type RuntimeDefinition,
  RuntimeDefinitionSchema,
} from "./runtime-definition.js";

export const RUNTIME_DEFINITION_ENCODING_VERSION = "proofstack.runtime-definition-jcs.v1" as const;
export const RUNTIME_DEFINITION_DOMAIN = "proofstack.runtime-definition.v1" as const;

const InputSchema = z
  .object({ definition: RuntimeDefinitionSchema, scope: EvidenceScopeSchema })
  .strict();

/** Every semantic field is bound; registration receipts and execution authority are not inputs. */
export function encodeRuntimeDefinition(input: {
  readonly definition: RuntimeDefinition;
  readonly scope: EvidenceScope;
}): Uint8Array {
  const parsed = InputSchema.parse(input);
  return encodeEvaluationCanonicalJson({
    definition: parsed.definition,
    definitionDomain: RUNTIME_DEFINITION_DOMAIN,
    encodingVersion: RUNTIME_DEFINITION_ENCODING_VERSION,
    schemaVersion: RUNTIME_DEFINITION_SCHEMA_VERSION,
    scope: parsed.scope,
  });
}
