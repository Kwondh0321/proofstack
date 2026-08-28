import { z } from "zod";
import {
  EVIDENCE_SCHEMA_VERSION,
  EvidenceEnvelopeSchema,
  MAX_EVIDENCE_BATCH_SIZE,
} from "./evidence.js";
import { PrincipalContextSchema } from "./identity.js";
import { OpaqueIdSchema, TraceIdSchema } from "./primitives.js";

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
export type BrowserLogoutResponse = z.infer<typeof BrowserLogoutResponseSchema>;
export type BrowserLoginQuery = z.infer<typeof BrowserLoginQuerySchema>;
export type BrowserReturnPath = z.infer<typeof BrowserReturnPathSchema>;
export type BrowserSessionResponse = z.infer<typeof BrowserSessionResponseSchema>;
export type LivenessResponse = z.infer<typeof LivenessResponseSchema>;
export type OidcCallbackQuery = z.infer<typeof OidcCallbackQuerySchema>;
export type ProblemDocument = z.infer<typeof ProblemDocumentSchema>;
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
export type TracePageCursor = z.infer<typeof TracePageCursorSchema>;
export type TraceResponse = z.infer<typeof TraceResponseSchema>;
