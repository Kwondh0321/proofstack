import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { AssuranceRationaleSchema, AssuranceSummarySchema } from "./evaluation-source.js";
import { EvidenceScopeSchema } from "./evidence.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import { MAX_POLICY_APPROVAL_GROUPS, MAX_POLICY_APPROVAL_ROLES } from "./release-policy.js";

export const RELEASE_REVIEWER_AUTHORITY_SCHEMA_VERSION = "0.1" as const;
export const MAX_RELEASE_REVIEWER_AUTHORITY_DEFINITION_BYTES = 64 * 1024;
export const MAX_RELEASE_REVIEWER_AUTHORITY_RESPONSE_BYTES =
  MAX_RELEASE_REVIEWER_AUTHORITY_DEFINITION_BYTES + 4 * 1024;

function ordered(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}
const ids = (maximum: number) =>
  z
    .array(OpaqueIdSchema)
    .min(1)
    .max(maximum)
    .refine(ordered, "Authority memberships must be unique and ordered");
const texts = () =>
  z
    .array(AssuranceSummarySchema)
    .max(32)
    .refine(ordered, "Authority declarations must be unique and ordered");

/** A reference identifies a retained declaration, never a caller's current reviewer power. */
export const ReleaseReviewerAuthorityReferenceSchema = z
  .object({
    authorityId: OpaqueIdSchema,
    authorityVersionId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    installationId: OpaqueIdSchema,
    gateTargetId: OpaqueIdSchema,
    reviewerPrincipalId: OpaqueIdSchema,
  })
  .strict();

const DefinitionShape = {
  authorityId: OpaqueIdSchema,
  authorityVersionId: OpaqueIdSchema,
  scope: EvidenceScopeSchema,
  installationId: OpaqueIdSchema,
  gateTargetId: OpaqueIdSchema,
  reviewerPrincipalId: OpaqueIdSchema,
  issuerPrincipalId: OpaqueIdSchema,
  roleIds: ids(MAX_POLICY_APPROVAL_ROLES),
  independenceGroupIds: ids(MAX_POLICY_APPROVAL_GROUPS),
  reviewerKind: z.literal("human"),
  assurance: z.enum(["operator_verified", "synthetic_reference"]),
  status: z.enum(["verified", "unverifiable", "rejected"]),
  affiliations: texts().min(1),
  relationships: texts(),
  conflicts: texts(),
  statusReasons: texts(),
  reviewBasis: z
    .array(ArtifactContentReferenceSchema)
    .min(1)
    .max(16)
    .refine(
      (values) => ordered(values.map(({ artifactId, sha256 }) => `${artifactId}:${sha256}`)),
      "Reviewer authority basis must be unique and ordered by exact artifact identity",
    ),
  rationale: AssuranceRationaleSchema,
  effectiveAt: PolicyEvaluationTimeSchema,
  expiresAt: PolicyEvaluationTimeSchema,
  predecessor: ReleaseReviewerAuthorityReferenceSchema.optional(),
};
type Definition = z.infer<z.ZodObject<typeof DefinitionShape>>;

