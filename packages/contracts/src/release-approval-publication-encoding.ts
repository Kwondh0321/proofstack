import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { EvidenceScopeSchema, type EvidenceScope } from "./evidence.js";
import {
  RELEASE_APPROVAL_PUBLICATION_SCHEMA_VERSION,
  ReleaseApprovalPublicationDefinitionSchema,
  type ReleaseApprovalPublicationDefinition,
} from "./release-approval-publication.js";

export const RELEASE_APPROVAL_PUBLICATION_DEFINITION_DOMAIN =
  "proofstack.release-approval-publication.v1" as const;
export const RELEASE_APPROVAL_PUBLICATION_ENCODING_VERSION =
  "proofstack.release-approval-publication-jcs.v1" as const;
const Scoped = z
  .object({ scope: EvidenceScopeSchema, definition: ReleaseApprovalPublicationDefinitionSchema })
  .strict()
  .superRefine((value, context) => {
    if (
      value.scope.tenantId !== value.definition.scope.tenantId ||
      value.scope.projectId !== value.definition.scope.projectId ||
      value.scope.environmentId !== value.definition.scope.environmentId
    )
      context.addIssue({
        code: "custom",
        message: "Approval publication digest must bind its exact original scope",
      });
  });
/** Retained original integrity only; neither actual authentication nor current permission. */
export function encodeReleaseApprovalPublicationDefinition(input: {
  readonly scope: EvidenceScope;
  readonly definition: ReleaseApprovalPublicationDefinition;
}): Uint8Array {
  return encodeEvaluationCanonicalJson({
    ...Scoped.parse(input),
    definitionDomain: RELEASE_APPROVAL_PUBLICATION_DEFINITION_DOMAIN,
    encodingVersion: RELEASE_APPROVAL_PUBLICATION_ENCODING_VERSION,
    schemaVersion: RELEASE_APPROVAL_PUBLICATION_SCHEMA_VERSION,
  });
}
