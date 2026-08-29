import { z } from "zod";
import {
  ArtifactMetadataSchema,
  ArtifactOwnershipSchema,
  ArtifactTombstoneSchema,
  MAX_ARTIFACT_CONTENT_BYTES,
} from "./artifact.js";
import {
  InteractionFixtureContentAvailabilitySchema,
  InteractionFixtureContentRevocationSchema,
  RecordedInteractionFixtureVersionSchema,
} from "./dataset.js";
import { InteractionArtifactBindingSchema, MAX_CAPTURE_ARTIFACTS } from "./interaction.js";
import { OpaqueIdSchema, UtcMillisecondTimestampSchema } from "./primitives.js";

export const INTERACTION_FIXTURE_EXPORT_SCHEMA_VERSION = "0.1" as const;
export const ARTIFACT_PURGE_RECEIPT_EXPORT_SCHEMA_VERSION = "0.1" as const;
export const MAX_INTERACTION_CONTENT_EXPORT_BYTES = MAX_ARTIFACT_CONTENT_BYTES;

export const ArtifactPurgeReceiptExportSchema = z
  .object({
    artifactId: OpaqueIdSchema,
    objectWasPresent: z.boolean(),
    occurredAt: UtcMillisecondTimestampSchema,
    purgeId: OpaqueIdSchema,
    schemaVersion: z.literal(ARTIFACT_PURGE_RECEIPT_EXPORT_SCHEMA_VERSION),
  })
  .strict();

const MetadataExportArtifactAvailableSchema = z
  .object({
    binding: InteractionArtifactBindingSchema,
    lifecycleStatus: z.literal("available"),
    metadata: ArtifactMetadataSchema,
    ownership: ArtifactOwnershipSchema,
    purgeReceipt: z.null(),
    tombstone: z.null(),
  })
  .strict();

const MetadataExportArtifactUnavailableSchema = z
  .object({
    binding: InteractionArtifactBindingSchema,
    lifecycleStatus: z.literal("unavailable"),
    metadata: ArtifactMetadataSchema.nullable(),
    ownership: ArtifactOwnershipSchema,
    purgeReceipt: z.null(),
    tombstone: z.null(),
  })
  .strict();

const MetadataExportArtifactRevokedSchema = z
  .object({
    binding: InteractionArtifactBindingSchema,
    lifecycleStatus: z.literal("revoked"),
    metadata: ArtifactMetadataSchema,
    ownership: ArtifactOwnershipSchema,
    purgeReceipt: z.null(),
    tombstone: ArtifactTombstoneSchema,
  })
  .strict();

const MetadataExportArtifactPurgedSchema = z
  .object({
    binding: InteractionArtifactBindingSchema,
    lifecycleStatus: z.literal("purged"),
    metadata: ArtifactMetadataSchema,
    ownership: ArtifactOwnershipSchema,
    purgeReceipt: ArtifactPurgeReceiptExportSchema,
    tombstone: ArtifactTombstoneSchema,
  })
  .strict();

function sameScope(
  left: { readonly tenantId: string; readonly projectId: string; readonly environmentId: string },
  right: { readonly tenantId: string; readonly projectId: string; readonly environmentId: string },
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function sameStructuredValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export const RecordedInteractionFixtureMetadataExportArtifactSchema = z
  .discriminatedUnion("lifecycleStatus", [
    MetadataExportArtifactAvailableSchema,
    MetadataExportArtifactUnavailableSchema,
    MetadataExportArtifactRevokedSchema,
    MetadataExportArtifactPurgedSchema,
  ])
  .superRefine((value, context) => {
    const artifactId = value.binding.contentReference.artifactId;
    if (value.ownership.artifactId !== artifactId) {
      context.addIssue({
        code: "custom",
        message: "ownership must identify the exported artifact",
        path: ["ownership", "artifactId"],
      });
    }
    if (value.metadata !== null) {
      if (
        !sameStructuredValue(value.metadata.contentReference, value.binding.contentReference) ||
        !sameStructuredValue(value.metadata.redaction, value.binding.redaction) ||
        !sameStructuredValue(value.metadata.retention, value.binding.retention)
      ) {
        context.addIssue({
          code: "custom",
          message: "catalog metadata must preserve the immutable artifact binding",
          path: ["metadata"],
        });
      }
      if (!sameScope(value.metadata.scope, value.ownership.scope)) {
        context.addIssue({
          code: "custom",
          message: "artifact metadata and ownership scopes must match",
          path: ["ownership", "scope"],
        });
      }
    }

    const expectedState = {
      available: "available",
      purged: "purged",
      revoked: "tombstoned",
      unavailable: "reserved",
    } as const;
    if (value.metadata !== null && value.metadata.state !== expectedState[value.lifecycleStatus]) {
      context.addIssue({
        code: "custom",
        message: "artifact lifecycle status must match catalog metadata",
        path: ["lifecycleStatus"],
      });
    }

    if (value.lifecycleStatus === "revoked" || value.lifecycleStatus === "purged") {
      if (
        value.tombstone.artifactId !== artifactId ||
        value.tombstone.trigger !== "fixture_revocation" ||
        value.metadata.tombstonedAt !== value.tombstone.occurredAt
      ) {
        context.addIssue({
          code: "custom",
          message: "revoked artifact metadata must match its fixture tombstone",
          path: ["tombstone"],
        });
      }
    }
    if (
      value.lifecycleStatus === "purged" &&
      (value.purgeReceipt.artifactId !== artifactId ||
        value.metadata.purgedAt !== value.purgeReceipt.occurredAt ||
        value.purgeReceipt.occurredAt < value.tombstone.occurredAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "purged artifact metadata must match its ordered purge receipt",
        path: ["purgeReceipt"],
      });
    }
  });

