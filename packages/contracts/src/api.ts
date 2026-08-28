import { z } from "zod";
import {
  EVIDENCE_SCHEMA_VERSION,
  EvidenceEnvelopeSchema,
  MAX_EVIDENCE_BATCH_SIZE,
} from "./evidence.js";
import { OpaqueIdSchema, TraceIdSchema } from "./primitives.js";

export const RequestIdSchema = z.string().min(1).max(128);

export const LivenessResponseSchema = z.object({ status: z.literal("ok") }).strict();
export const ReadinessResponseSchema = z.object({ status: z.literal("ready") }).strict();

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
    events: z.array(EvidenceEnvelopeSchema).min(1),
    requestId: RequestIdSchema,
    schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
    traceId: TraceIdSchema,
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
export type LivenessResponse = z.infer<typeof LivenessResponseSchema>;
export type ProblemDocument = z.infer<typeof ProblemDocumentSchema>;
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
export type TraceResponse = z.infer<typeof TraceResponseSchema>;
