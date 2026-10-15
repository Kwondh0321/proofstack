import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";
import {
  RELEASE_APPROVAL_SCHEMA_VERSION,
  type ReleaseApprovalDefinition,
  ReleaseApprovalDefinitionSchema,
} from "./release-approval.js";
import {
  RELEASE_REVIEWER_AUTHORITY_SCHEMA_VERSION,
  type ReleaseReviewerAuthorityDefinition,
  ReleaseReviewerAuthorityDefinitionSchema,
} from "./release-reviewer-authority.js";

export const RELEASE_REVIEWER_AUTHORITY_DEFINITION_DOMAIN =
  "proofstack.release-reviewer-authority.v1" as const;
export const RELEASE_REVIEWER_AUTHORITY_ENCODING_VERSION =
  "proofstack.release-reviewer-authority-definition-jcs.v1" as const;
export const RELEASE_APPROVAL_DEFINITION_DOMAIN = "proofstack.release-approval.v1" as const;
export const RELEASE_APPROVAL_ENCODING_VERSION =
  "proofstack.release-approval-definition-jcs.v1" as const;

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}
const Authority = z
  .object({ scope: EvidenceScopeSchema, definition: ReleaseReviewerAuthorityDefinitionSchema })
  .strict()
  .superRefine((value, context) => {
    if (!sameScope(value.scope, value.definition.scope))
      context.addIssue({
        code: "custom",
        message: "Reviewer authority scope must equal its canonical digest scope",
      });
  });
const Approval = z
  .object({ scope: EvidenceScopeSchema, definition: ReleaseApprovalDefinitionSchema })
  .strict()
  .superRefine((value, context) => {
    if (!sameScope(value.scope, value.definition.subject.scope))
      context.addIssue({
        code: "custom",
        message: "Approval subject scope must equal its canonical digest scope",
      });
  });

/** Entire attributable authority declaration, never an authenticated approval or current grant. */
export function encodeReleaseReviewerAuthorityDefinition(input: {
  readonly scope: EvidenceScope;
  readonly definition: ReleaseReviewerAuthorityDefinition;
}): Uint8Array {
  const parsed = Authority.parse(input);
  return encodeEvaluationCanonicalJson({
    ...parsed,
    definition: JSON.parse(JSON.stringify(parsed.definition)) as ReleaseReviewerAuthorityDefinition,
    definitionDomain: RELEASE_REVIEWER_AUTHORITY_DEFINITION_DOMAIN,
    encodingVersion: RELEASE_REVIEWER_AUTHORITY_ENCODING_VERSION,
    schemaVersion: RELEASE_REVIEWER_AUTHORITY_SCHEMA_VERSION,
  });
}

/** Includes original server-owned actor/session receipt and native cut, never session secrets. */
export function encodeReleaseApprovalDefinition(input: {
  readonly scope: EvidenceScope;
  readonly definition: ReleaseApprovalDefinition;
}): Uint8Array {
  const parsed = Approval.parse(input);
  return encodeEvaluationCanonicalJson({
    ...parsed,
    definition: JSON.parse(JSON.stringify(parsed.definition)) as ReleaseApprovalDefinition,
    definitionDomain: RELEASE_APPROVAL_DEFINITION_DOMAIN,
    encodingVersion: RELEASE_APPROVAL_ENCODING_VERSION,
    schemaVersion: RELEASE_APPROVAL_SCHEMA_VERSION,
  });
}