const MetadataExportArtifactsSchema = z
  .array(RecordedInteractionFixtureMetadataExportArtifactSchema)
  .min(1)
  .max(MAX_CAPTURE_ARTIFACTS);

const MetadataExportShape = {
  artifacts: MetadataExportArtifactsSchema,
  contentAvailability: InteractionFixtureContentAvailabilitySchema,
  mode: z.literal("metadata"),
  revocation: InteractionFixtureContentRevocationSchema.nullable(),
  schemaVersion: z.literal(INTERACTION_FIXTURE_EXPORT_SCHEMA_VERSION),
  version: RecordedInteractionFixtureVersionSchema,
};

function refineFixtureExport(
  value: {
    readonly artifacts: readonly z.infer<
      typeof RecordedInteractionFixtureMetadataExportArtifactSchema
    >[];
    readonly contentAvailability: z.infer<typeof InteractionFixtureContentAvailabilitySchema>;
    readonly revocation: z.infer<typeof InteractionFixtureContentRevocationSchema> | null;
    readonly version: z.infer<typeof RecordedInteractionFixtureVersionSchema>;
  },
  context: z.RefinementCtx,
): void {
  const bindings = value.version.interactionCapture.artifacts;
  if (value.artifacts.length !== bindings.length) {
    context.addIssue({
      code: "custom",
      message: "export artifacts must cover every fixture artifact exactly once",
      path: ["artifacts"],
    });
    return;
  }

  for (const [index, artifact] of value.artifacts.entries()) {
    const binding = bindings[index];
    if (
      !binding ||
      !sameStructuredValue(artifact.binding, binding) ||
      artifact.ownership.boundAt !== value.version.createdAt ||
      artifact.ownership.boundByPrincipalId !== value.version.createdByPrincipalId ||
      artifact.ownership.owner.fixtureId !== value.version.fixtureId ||
      artifact.ownership.owner.fixtureVersionId !== value.version.fixtureVersionId ||
      !sameScope(artifact.ownership.scope, value.version.scope)
    ) {
      context.addIssue({
        code: "custom",
        message: "export artifact provenance must match the immutable fixture definition",
        path: ["artifacts", index],
      });
    }
  }

  if (value.contentAvailability === "revoked") {
    if (
      value.revocation === null ||
      value.revocation.fixtureId !== value.version.fixtureId ||
      value.revocation.fixtureVersionId !== value.version.fixtureVersionId ||
      !sameScope(value.revocation.scope, value.version.scope) ||
      value.artifacts.some(
        ({ lifecycleStatus }) => lifecycleStatus !== "revoked" && lifecycleStatus !== "purged",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "revoked exports require matching revocation state for every artifact",
        path: ["revocation"],
      });
      return;
    }
    for (const [index, artifact] of value.artifacts.entries()) {
      if (
        (artifact.lifecycleStatus === "revoked" || artifact.lifecycleStatus === "purged") &&
        (artifact.tombstone.actorPrincipalId !== value.revocation.revokedByPrincipalId ||
          artifact.tombstone.occurredAt !== value.revocation.revokedAt ||
          artifact.tombstone.reason !== value.revocation.reason)
      ) {
        context.addIssue({
          code: "custom",
          message: "artifact tombstone must match the fixture revocation",
          path: ["artifacts", index, "tombstone"],
        });
      }
    }
    return;
  }

  if (value.revocation !== null) {
    context.addIssue({
      code: "custom",
      message: "non-revoked exports cannot carry a revocation",
      path: ["revocation"],
    });
  }
  const allowedStatus = value.contentAvailability === "available" ? "available" : "unavailable";
  const hasUnavailable = value.artifacts.some(
    ({ lifecycleStatus }) => lifecycleStatus === "unavailable",
  );
  if (
    value.artifacts.some(
      ({ lifecycleStatus }) => lifecycleStatus !== "available" && lifecycleStatus !== "unavailable",
    ) ||
    (allowedStatus === "available" && hasUnavailable) ||
    (allowedStatus === "unavailable" && !hasUnavailable)
  ) {
    context.addIssue({
      code: "custom",
      message: "fixture availability must match every artifact lifecycle",
      path: ["contentAvailability"],
    });
  }
}

