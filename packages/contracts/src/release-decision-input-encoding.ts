import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";
import {
  RELEASE_DECISION_INPUT_SCHEMA_VERSION,
  type ReleaseDecisionInputDefinition,
  ReleaseDecisionInputDefinitionSchema,
} from "./release-decision-input.js";

export const RELEASE_DECISION_INPUT_DEFINITION_DOMAIN = "proofstack.release-decision-input.v1";
export const RELEASE_DECISION_INPUT_ENCODING_VERSION =
  "proofstack.release-decision-input-definition-jcs.v1";

const Scoped = z
  .object({ scope: EvidenceScopeSchema, definition: ReleaseDecisionInputDefinitionSchema })
  .strict()
  .superRefine((value, context) => {
    if (
      value.scope.tenantId !== value.definition.scope.tenantId ||
      value.scope.projectId !== value.definition.scope.projectId ||
      value.scope.environmentId !== value.definition.scope.environmentId
    )
      context.addIssue({
        code: "custom",
        message: "Input scope must equal its canonical digest scope",
      });
  });

/** Includes original publisher, native cut, aggregate limits and every planned request. */
export function encodeReleaseDecisionInputDefinition(input: {
  readonly scope: EvidenceScope;
  readonly definition: ReleaseDecisionInputDefinition;
}): Uint8Array {
  const parsed = Scoped.parse(input);
  return encodeEvaluationCanonicalJson({
    ...parsed,
    definitionDomain: RELEASE_DECISION_INPUT_DEFINITION_DOMAIN,
    encodingVersion: RELEASE_DECISION_INPUT_ENCODING_VERSION,
    schemaVersion: RELEASE_DECISION_INPUT_SCHEMA_VERSION,
  });
}
