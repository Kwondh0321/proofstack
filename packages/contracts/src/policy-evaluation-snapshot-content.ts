import { z } from "zod";
import { ArtifactMetadataSchema, ArtifactOwnershipSchema, JsonPointerSchema } from "./artifact.js";
import { MAX_FIXTURE_SOURCE_EVENTS, RegressionTraceSnapshotSchema } from "./dataset.js";
import { ContentReferenceSchema, EvidenceScopeSchema } from "./evidence.js";
import { PolicyEvaluationArtifactObservationSchema } from "./policy-evaluation-snapshot-rules.js";
import { MAX_POLICY_EVALUATION_ACQUISITION_RECORDS } from "./policy-evaluation-request.js";
import { PolicyEvaluationSourceReferenceSchema } from "./policy-evaluation-source-reference.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import { serializeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";

const Index = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS - 1);
const Origin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("record"), edgeIndex: Index }).strict(),
  z.object({ kind: z.literal("trace"), artifactReferenceIndex: Index }).strict(),
]);
const Catalog = z
  .object({
    metadata: ArtifactMetadataSchema,
    ownership: ArtifactOwnershipSchema.nullable(),
    recordSha256: Sha256Schema,
  })
  .strict();
export const PolicyEvaluationSnapshotArtifactCatalogSchema = Catalog;
function same(left: unknown, right: unknown) {
  return serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
}

/** Ordered complete-envelope fingerprints only; classified event bodies are not copied. */
export const PolicyEvaluationSnapshotTraceSchema = z
  .object({
    edgeIndex: Index,
    scope: EvidenceScopeSchema,
    selector: RegressionTraceSnapshotSchema,
    observation: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("verified"),
          eventsSha256: Sha256Schema,
          eventSha256: z.array(Sha256Schema).min(1).max(MAX_FIXTURE_SOURCE_EVENTS),
        })
        .strict(),
      z.object({ status: z.literal("missing") }).strict(),
      z
        .object({
          status: z.literal("unavailable"),
          reason: z.enum([
            "record_invalid",
            "reference_mismatch",
            "not_yet_available",
            "snapshot_cut_mismatch",
          ]),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    if (
      value.observation.status === "verified" &&
      value.observation.eventSha256.length !== value.selector.eventIds.length
    )
      context.addIssue({
        code: "custom",
        message: "Trace fingerprints must preserve every original ordered event occurrence",
      });
  });

export const PolicyEvaluationSnapshotTraceArtifactSchema = z
  .object({
    traceCaptureIndex: Index,
    eventId: OpaqueIdSchema,
    eventRecordSha256: Sha256Schema,
    path: JsonPointerSchema,
    reference: ContentReferenceSchema,
  })
  .strict();

/** Authenticated catalog metadata and content outcomes; no plaintext, key or object locator. */
export const PolicyEvaluationSnapshotArtifactSchema = z
  .object({
    origin: Origin,
    scope: EvidenceScopeSchema,
    evaluationTime: PolicyEvaluationTimeSchema,
    reference: ContentReferenceSchema,
    startedAt: PolicyEvaluationTimeSchema,
    completedAt: PolicyEvaluationTimeSchema,
    catalog: Catalog.nullable(),
    observation: PolicyEvaluationArtifactObservationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    const observation = value.observation;
    const retained =
      observation.status === "verified" ||
      (observation.status === "unavailable" &&
        !["reference_unsupported", "record_invalid", "reference_mismatch"].includes(
          observation.reason,
        ));
    if (retained !== (value.catalog !== null))
      issue("Artifact outcome must retain the owning catalog presence boundary");
    if (
      policyEvaluationTimestampOrderKey(value.startedAt) <
        policyEvaluationTimestampOrderKey(value.evaluationTime) ||
      policyEvaluationTimestampOrderKey(value.completedAt) <
        policyEvaluationTimestampOrderKey(value.startedAt)
    )
      issue("Artifact receipts must preserve capture order and semantic cut");
    if (value.catalog) {
      if (
        !same(value.catalog.metadata.scope, value.scope) ||
        !same(value.catalog.metadata.contentReference, value.reference)
      )
        issue("Catalog metadata must bind exact scope and original content descriptor");
      if (
        value.catalog.ownership &&
        (!same(value.catalog.ownership.scope, value.scope) ||
          value.catalog.ownership.artifactId !== value.reference.artifactId)
      )
        issue("Catalog ownership must preserve exact scope and artifact identity");
      if (
        observation.status === "verified" &&
        (value.catalog.metadata.state !== "available" ||
          observation.sha256 !== value.reference.sha256 ||
          observation.sizeBytes !== value.reference.sizeBytes ||
          (value.catalog.metadata.retention.mode === "expire" &&
            policyEvaluationTimestampOrderKey(value.catalog.metadata.retention.expiresAt) <=
              policyEvaluationTimestampOrderKey(value.completedAt)))
      )
        issue("Verified content cannot change its descriptor, lifecycle or exact expiry cut");
    }
  });

export const PolicyEvaluationSnapshotFixtureBindingsSchema = z
  .object({
    source: PolicyEvaluationSourceReferenceSchema.refine(
      (source) => source.kind === "regression_fixture_version",
    ),
    recordSha256: Sha256Schema,
    artifacts: z
      .array(
        z
          .object({
            artifactId: OpaqueIdSchema,
            bindingIndex: Index,
            catalogRecordSha256: Sha256Schema.nullable(),
            artifactCaptureIndexes: z
              .array(Index)
              .min(1)
              .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
            observation: z.discriminatedUnion("status", [
              z.object({ status: z.literal("matched") }).strict(),
              z
                .object({
                  status: z.literal("unavailable"),
                  reason: z.literal("catalog_unavailable"),
                })
                .strict(),
              z
                .object({
                  status: z.literal("mismatch"),
                  reason: z.enum([
                    "scope_mismatch",
                    "descriptor_mismatch",
                    "retention_mismatch",
                    "redaction_mismatch",
                    "publication_time_mismatch",
                    "ownership_missing",
                    "ownership_mismatch",
                  ]),
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const uses = new Set<number>();
    for (const [index, artifact] of value.artifacts.entries()) {
      if (
        artifact.bindingIndex !== index ||
        (artifact.observation.status === "unavailable") !== (artifact.catalogRecordSha256 === null)
      )
        context.addIssue({
          code: "custom",
          message:
            "Fixture bindings must retain complete original positions and catalog observations",
        });
      for (const occurrence of artifact.artifactCaptureIndexes) {
        if (uses.has(occurrence))
          context.addIssue({
            code: "custom",
            message: "Fixture bindings cannot duplicate a content capture coordinate",
          });
        uses.add(occurrence);
      }
    }
  });

export type PolicyEvaluationSnapshotTrace = z.infer<typeof PolicyEvaluationSnapshotTraceSchema>;
export type PolicyEvaluationSnapshotArtifact = z.infer<
  typeof PolicyEvaluationSnapshotArtifactSchema
>;
