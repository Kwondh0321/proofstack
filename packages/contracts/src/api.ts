import { z } from "zod";
import {
  ArtifactMetadataSchema,
  ArtifactOwnershipSchema,
  ArtifactTombstoneSchema,
} from "./artifact.js";
import {
  InteractionFixtureContentAvailabilitySchema,
  InteractionFixtureContentRevocationSchema,
  RecordedInteractionFixtureVersionSchema,
  RegressionDatasetVersionSchema,
  RegressionFixtureVersionSchema,
} from "./dataset.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EvidenceEnvelopeSchema,
  MAX_EVIDENCE_BATCH_SIZE,
} from "./evidence.js";
import { PrincipalContextSchema } from "./identity.js";
import { MAX_CAPTURE_ARTIFACTS } from "./interaction.js";
import {
  RecordedInteractionFixtureContentExportSchema,
  RecordedInteractionFixtureMetadataExportSchema,
} from "./interaction-export.js";
import { OpaqueIdSchema, TraceIdSchema } from "./primitives.js";
import { ReplayJobSnapshotSchema } from "./replay-job-snapshot.js";
import { ReplayPlanSchema, TargetReleaseSchema } from "./replay-plan.js";

export const RequestIdSchema = z.string().min(1).max(128);
export const DEFAULT_TRACE_PAGE_SIZE = 100;
export const MAX_TRACE_PAGE_SIZE = 200;
export const TracePageCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);
export const BrowserReturnPathSchema = z
  .string()
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Local redirects must reject every ASCII control character.
  .regex(/^\/(?!\/)[^\\\u0000-\u001f\u007f]{0,1023}$/);
export const OidcStateSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const BrowserLoginQuerySchema = z
  .object({ returnTo: BrowserReturnPathSchema.default("/") })
  .strict();
export const OidcCallbackQuerySchema = z.object({ state: OidcStateSchema }).passthrough();

export const LivenessResponseSchema = z.object({ status: z.literal("ok") }).strict();
export const ReadinessResponseSchema = z.object({ status: z.literal("ready") }).strict();

export const BrowserSessionResponseSchema = z
  .object({
    principal: PrincipalContextSchema,
    requestId: RequestIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.principal.requestId !== value.requestId) {
      context.addIssue({
        code: "custom",
        message: "principal.requestId must match requestId",
        path: ["principal", "requestId"],
      });
    }
  });

export const BrowserLogoutResponseSchema = z
  .object({
    requestId: RequestIdSchema,
    revoked: z.boolean(),
  })
  .strict();

