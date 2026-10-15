import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";
import {
  RELEASE_POLICY_SELECTION_SCHEMA_VERSION,
  type ReleasePolicySelectionDefinition,
  ReleasePolicySelectionDefinitionSchema,
} from "./release-policy-selection.js";

export const RELEASE_POLICY_SELECTION_DEFINITION_DOMAIN =
  "proofstack.release-policy-selection.v1" as const;
export const RELEASE_POLICY_SELECTION_ENCODING_VERSION =
  "proofstack.release-policy-selection-definition-jcs.v1" as const;

const Scoped = z
  .object({ scope: EvidenceScopeSchema, definition: ReleasePolicySelectionDefinitionSchema })
  .strict()
  .superRefine((value, context) => {
    if (
      value.scope.tenantId !== value.definition.scope.tenantId ||
      value.scope.projectId !== value.definition.scope.projectId ||
      value.scope.environmentId !== value.definition.scope.environmentId
    )
      context.addIssue({
        code: "custom",
        message: "Selection scope must equal its canonical digest scope",
      });
  });

/** Complete installed selection semantics; this encoder performs no lookup or publication. */
export function encodeReleasePolicySelectionDefinition(input: {
  readonly scope: EvidenceScope;
  readonly definition: ReleasePolicySelectionDefinition;
}): Uint8Array {
  const parsed = Scoped.parse(input);
  return encodeEvaluationCanonicalJson({
    ...parsed,
    definition: JSON.parse(JSON.stringify(parsed.definition)) as ReleasePolicySelectionDefinition,
    definitionDomain: RELEASE_POLICY_SELECTION_DEFINITION_DOMAIN,
    encodingVersion: RELEASE_POLICY_SELECTION_ENCODING_VERSION,
    schemaVersion: RELEASE_POLICY_SELECTION_SCHEMA_VERSION,
  });
}