export const RecordedInteractionFixtureMetadataExportSchema = z
  .object(MetadataExportShape)
  .strict()
  .superRefine(refineFixtureExport);

export const ExportRecordedInteractionFixtureContentRequestSchema = z
  .object({ acknowledgeSensitiveContent: z.literal(true) })
  .strict();

const Base64UrlArtifactContentSchema = z
  .string()
  .min(2)
  .max(Math.ceil((MAX_ARTIFACT_CONTENT_BYTES * 4) / 3))
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine(
    (value) => {
      const remainder = value.length % 4;
      if (remainder === 1) return false;
      const lastIndex = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(
        value.at(-1) ?? "",
      );
      return remainder === 2 ? lastIndex % 16 === 0 : remainder !== 3 || lastIndex % 4 === 0;
    },
    {
      message: "base64url content must have a canonical unpadded length",
    },
  );

const ExportedArtifactContentSchema = z.discriminatedUnion("status", [
  z
    .object({
      bytes: Base64UrlArtifactContentSchema,
      encoding: z.literal("base64url"),
      status: z.literal("available"),
    })
    .strict(),
  z.object({ status: z.literal("missing") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
  z.object({ status: z.literal("revoked") }).strict(),
  z.object({ status: z.literal("purged") }).strict(),
]);

function decodedBase64UrlSize(value: string): number {
  const remainder = value.length % 4;
  return Math.floor(value.length / 4) * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
}

export const RecordedInteractionFixtureContentExportArtifactSchema = z
  .object({
    artifact: RecordedInteractionFixtureMetadataExportArtifactSchema,
    content: ExportedArtifactContentSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.content.status === "available" &&
      (value.artifact.lifecycleStatus !== "available" ||
        decodedBase64UrlSize(value.content.bytes) !==
          value.artifact.binding.contentReference.sizeBytes)
    ) {
      context.addIssue({
        code: "custom",
        message: "available content must match an available artifact and its declared byte size",
        path: ["content"],
      });
    }
    const statusMatchesLifecycle =
      (value.artifact.lifecycleStatus === "available" &&
        (value.content.status === "available" ||
          value.content.status === "missing" ||
          value.content.status === "unavailable")) ||
      (value.artifact.lifecycleStatus === "unavailable" &&
        value.content.status === "unavailable") ||
      (value.artifact.lifecycleStatus === "revoked" && value.content.status === "revoked") ||
      (value.artifact.lifecycleStatus === "purged" && value.content.status === "purged");
    if (!statusMatchesLifecycle) {
      context.addIssue({
        code: "custom",
        message: "content status must match the artifact lifecycle",
        path: ["content", "status"],
      });
    }
  });

const ContentExportArtifactsSchema = z
  .array(RecordedInteractionFixtureContentExportArtifactSchema)
  .min(1)
  .max(MAX_CAPTURE_ARTIFACTS);

export const RecordedInteractionFixtureContentExportSchema = z
  .object({
    artifacts: ContentExportArtifactsSchema,
    contentAvailability: InteractionFixtureContentAvailabilitySchema,
    mode: z.literal("content"),
    revocation: InteractionFixtureContentRevocationSchema.nullable(),
    schemaVersion: z.literal(INTERACTION_FIXTURE_EXPORT_SCHEMA_VERSION),
    version: RecordedInteractionFixtureVersionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    refineFixtureExport(
      { ...value, artifacts: value.artifacts.map(({ artifact }) => artifact) },
      context,
    );
    let totalBytes = 0;
    for (const item of value.artifacts) {
      if (item.content.status === "available") {
        totalBytes += decodedBase64UrlSize(item.content.bytes);
      }
    }
    if (totalBytes > MAX_INTERACTION_CONTENT_EXPORT_BYTES) {
      context.addIssue({
        code: "custom",
        message: "content export exceeds the aggregate byte limit",
        path: ["artifacts"],
      });
    }
  });

export type ArtifactPurgeReceiptExport = z.infer<typeof ArtifactPurgeReceiptExportSchema>;
export type ExportRecordedInteractionFixtureContentRequest = z.infer<
  typeof ExportRecordedInteractionFixtureContentRequestSchema
>;
export type RecordedInteractionFixtureContentExport = z.infer<
  typeof RecordedInteractionFixtureContentExportSchema
>;
export type RecordedInteractionFixtureContentExportArtifact = z.infer<
  typeof RecordedInteractionFixtureContentExportArtifactSchema
>;
export type RecordedInteractionFixtureMetadataExport = z.infer<
  typeof RecordedInteractionFixtureMetadataExportSchema
>;
export type RecordedInteractionFixtureMetadataExportArtifact = z.infer<
  typeof RecordedInteractionFixtureMetadataExportArtifactSchema
>;
