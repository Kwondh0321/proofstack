import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";
import {
  RELEASE_DECISION_SCHEMA_VERSION,
  type ReleaseDecisionDefinition,
  ReleaseDecisionDefinitionSchema,
} from "./release-decision.js";

export const RELEASE_DECISION_DEFINITION_DOMAIN = "proofstack.release-decision.v1";
export const RELEASE_DECISION_ENCODING_VERSION = "proofstack.release-decision-definition-jcs.v1";
const Scoped = z
  .object({ scope: EvidenceScopeSchema, definition: ReleaseDecisionDefinitionSchema })
  .strict()
  .superRefine((value, context) => {
    if (
      value.scope.tenantId !== value.definition.scope.tenantId ||
      value.scope.projectId !== value.definition.scope.projectId ||
      value.scope.environmentId !== value.definition.scope.environmentId
    )
      context.addIssue({
        code: "custom",
        message: "Decision scope must equal its canonical digest scope",
      });
  });

/** Exact historical decision material; a valid digest cannot supply current publication authority. */
export function encodeReleaseDecisionDefinition(input: {
  readonly scope: EvidenceScope;
  readonly definition: ReleaseDecisionDefinition;
}): Uint8Array {
  const parsed = Scoped.parse(input);
  return encodeEvaluationCanonicalJson({
    ...parsed,
    definition: JSON.parse(JSON.stringify(parsed.definition)) as ReleaseDecisionDefinition,
    definitionDomain: RELEASE_DECISION_DEFINITION_DOMAIN,
    encodingVersion: RELEASE_DECISION_ENCODING_VERSION,
    schemaVersion: RELEASE_DECISION_SCHEMA_VERSION,
  });
}
