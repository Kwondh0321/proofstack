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
  ReleaseApprovalReferenceSchema,
  ReleaseApprovalSchema,
  ReleaseApprovalRevocationSchema,
} from "./release-approval.js";

export const RELEASE_APPROVAL_PUBLICATION_SCHEMA_VERSION = "0.1" as const;
export const MAX_RELEASE_APPROVAL_PUBLICATION_DEFINITION_BYTES = 8 * 1024;
export const MAX_RELEASE_APPROVAL_PUBLICATION_GRANT_BYTES = 512 * 1024;
export const MAX_RELEASE_APPROVAL_PUBLICATION_MATERIAL_BYTES = 1024 * 1024;

export const ReleaseApprovalPublicationSubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("release_approval"),
      approval: ReleaseApprovalReferenceSchema,
      recordSha256: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("release_approval_revocation"),
      approval: ReleaseApprovalReferenceSchema,
      eventId: OpaqueIdSchema,
      recordSha256: Sha256Schema,
    })
    .strict(),
]);

/** Original user authentication provenance, not expertise, a quorum or current release authority. */
export const ReleaseApprovalPublicationDefinitionSchema = z
  .object({
    scope: EvidenceScopeSchema,
    subject: ReleaseApprovalPublicationSubjectSchema,
    operation: z.literal("record_approval"),
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
        message: "Approval publication actor must own the original identity",
      });
    if (
      policyEvaluationTimestampOrderKey(value.actor.authenticatedAt) >
      policyEvaluationTimestampOrderKey(value.issuedAt)
    )
      context.addIssue({
        code: "custom",
        message: "Approval publication cannot precede original authentication",
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
      }).byteLength > MAX_RELEASE_APPROVAL_PUBLICATION_DEFINITION_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "Approval publication definition exceeds its canonical UTF-8 ceiling",
      });
  });
export const ReleaseApprovalPublicationSchema =
  ReleaseApprovalPublicationDefinitionSchema.safeExtend({
    schemaVersion: z.literal(RELEASE_APPROVAL_PUBLICATION_SCHEMA_VERSION),
    definitionSha256: Sha256Schema,
  });
const Grant = ReleaseDecisionIdentityGrantSchema.superRefine((value, context) => {
  if (context.issues.length > 0) return;
  if (value.identity.kind !== "oidc_binding")
    context.addIssue({
      code: "custom",
      message: "Approval publication requires an actual user identity",
    });
  if (
    encodeEvaluationCanonicalJson(value).byteLength > MAX_RELEASE_APPROVAL_PUBLICATION_GRANT_BYTES
  )
    context.addIssue({
      code: "custom",
      message: "Original approval reviewer grant exceeds its UTF-8 ceiling",
    });
});
/** Safe original preimages, without cookie, CSRF, secret verifier, artifact content or keys. */
export const ReleaseApprovalPublicationMaterialSchema = z
  .object({
    publication: ReleaseApprovalPublicationSchema,
    source: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("release_approval"),
          record: ReleaseApprovalSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("release_approval_revocation"),
          record: ReleaseApprovalRevocationSchema,
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
        message: "Approval publication must retain its exact source kind",
      });
    if (
      encodeEvaluationCanonicalJson(value).byteLength >
      MAX_RELEASE_APPROVAL_PUBLICATION_MATERIAL_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "Approval publication material exceeds its UTF-8 ceiling",
      });
  });
export type ReleaseApprovalPublicationDefinition = z.infer<
  typeof ReleaseApprovalPublicationDefinitionSchema
>;
export type ReleaseApprovalPublication = z.infer<typeof ReleaseApprovalPublicationSchema>;
export type ReleaseApprovalPublicationMaterial = z.infer<
  typeof ReleaseApprovalPublicationMaterialSchema
>;
