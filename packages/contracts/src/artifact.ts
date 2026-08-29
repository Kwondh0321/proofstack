import { z } from "zod";
import { ContentReferenceSchema, EvidenceScopeSchema, RedactionStageSchema } from "./evidence.js";
import {
  OpaqueIdSchema,
  Sha256Schema,
  TimestampSchema,
  UtcMillisecondTimestampSchema,
} from "./primitives.js";

export const ARTIFACT_SCHEMA_VERSION = "0.1" as const;
export const ARTIFACT_OWNERSHIP_SCHEMA_VERSION = "0.1" as const;
export const MAX_ARTIFACT_CONTENT_BYTES = 16 * 1024 * 1024;
export const MAX_ARTIFACT_REDACTION_PATHS = 128;
export const MAX_ARTIFACT_REDACTION_RECORDS = 16;
export const MAX_ARTIFACT_TOMBSTONE_REASON_LENGTH = 512;

function hasNoControlCharacters(value: string): boolean {
  return !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

export const ArtifactMediaTypeSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/);

export const JsonPointerSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^(?:\/(?:[^~/]|~[01])*)+$/)
  .refine(hasNoControlCharacters, { message: "JSON Pointers cannot contain control characters" });

const uniqueValues = (values: readonly string[]): boolean => new Set(values).size === values.length;

export const ArtifactRedactionRecordSchema = z
  .object({
    changedPaths: z
      .array(JsonPointerSchema)
      .max(MAX_ARTIFACT_REDACTION_PATHS)
      .refine(uniqueValues, { message: "changedPaths must not contain duplicates" }),
    matchCount: z.number().int().positive().max(1_000_000),
    rulesetId: OpaqueIdSchema,
    rulesetVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
    stage: RedactionStageSchema,
  })
  .strict();

const RedactionRecordsSchema = z
  .array(ArtifactRedactionRecordSchema)
  .min(1)
  .max(MAX_ARTIFACT_REDACTION_RECORDS)
  .superRefine((records, context) => {
    const identities = records.map(
      ({ rulesetId, rulesetVersion, stage }) => `${stage}:${rulesetId}:${rulesetVersion}`,
    );
    if (!uniqueValues(identities)) {
      context.addIssue({
        code: "custom",
        message: "redaction records must have unique stage and ruleset versions",
      });
    }

    const rank = { ingest: 1, retention: 2, source: 0 } as const;
    for (let index = 1; index < records.length; index += 1) {
      const previous = records[index - 1];
      const current = records[index];
      if (previous && current && rank[current.stage] < rank[previous.stage]) {
        context.addIssue({
          code: "custom",
          message: "redaction records must be ordered by processing stage",
          path: [index, "stage"],
        });
      }
    }
  });

export const ArtifactRedactionSummarySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_performed") }).strict(),
  z.object({ status: z.literal("not_required") }).strict(),
  z
    .object({
      records: RedactionRecordsSchema,
      status: z.literal("applied"),
    })
    .strict(),
]);

export const ArtifactRetentionPlanSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("retain") }).strict(),
  z
    .object({
      expiresAt: TimestampSchema,
      mode: z.literal("expire"),
    })
    .strict(),
]);

export const ArtifactStateSchema = z.enum(["reserved", "available", "tombstoned", "purged"]);

export const ArtifactOwnershipTargetSchema = z
  .object({
    fixtureId: OpaqueIdSchema,
    fixtureVersionId: OpaqueIdSchema,
    kind: z.literal("regression_fixture_version"),
  })
  .strict();

/**
 * Append-only server provenance for one fixture-owned artifact.
 *
 * The immutable fixture definition separately binds the protected content descriptor and semantic
 * role. This record only establishes exclusive catalog ownership and intentionally excludes object
 * locators, wrapped keys, receipts, and plaintext.
 */
