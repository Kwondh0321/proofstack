import { z } from "zod";
import { EVIDENCE_SCHEMA_VERSION, EvidenceEnvelopeSchema } from "./evidence.js";
import { OpaqueIdSchema, TraceIdSchema } from "./primitives.js";

export const RequestIdSchema = z.string().min(1).max(128);

export const LivenessResponseSchema = z.object({ status: z.literal("ok") }).strict();
export const ReadinessResponseSchema = z.object({ status: z.literal("ready") }).strict();

export const IngestEvidenceResponseSchema = z
  .object({
    acceptedEventIds: z.array(OpaqueIdSchema),
    duplicateEventIds: z.array(OpaqueIdSchema),
    requestId: RequestIdSchema,
    schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
  })
  .strict();

export const TraceResponseSchema = z
  .object({
    events: z.array(EvidenceEnvelopeSchema),
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