export const IngestEvidenceResponseSchema = z
  .object({
    acceptedEventIds: z.array(OpaqueIdSchema).max(MAX_EVIDENCE_BATCH_SIZE),
    duplicateEventIds: z.array(OpaqueIdSchema).max(MAX_EVIDENCE_BATCH_SIZE),
    requestId: RequestIdSchema,
    schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((value, context) => {
    const acknowledgedEventIds = [...value.acceptedEventIds, ...value.duplicateEventIds];
    if (acknowledgedEventIds.length === 0) {
      context.addIssue({
        code: "custom",
        message: "At least one eventId must be acknowledged",
        path: ["acceptedEventIds"],
      });
    }
    if (new Set(acknowledgedEventIds).size !== acknowledgedEventIds.length) {
      context.addIssue({
        code: "custom",
        message: "Acknowledged eventIds must be unique across result sets",
        path: ["acceptedEventIds"],
      });
    }
  });

export const TraceResponseSchema = z
  .object({
    events: z.array(EvidenceEnvelopeSchema).min(1).max(MAX_TRACE_PAGE_SIZE),
    nextCursor: TracePageCursorSchema.optional(),
    requestId: RequestIdSchema,
    schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
    traceId: TraceIdSchema,
  })
  .strict();

export const PublishRegressionFixtureVersionResponseSchema = z
  .object({
    created: z.boolean(),
    requestId: RequestIdSchema,
    version: RegressionFixtureVersionSchema,
  })
  .strict();

export const ReadRegressionFixtureVersionResponseSchema = z
  .object({
    requestId: RequestIdSchema,
    version: RegressionFixtureVersionSchema,
  })
  .strict();

export const PublishRegressionDatasetVersionResponseSchema = z
  .object({
    created: z.boolean(),
    requestId: RequestIdSchema,
    version: RegressionDatasetVersionSchema,
  })
  .strict();

export const ReadRegressionDatasetVersionResponseSchema = z
  .object({
    requestId: RequestIdSchema,
    version: RegressionDatasetVersionSchema,
  })
  .strict();

export const PublishTargetReleaseResponseSchema = z
  .object({
    created: z.boolean(),
    release: TargetReleaseSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const ReadTargetReleaseResponseSchema = z
  .object({
    release: TargetReleaseSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const PublishReplayPlanResponseSchema = z
  .object({
    created: z.boolean(),
    plan: ReplayPlanSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const ReadReplayPlanResponseSchema = z
  .object({
    plan: ReplayPlanSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const CreateReplayJobResponseSchema = z
  .object({
    created: z.boolean(),
    requestId: RequestIdSchema,
    snapshot: ReplayJobSnapshotSchema,
  })
  .strict();

export const ReadReplayJobResponseSchema = z
  .object({
    requestId: RequestIdSchema,
    snapshot: ReplayJobSnapshotSchema,
  })
  .strict();

export const RequestReplayCancellationResponseSchema = z
  .object({
    created: z.boolean(),
    requestId: RequestIdSchema,
    snapshot: ReplayJobSnapshotSchema,
  })
  .strict();

export const ReserveArtifactResponseSchema = z
  .object({
    created: z.boolean(),
    metadata: ArtifactMetadataSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const UploadArtifactResponseSchema = z
  .object({ metadata: ArtifactMetadataSchema, requestId: RequestIdSchema })
  .strict();

export const ReadArtifactMetadataResponseSchema = z
  .object({
    metadata: ArtifactMetadataSchema,
    ownership: ArtifactOwnershipSchema.optional(),
    requestId: RequestIdSchema,
  })
  .strict();

export const TombstoneArtifactResponseSchema = z
  .object({
    created: z.boolean(),
    metadata: ArtifactMetadataSchema,
    requestId: RequestIdSchema,
    tombstone: ArtifactTombstoneSchema,
  })
  .strict();

export const PurgeArtifactResponseSchema = z
  .object({ metadata: ArtifactMetadataSchema, requestId: RequestIdSchema })
  .strict();

const StoredInteractionFixtureContentSchema = z
  .object({
    contentAvailability: InteractionFixtureContentAvailabilitySchema,
    ownerships: z.array(ArtifactOwnershipSchema).min(1).max(MAX_CAPTURE_ARTIFACTS),
    revocation: InteractionFixtureContentRevocationSchema.nullable(),
    tombstones: z.array(ArtifactTombstoneSchema).max(MAX_CAPTURE_ARTIFACTS),
    version: RecordedInteractionFixtureVersionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ownerships.length !== value.version.interactionCapture.artifacts.length) {
      context.addIssue({
        code: "custom",
        message: "ownerships must cover every recorded artifact exactly once",
        path: ["ownerships"],
      });
    }
    for (const [index, ownership] of value.ownerships.entries()) {
      const artifact = value.version.interactionCapture.artifacts[index];
      if (
        !artifact ||
        ownership.artifactId !== artifact.contentReference.artifactId ||
        ownership.boundAt !== value.version.createdAt ||
        ownership.boundByPrincipalId !== value.version.createdByPrincipalId ||
        ownership.owner.fixtureId !== value.version.fixtureId ||
        ownership.owner.fixtureVersionId !== value.version.fixtureVersionId ||
        ownership.scope.tenantId !== value.version.scope.tenantId ||
        ownership.scope.projectId !== value.version.scope.projectId ||
        ownership.scope.environmentId !== value.version.scope.environmentId
      ) {
        context.addIssue({
          code: "custom",
          message: "ownership does not match the recorded fixture artifact",
          path: ["ownerships", index],
        });
      }
    }
    if (value.contentAvailability === "revoked") {
      if (!value.revocation || value.tombstones.length !== value.ownerships.length) {
        context.addIssue({
          code: "custom",
          message: "revoked content requires one revocation and one tombstone per artifact",
          path: ["revocation"],
        });
      }
    } else if (value.revocation !== null || value.tombstones.length !== 0) {
      context.addIssue({
        code: "custom",
        message: "non-revoked content cannot expose revocation records",
        path: ["revocation"],
      });
    }
  });

export const PublishRecordedInteractionFixtureVersionResponseSchema = z
  .object({
    created: z.boolean(),
    ownerships: StoredInteractionFixtureContentSchema.shape.ownerships,
    requestId: RequestIdSchema,
    version: RecordedInteractionFixtureVersionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const parsed = StoredInteractionFixtureContentSchema.safeParse({
      contentAvailability: "available",
      ownerships: value.ownerships,
      revocation: null,
      tombstones: [],
      version: value.version,
    });
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        message: "published ownership does not match the recorded fixture",
        path: ["ownerships"],
      });
    }
  });

export const ReadRecordedInteractionFixtureMetadataResponseSchema = z
  .object({
    requestId: RequestIdSchema,
    ...StoredInteractionFixtureContentSchema.shape,
  })
  .strict()
  .superRefine((value, context) => {
    const { requestId: _requestId, ...content } = value;
    const parsed = StoredInteractionFixtureContentSchema.safeParse(content);
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        message: "stored interaction fixture metadata is inconsistent",
      });
    }
  });

export const RevokeRecordedInteractionFixtureContentResponseSchema = z
  .object({
    created: z.boolean(),
    requestId: RequestIdSchema,
    ...StoredInteractionFixtureContentSchema.shape,
  })
  .strict()
  .superRefine((value, context) => {
    const { created: _created, requestId: _requestId, ...content } = value;
    const parsed = StoredInteractionFixtureContentSchema.safeParse(content);
    if (!parsed.success || value.contentAvailability !== "revoked") {
      context.addIssue({
        code: "custom",
        message: "fixture content revocation response is inconsistent",
      });
    }
  });

export const ExportRecordedInteractionFixtureMetadataResponseSchema = z
  .object({
    export: RecordedInteractionFixtureMetadataExportSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const ExportRecordedInteractionFixtureContentResponseSchema = z
  .object({
    export: RecordedInteractionFixtureContentExportSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const ProblemIssueSchema = z
  .object({
    message: z.string().min(1),
    path: z.string(),
  })
  .strict();

export const ProblemDocumentSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
    detail: z.string().min(1),
    issues: z.array(ProblemIssueSchema).optional(),
    requestId: RequestIdSchema,
    status: z.number().int().min(400).max(599),
    title: z.string().min(1),
    type: z.url(),
  })
  .strict();

export type IngestEvidenceResponse = z.infer<typeof IngestEvidenceResponseSchema>;
export type CreateReplayJobResponse = z.infer<typeof CreateReplayJobResponseSchema>;
export type ExportRecordedInteractionFixtureContentResponse = z.infer<
  typeof ExportRecordedInteractionFixtureContentResponseSchema
>;
export type ExportRecordedInteractionFixtureMetadataResponse = z.infer<
  typeof ExportRecordedInteractionFixtureMetadataResponseSchema
>;
export type PurgeArtifactResponse = z.infer<typeof PurgeArtifactResponseSchema>;
export type PublishReplayPlanResponse = z.infer<typeof PublishReplayPlanResponseSchema>;
export type PublishRecordedInteractionFixtureVersionResponse = z.infer<
  typeof PublishRecordedInteractionFixtureVersionResponseSchema
>;
export type BrowserLogoutResponse = z.infer<typeof BrowserLogoutResponseSchema>;
export type BrowserLoginQuery = z.infer<typeof BrowserLoginQuerySchema>;
export type BrowserReturnPath = z.infer<typeof BrowserReturnPathSchema>;
export type BrowserSessionResponse = z.infer<typeof BrowserSessionResponseSchema>;
export type LivenessResponse = z.infer<typeof LivenessResponseSchema>;
export type OidcCallbackQuery = z.infer<typeof OidcCallbackQuerySchema>;
export type ProblemDocument = z.infer<typeof ProblemDocumentSchema>;
export type PublishRegressionDatasetVersionResponse = z.infer<
  typeof PublishRegressionDatasetVersionResponseSchema
>;
export type PublishRegressionFixtureVersionResponse = z.infer<
  typeof PublishRegressionFixtureVersionResponseSchema
>;
export type PublishTargetReleaseResponse = z.infer<typeof PublishTargetReleaseResponseSchema>;
export type ReadArtifactMetadataResponse = z.infer<typeof ReadArtifactMetadataResponseSchema>;
export type ReadRecordedInteractionFixtureMetadataResponse = z.infer<
  typeof ReadRecordedInteractionFixtureMetadataResponseSchema
>;
export type ReadRegressionDatasetVersionResponse = z.infer<
  typeof ReadRegressionDatasetVersionResponseSchema
>;
export type ReadRegressionFixtureVersionResponse = z.infer<
  typeof ReadRegressionFixtureVersionResponseSchema
>;
export type ReadReplayJobResponse = z.infer<typeof ReadReplayJobResponseSchema>;
export type ReadReplayPlanResponse = z.infer<typeof ReadReplayPlanResponseSchema>;
export type ReadTargetReleaseResponse = z.infer<typeof ReadTargetReleaseResponseSchema>;
export type ReserveArtifactResponse = z.infer<typeof ReserveArtifactResponseSchema>;
export type RevokeRecordedInteractionFixtureContentResponse = z.infer<
  typeof RevokeRecordedInteractionFixtureContentResponseSchema
>;
export type RequestReplayCancellationResponse = z.infer<
  typeof RequestReplayCancellationResponseSchema
>;
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
export type TracePageCursor = z.infer<typeof TracePageCursorSchema>;
export type TraceResponse = z.infer<typeof TraceResponseSchema>;
export type TombstoneArtifactResponse = z.infer<typeof TombstoneArtifactResponseSchema>;
export type UploadArtifactResponse = z.infer<typeof UploadArtifactResponseSchema>;
