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
  ReleasePolicySelectionLifecycleEventSchema,
  ReleasePolicySelectionReferenceSchema,
  ReleasePolicySelectionSchema,
} from "./release-policy-selection.js";

export const RELEASE_SELECTION_PUBLICATION_SCHEMA_VERSION = "0.1" as const;
export const MAX_RELEASE_SELECTION_PUBLICATION_DEFINITION_BYTES = 8 * 1024;
export const MAX_RELEASE_SELECTION_PUBLICATION_GRANT_BYTES = 512 * 1024;
export const MAX_RELEASE_SELECTION_PUBLICATION_MATERIAL_BYTES = 1024 * 1024;

export const ReleaseSelectionPublicationSubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("release_policy_selection"),
      selection: ReleasePolicySelectionReferenceSchema,
      recordSha256: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("release_policy_selection_lifecycle"),
      eventId: OpaqueIdSchema,
      selection: ReleasePolicySelectionReferenceSchema,
      recordSha256: Sha256Schema,
    })
    .strict(),
]);

/** Original authentication provenance only, never a cookie, current authority or publication seal. */
export const ReleaseSelectionPublicationDefinitionSchema = z
  .object({
    scope: EvidenceScopeSchema,
    subject: ReleaseSelectionPublicationSubjectSchema,
    operation: z.literal("manage_selection"),
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
        message: "Publication actor must own the original identity",
      });
    if (
      policyEvaluationTimestampOrderKey(value.actor.authenticatedAt) >
      policyEvaluationTimestampOrderKey(value.issuedAt)
    )
      context.addIssue({
        code: "custom",
        message: "Publication cannot precede original authentication",
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
      }).byteLength > MAX_RELEASE_SELECTION_PUBLICATION_DEFINITION_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "Publication definition exceeds its UTF-8 ceiling",
      });
  });

export const ReleaseSelectionPublicationSchema =
  ReleaseSelectionPublicationDefinitionSchema.safeExtend({
    schemaVersion: z.literal(RELEASE_SELECTION_PUBLICATION_SCHEMA_VERSION),
    definitionSha256: Sha256Schema,
  });

const Grant = ReleaseDecisionIdentityGrantSchema.superRefine((value, context) => {
  if (context.issues.length > 0) return;
  if (value.identity.kind !== "oidc_binding")
    context.addIssue({
      code: "custom",
      message: "Selection installation requires an actual user identity",
    });
  if (
    encodeEvaluationCanonicalJson(value).byteLength > MAX_RELEASE_SELECTION_PUBLICATION_GRANT_BYTES
  )
    context.addIssue({
      code: "custom",
      message: "Original installer grant exceeds its UTF-8 ceiling",
    });
});

/** Complete safe preimages are retained separately from the compact public receipt. No secrets. */
export const ReleaseSelectionPublicationMaterialSchema = z
  .object({
    publication: ReleaseSelectionPublicationSchema,
    source: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("release_policy_selection"),
          record: ReleasePolicySelectionSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("release_policy_selection_lifecycle"),
          record: ReleasePolicySelectionLifecycleEventSchema,
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
        message: "Publication must retain its exact original source kind",
      });
    if (
      encodeEvaluationCanonicalJson(value).byteLength >
      MAX_RELEASE_SELECTION_PUBLICATION_MATERIAL_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "Publication material exceeds its UTF-8 ceiling",
      });
  });

export type ReleaseSelectionPublicationSubject = z.infer<
  typeof ReleaseSelectionPublicationSubjectSchema
>;
export type ReleaseSelectionPublicationDefinition = z.infer<
  typeof ReleaseSelectionPublicationDefinitionSchema
>;
export type ReleaseSelectionPublication = z.infer<typeof ReleaseSelectionPublicationSchema>;
export type ReleaseSelectionPublicationMaterial = z.infer<
  typeof ReleaseSelectionPublicationMaterialSchema
>;
