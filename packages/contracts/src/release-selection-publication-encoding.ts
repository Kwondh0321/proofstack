import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { EvidenceScopeSchema, type EvidenceScope } from "./evidence.js";
import {
  RELEASE_SELECTION_PUBLICATION_SCHEMA_VERSION,
  ReleaseSelectionPublicationDefinitionSchema,
  type ReleaseSelectionPublicationDefinition,
} from "./release-selection-publication.js";

export const RELEASE_SELECTION_PUBLICATION_DEFINITION_DOMAIN =
  "proofstack.release-selection-publication.v1" as const;
export const RELEASE_SELECTION_PUBLICATION_ENCODING_VERSION =
  "proofstack.release-selection-publication-jcs.v1" as const;

const Scoped = z
  .object({ scope: EvidenceScopeSchema, definition: ReleaseSelectionPublicationDefinitionSchema })
  .strict()
  .superRefine((value, context) => {
    if (
      value.scope.tenantId !== value.definition.scope.tenantId ||
      value.scope.projectId !== value.definition.scope.projectId ||
      value.scope.environmentId !== value.definition.scope.environmentId
    )
      context.addIssue({
        code: "custom",
        message: "Publication digest must bind the exact original scope",
      });
  });

/** Original retained publication integrity, not authentication or a current permission grant. */
export function encodeReleaseSelectionPublicationDefinition(input: {
  readonly scope: EvidenceScope;
  readonly definition: ReleaseSelectionPublicationDefinition;
}): Uint8Array {
  const parsed = Scoped.parse(input);
  return encodeEvaluationCanonicalJson({
    ...parsed,
    definitionDomain: RELEASE_SELECTION_PUBLICATION_DEFINITION_DOMAIN,
    encodingVersion: RELEASE_SELECTION_PUBLICATION_ENCODING_VERSION,
    schemaVersion: RELEASE_SELECTION_PUBLICATION_SCHEMA_VERSION,
  });
}