export const ArtifactOwnershipSchema = z
  .object({
    artifactId: OpaqueIdSchema,
    boundAt: UtcMillisecondTimestampSchema,
    boundByPrincipalId: OpaqueIdSchema,
    owner: ArtifactOwnershipTargetSchema,
    schemaVersion: z.literal(ARTIFACT_OWNERSHIP_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict();

export const ArtifactContentReferenceSchema = ContentReferenceSchema.extend({
  mediaType: ArtifactMediaTypeSchema,
  sizeBytes: z.number().int().positive().max(MAX_ARTIFACT_CONTENT_BYTES),
}).strict();

export const ReserveArtifactRequestSchema = z
  .object({
    artifactId: OpaqueIdSchema,
    classification: ContentReferenceSchema.shape.classification,
    mediaType: ArtifactMediaTypeSchema,
    redaction: ArtifactRedactionSummarySchema,
    retention: ArtifactRetentionPlanSchema,
    sha256: Sha256Schema,
    sizeBytes: z.number().int().positive().max(MAX_ARTIFACT_CONTENT_BYTES),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.redaction.status === "applied" &&
      value.redaction.records.some(({ stage }) => stage !== "source")
    ) {
      context.addIssue({
        code: "custom",
        message: "Public reservations may attest only to source-stage redaction",
        path: ["redaction", "records"],
      });
    }
  });

export const ArtifactMetadataSchema = z
  .object({
    availableAt: TimestampSchema.optional(),
    contentReference: ArtifactContentReferenceSchema,
    createdAt: TimestampSchema,
    purgedAt: TimestampSchema.optional(),
    redaction: ArtifactRedactionSummarySchema,
    retention: ArtifactRetentionPlanSchema,
    schemaVersion: z.literal(ARTIFACT_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
    state: ArtifactStateSchema,
    tombstonedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasAvailableAt = value.availableAt !== undefined;
    const hasTombstonedAt = value.tombstonedAt !== undefined;
    const hasPurgedAt = value.purgedAt !== undefined;

    if (value.state === "reserved" && (hasAvailableAt || hasTombstonedAt || hasPurgedAt)) {
      context.addIssue({
        code: "custom",
        message: "Reserved artifacts cannot have later timestamps",
      });
    }
    if (value.state === "available" && (!hasAvailableAt || hasTombstonedAt || hasPurgedAt)) {
      context.addIssue({
        code: "custom",
        message: "Available artifacts require only an availableAt lifecycle timestamp",
      });
    }
    if (value.state === "tombstoned" && (!hasTombstonedAt || hasPurgedAt)) {
      context.addIssue({
        code: "custom",
        message: "Tombstoned artifacts require tombstonedAt and cannot have purgedAt",
      });
    }
    if (value.state === "purged" && (!hasTombstonedAt || !hasPurgedAt)) {
      context.addIssue({
        code: "custom",
        message: "Purged artifacts require tombstonedAt and purgedAt",
      });
    }

    const lifecycle = [
      ["createdAt", value.createdAt],
      ["availableAt", value.availableAt],
      ["tombstonedAt", value.tombstonedAt],
      ["purgedAt", value.purgedAt],
    ] as const;
    let previous: { readonly name: string; readonly value: string } | undefined;
    for (const [name, timestamp] of lifecycle) {
      if (!timestamp) continue;
      if (previous && Date.parse(timestamp) < Date.parse(previous.value)) {
        context.addIssue({
          code: "custom",
          message: `${name} cannot be earlier than ${previous.name}`,
          path: [name],
        });
      }
      previous = { name, value: timestamp };
    }

    const latestRedactionStage =
      value.redaction.status === "applied" ? value.redaction.records.at(-1)?.stage : undefined;
    if (value.contentReference.redactedAt !== latestRedactionStage) {
      context.addIssue({
        code: "custom",
        message: "contentReference.redactedAt must equal the latest recorded redaction stage",
        path: ["contentReference", "redactedAt"],
      });
    }
  });

export const ArtifactTombstoneTriggerSchema = z.enum([
  "manual",
  "retention",
  "abandoned",
  "fixture_revocation",
]);

export const ArtifactTombstoneReasonSchema = z
  .string()
  .min(1)
  .max(MAX_ARTIFACT_TOMBSTONE_REASON_LENGTH)
  .refine((value) => value.trim() === value && value.length > 0, {
    message: "Tombstone reason must not have surrounding whitespace",
  })
  .refine(hasNoControlCharacters, {
    message: "Tombstone reason cannot contain control characters",
  });

export const TombstoneArtifactRequestSchema = z
  .object({ reason: ArtifactTombstoneReasonSchema })
  .strict();

export const ArtifactTombstoneSchema = z
  .object({
    actorPrincipalId: OpaqueIdSchema,
    artifactId: OpaqueIdSchema,
    occurredAt: TimestampSchema,
    reason: ArtifactTombstoneReasonSchema,
    tombstoneId: OpaqueIdSchema,
    trigger: ArtifactTombstoneTriggerSchema,
  })
  .strict();

export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;
export type ArtifactOwnership = z.infer<typeof ArtifactOwnershipSchema>;
export type ArtifactOwnershipTarget = z.infer<typeof ArtifactOwnershipTargetSchema>;
export type ArtifactRedactionRecord = z.infer<typeof ArtifactRedactionRecordSchema>;
export type ArtifactRedactionSummary = z.infer<typeof ArtifactRedactionSummarySchema>;
export type ArtifactRetentionPlan = z.infer<typeof ArtifactRetentionPlanSchema>;
export type ArtifactState = z.infer<typeof ArtifactStateSchema>;
export type ArtifactTombstone = z.infer<typeof ArtifactTombstoneSchema>;
export type ArtifactTombstoneTrigger = z.infer<typeof ArtifactTombstoneTriggerSchema>;
export type ReserveArtifactRequest = z.infer<typeof ReserveArtifactRequestSchema>;
export type TombstoneArtifactRequest = z.infer<typeof TombstoneArtifactRequestSchema>;
