import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { EvidenceScopeSchema, type EvidenceScope } from "./evidence.js";
import {
  RELEASE_REVIEWER_PUBLICATION_SCHEMA_VERSION,
  ReleaseReviewerPublicationDefinitionSchema,
  type ReleaseReviewerPublicationDefinition,
} from "./release-reviewer-publication.js";

export const RELEASE_REVIEWER_PUBLICATION_DEFINITION_DOMAIN =
  "proofstack.release-reviewer-publication.v1" as const;
export const RELEASE_REVIEWER_PUBLICATION_ENCODING_VERSION =
  "proofstack.release-reviewer-publication-jcs.v1" as const;
const Scoped = z
  .object({ scope: EvidenceScopeSchema, definition: ReleaseReviewerPublicationDefinitionSchema })
  .strict()
  .superRefine((value, context) => {
    if (
      value.scope.tenantId !== value.definition.scope.tenantId ||
      value.scope.projectId !== value.definition.scope.projectId ||
      value.scope.environmentId !== value.definition.scope.environmentId
    )
      context.addIssue({
        code: "custom",
        message: "Reviewer publication digest must bind its exact original scope",
      });
  });
/** Retained original integrity only; neither actual authentication nor current permission. */
export function encodeReleaseReviewerPublicationDefinition(input: {
  readonly scope: EvidenceScope;
  readonly definition: ReleaseReviewerPublicationDefinition;
}): Uint8Array {
  return encodeEvaluationCanonicalJson({
    ...Scoped.parse(input),
    definitionDomain: RELEASE_REVIEWER_PUBLICATION_DEFINITION_DOMAIN,
    encodingVersion: RELEASE_REVIEWER_PUBLICATION_ENCODING_VERSION,
    schemaVersion: RELEASE_REVIEWER_PUBLICATION_SCHEMA_VERSION,
  });
}
