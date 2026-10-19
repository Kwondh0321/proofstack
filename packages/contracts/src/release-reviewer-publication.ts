import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { EvidenceScopeSchema } from "./evidence.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import { ReleaseApprovalReviewerReceiptSchema } from "./release-approval.js";
import {
  ReleaseDecisionIdentityGrantSchema,
  ReleaseDecisionUserIdentityReferenceSchema,
} from "./release-decision-authority-material.js";
import { ReleaseDecisionSessionStateSchema } from "./release-decision-credential-state.js";
import {
  ReleaseReviewerAuthorityReferenceSchema,
  ReleaseReviewerAuthoritySchema,
  ReleaseReviewerAuthorityLifecycleEventSchema,
} from "./release-reviewer-authority.js";

export const RELEASE_REVIEWER_PUBLICATION_SCHEMA_VERSION = "0.1" as const;
export const MAX_RELEASE_REVIEWER_PUBLICATION_DEFINITION_BYTES = 8 * 1024;
export const MAX_RELEASE_REVIEWER_PUBLICATION_GRANT_BYTES = 512 * 1024;
export const MAX_RELEASE_REVIEWER_PUBLICATION_MATERIAL_BYTES = 1024 * 1024;

export const ReleaseReviewerPublicationSubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("release_reviewer_authority"),
      authority: ReleaseReviewerAuthorityReferenceSchema,
      recordSha256: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("release_reviewer_authority_lifecycle"),
      authority: ReleaseReviewerAuthorityReferenceSchema,
      eventId: OpaqueIdSchema,
      recordSha256: Sha256Schema,
    })
    .strict(),
]);

/** Original administrator authentication provenance, not expertise, approval or current authority. */
export const ReleaseReviewerPublicationDefinitionSchema = z
  .object({
    scope: EvidenceScopeSchema,
    subject: ReleaseReviewerPublicationSubjectSchema,
    operation: z.literal("manage_reviewer_authority"),
    actor: ReleaseApprovalReviewerReceiptSchema,
    identity: ReleaseDecisionUserIdentityReferenceSchema,
    grantSha256: Sha256Schema,
    credentialSha256: Sha256Schema,
    issuedAt: PolicyEvaluationTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    if (value.actor.principalId !== value.identity.principalId)
      context.addIssue({
        code: "custom",
        message: "Reviewer publication actor must own the original identity",
      });
    if (
      policyEvaluationTimestampOrderKey(value.actor.authenticatedAt) >
      policyEvaluationTimestampOrderKey(value.issuedAt)
    )
      context.addIssue({
        code: "custom",
        message: "Reviewer publication cannot precede original authentication",
      });
    const { scope, subject, operation, actor, identity, grantSha256, credentialSha256, issuedAt } =
      value;
    if (
      encodeEvaluationCanonicalJson({
        scope,
        subject,
        operation,
        actor,
        identity,
        grantSha256,
        credentialSha256,
        issuedAt,
      }).byteLength > MAX_RELEASE_REVIEWER_PUBLICATION_DEFINITION_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "Reviewer publication definition exceeds its canonical UTF-8 ceiling",
      });
  });
export const ReleaseReviewerPublicationSchema =
  ReleaseReviewerPublicationDefinitionSchema.safeExtend({
    schemaVersion: z.literal(RELEASE_REVIEWER_PUBLICATION_SCHEMA_VERSION),
    definitionSha256: Sha256Schema,
  });
const Grant = ReleaseDecisionIdentityGrantSchema.superRefine((value, context) => {
  if (context.issues.length > 0) return;
  if (value.identity.kind !== "oidc_binding")
    context.addIssue({
      code: "custom",
      message: "Reviewer administration requires an actual user identity",
    });
  if (
    encodeEvaluationCanonicalJson(value).byteLength > MAX_RELEASE_REVIEWER_PUBLICATION_GRANT_BYTES
  )
    context.addIssue({
      code: "custom",
      message: "Original reviewer administrator grant exceeds its UTF-8 ceiling",
    });
});
/** Safe original preimages, without cookie, CSRF, secret verifier, basis content or keys. */
export const ReleaseReviewerPublicationMaterialSchema = z
  .object({
    publication: ReleaseReviewerPublicationSchema,
    source: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("release_reviewer_authority"),
          record: ReleaseReviewerAuthoritySchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("release_reviewer_authority_lifecycle"),
          record: ReleaseReviewerAuthorityLifecycleEventSchema,
        })
        .strict(),
    ]),
    grant: Grant,
    credential: ReleaseDecisionSessionStateSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    if (value.publication.subject.kind !== value.source.kind)
      context.addIssue({
        code: "custom",
        message: "Reviewer publication must retain its exact source kind",
      });
    if (
      encodeEvaluationCanonicalJson(value).byteLength >
      MAX_RELEASE_REVIEWER_PUBLICATION_MATERIAL_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "Reviewer publication material exceeds its UTF-8 ceiling",
      });
  });
export type ReleaseReviewerPublicationDefinition = z.infer<
  typeof ReleaseReviewerPublicationDefinitionSchema
>;
export type ReleaseReviewerPublication = z.infer<typeof ReleaseReviewerPublicationSchema>;
export type ReleaseReviewerPublicationMaterial = z.infer<
  typeof ReleaseReviewerPublicationMaterialSchema
>;