function check(value: Definition, context: z.RefinementCtx): void {
  if (context.issues.length > 0) return;
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (value.reviewerPrincipalId === value.issuerPrincipalId)
    issue("A reviewer cannot issue their own reviewer authority");
  if (
    policyEvaluationTimestampOrderKey(value.effectiveAt) >=
    policyEvaluationTimestampOrderKey(value.expiresAt)
  )
    issue("Reviewer authority validity must have a positive exact interval");
  if (value.status === "verified" && (value.conflicts.length > 0 || value.statusReasons.length > 0))
    issue("Verified reviewer authority cannot retain conflicts or unresolved status reasons");
  if (value.status !== "verified" && value.statusReasons.length === 0)
    issue("Unverified reviewer authority requires explicit reasons");
  const previous = value.predecessor;
  if (
    previous &&
    (previous.authorityId !== value.authorityId ||
      previous.installationId !== value.installationId ||
      previous.gateTargetId !== value.gateTargetId ||
      previous.reviewerPrincipalId !== value.reviewerPrincipalId ||
      previous.authorityVersionId === value.authorityVersionId)
  )
    issue("Reviewer authority predecessor must retain its exact logical reviewer target");
  const definition = Object.fromEntries(
    Object.keys(DefinitionShape)
      .filter((key) => value[key as keyof Definition] !== undefined)
      .map((key) => [key, value[key as keyof Definition]]),
  );
  if (
    encodeEvaluationCanonicalJson(JSON.parse(JSON.stringify(definition))).byteLength >
    MAX_RELEASE_REVIEWER_AUTHORITY_DEFINITION_BYTES
  )
    issue("Reviewer authority definition exceeds its canonical UTF-8 byte ceiling");
}

/** A bounded attributable declaration, not proof of expertise or authenticated human action. */
export const ReleaseReviewerAuthorityDefinitionSchema = z
  .object(DefinitionShape)
  .strict()
  .superRefine(check);
export const ReleaseReviewerAuthoritySchema = z
  .object({
    ...DefinitionShape,
    definitionSha256: Sha256Schema,
    schemaVersion: z.literal(RELEASE_REVIEWER_AUTHORITY_SCHEMA_VERSION),
    publishedAt: PolicyEvaluationTimeSchema,
    publishedByPrincipalId: OpaqueIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    check(value, context);
    if (context.issues.length > 0) return;
    if (value.publishedByPrincipalId !== value.issuerPrincipalId)
      context.addIssue({
        code: "custom",
        message: "Reviewer authority publisher must match its issuer",
      });
    if (
      policyEvaluationTimestampOrderKey(value.publishedAt) >=
      policyEvaluationTimestampOrderKey(value.expiresAt)
    )
      context.addIssue({
        code: "custom",
        message: "Expired reviewer authority cannot be published",
      });
  });

const LifecycleShape = {
  eventId: OpaqueIdSchema,
  authority: ReleaseReviewerAuthorityReferenceSchema,
  scope: EvidenceScopeSchema,
  actorPrincipalId: OpaqueIdSchema,
  occurredAt: PolicyEvaluationTimeSchema,
  reason: AssuranceRationaleSchema,
  schemaVersion: z.literal(RELEASE_REVIEWER_AUTHORITY_SCHEMA_VERSION),
};
export const ReleaseReviewerAuthorityLifecycleEventSchema = z
  .discriminatedUnion("kind", [
    z.object({ ...LifecycleShape, kind: z.literal("revoked") }).strict(),
    z
      .object({
        ...LifecycleShape,
        kind: z.literal("superseded"),
        successor: ReleaseReviewerAuthorityReferenceSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.kind !== "superseded") return;
    if (
      value.successor.authorityId !== value.authority.authorityId ||
      value.successor.authorityVersionId === value.authority.authorityVersionId ||
      value.successor.installationId !== value.authority.installationId ||
      value.successor.gateTargetId !== value.authority.gateTargetId ||
      value.successor.reviewerPrincipalId !== value.authority.reviewerPrincipalId
    )
      context.addIssue({
        code: "custom",
        message: "Supersession must retain the exact reviewer authority target and change version",
      });
  });

export type ReleaseReviewerAuthorityDefinition = z.infer<
  typeof ReleaseReviewerAuthorityDefinitionSchema
>;
export type ReleaseReviewerAuthority = z.infer<typeof ReleaseReviewerAuthoritySchema>;
export type ReleaseReviewerAuthorityReference = z.infer<
  typeof ReleaseReviewerAuthorityReferenceSchema
>;
export type ReleaseReviewerAuthorityLifecycleEvent = z.infer<
  typeof ReleaseReviewerAuthorityLifecycleEventSchema
>;
