import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { EvidenceScopeSchema } from "./evidence.js";
import { serializeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { PolicyEvaluationArtifactObservationSchema } from "./policy-evaluation-snapshot-rules.js";
import { PolicyEvaluationSnapshotArtifactCatalogSchema } from "./policy-evaluation-snapshot-content.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import { ReleaseApprovalReferenceSchema } from "./release-approval.js";

const Target = { installationId: OpaqueIdSchema, gateTargetId: OpaqueIdSchema };
export const ReleaseDecisionSelectionRootReferenceSchema = z.object(Target).strict();
export const ReleaseDecisionReviewerRootReferenceSchema = z
  .object({
    ...Target,
    reviewerPrincipalId: OpaqueIdSchema,
  })
  .strict();
export const ReleaseDecisionReviewerCensusReferenceSchema = z
  .object({
    ...Target,
    reviewerPrincipalId: OpaqueIdSchema,
    authorityId: OpaqueIdSchema,
  })
  .strict();

function root<Reference extends z.ZodObject, RecordValue extends z.ZodObject>(
  reference: Reference,
  record: RecordValue,
) {
  return z.discriminatedUnion("state", [
    z
      .object({ state: z.literal("observed"), reference, record, recordSha256: Sha256Schema })
      .strict(),
    z.object({ state: z.enum(["missing", "unavailable"]), reference }).strict(),
    z
      .object({ state: z.literal("invalid"), reference, observedRecordSha256: Sha256Schema })
      .strict(),
  ]);
}
/** Immutable target binding projection, not caller-selected selection or current authorization. */
export const ReleaseDecisionSelectionRootObservationSchema = root(
  ReleaseDecisionSelectionRootReferenceSchema,
  z.object({ ...Target, scope: EvidenceScopeSchema, selectionId: OpaqueIdSchema }).strict(),
);
export const ReleaseDecisionReviewerRootObservationSchema = root(
  ReleaseDecisionReviewerRootReferenceSchema,
  z
    .object({
      ...Target,
      scope: EvidenceScopeSchema,
      reviewerPrincipalId: OpaqueIdSchema,
      authorityId: OpaqueIdSchema,
    })
    .strict(),
);
export const ReleaseDecisionReviewerCensusObservationSchema = z
  .object({
    reference: ReleaseDecisionReviewerCensusReferenceSchema,
    state: z.enum(["complete", "unavailable", "invalid"]),
    binding: ReleaseDecisionReviewerRootObservationSchema,
  })
  .strict();

const same = (a: unknown, b: unknown) =>
  serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
const Catalog = PolicyEvaluationSnapshotArtifactCatalogSchema;
export const ReleaseDecisionControlCatalogObservationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("observed"), record: Catalog }).strict(),
  z.object({ state: z.enum(["missing", "unavailable"]) }).strict(),
  z.object({ state: z.literal("invalid"), observedRecordSha256: Sha256Schema }).strict(),
]);

/** Actual content outcomes and a later native catalog view; no plaintext, key, locator or verified prose. */
export const ReleaseDecisionControlObservationSchema = z
  .object({
    approval: ReleaseApprovalReferenceSchema,
    controlIndex: z.number().int().min(0).max(15),
    scope: EvidenceScopeSchema,
    reference: ArtifactContentReferenceSchema,
    content: z.discriminatedUnion("state", [
      z
        .object({
          state: z.literal("captured"),
          startedAt: PolicyEvaluationTimeSchema,
          completedAt: PolicyEvaluationTimeSchema,
          catalog: Catalog.nullable(),
          observation: PolicyEvaluationArtifactObservationSchema,
        })
        .strict(),
      z
        .object({
          state: z.literal("not_inspected"),
          reason: z.enum([
            "approval_inactive",
            "action_not_approval",
            "authorization_unavailable",
            "acquisition_unavailable",
          ]),
        })
        .strict(),
    ]),
    underGuards: ReleaseDecisionControlCatalogObservationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    const order = policyEvaluationTimestampOrderKey;
    const captured = value.content.state === "captured" ? value.content : null;
    for (const record of [
      captured?.catalog ?? null,
      ...(value.underGuards.state === "observed" ? [value.underGuards.record] : []),
    ]) {
      if (record === null) continue;
      if (
        !same(record.metadata.scope, value.scope) ||
        !same(record.metadata.contentReference, value.reference) ||
        (record.ownership !== null &&
          (!same(record.ownership.scope, value.scope) ||
            record.ownership.artifactId !== value.reference.artifactId))
      )
        issue("Control catalogs must bind exact original scope, content and ownership");
    }
    if (captured === null) return;
    if (order(captured.completedAt) < order(captured.startedAt))
      issue("Control content receipts must preserve exact native capture order");
    const { catalog, observation } = captured;
    const retained =
      observation.status === "verified" ||
      (observation.status === "unavailable" &&
        !["reference_unsupported", "record_invalid", "reference_mismatch"].includes(
          observation.reason,
        ));
    if (retained !== (catalog !== null))
      issue("Control content must retain the owning catalog presence boundary");
    if (
      catalog &&
      observation.status === "verified" &&
      (catalog.metadata.state !== "available" ||
        observation.sha256 !== value.reference.sha256 ||
        observation.sizeBytes !== value.reference.sizeBytes ||
        (catalog.metadata.retention.mode === "expire" &&
          order(catalog.metadata.retention.expiresAt) <= order(captured.completedAt)))
    )
      issue(
        "Verified control bytes must retain exact descriptor, availability and capture-time expiry",
      );
    // Changed/missing/revoked/expired under-guard catalogs remain retained facts for a hold. The
    // owning decision validator must not turn an earlier successful content read into current authority.
  });

export type ReleaseDecisionControlObservation = z.infer<
  typeof ReleaseDecisionControlObservationSchema
>;
export type ReleaseDecisionReviewerCensusObservation = z.infer<
  typeof ReleaseDecisionReviewerCensusObservationSchema
>;
