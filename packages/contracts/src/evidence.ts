import { z } from "zod";
import {
  JsonValueSchema,
  jsonComplexityViolation,
  NamespacedExtensionKeySchema,
  OpaqueIdSchema,
  Sha256Schema,
  SpanIdSchema,
  TimestampSchema,
  TraceIdSchema,
} from "./primitives.js";

export type { JsonObject, JsonValue } from "./primitives.js";

export const EVIDENCE_SCHEMA_VERSION = "0.1" as const;
export const MAX_EVIDENCE_BATCH_SIZE = 100;
export const MAX_ATTRIBUTE_KEYS = 128;
export const MAX_EXTENSION_KEYS = 64;
export const MAX_EXTENSION_NAMESPACES = 32;

export const EvidenceKindSchema = z.enum([
  "agent.run",
  "agent.handoff",
  "model.generate",
  "tool.execute",
  "retrieval.query",
  "memory.access",
  "guardrail.check",
  "policy.decision",
  "evaluation.score",
  "artifact.change",
  "custom",
]);

export const EvidenceStatusSchema = z.enum(["unset", "ok", "error"]);

export const DataClassificationSchema = z.enum([
  "metadata",
  "internal",
  "confidential",
  "restricted",
]);

export const RedactionStageSchema = z.enum(["source", "ingest", "retention"]);

export const ContentReferenceSchema = z
  .object({
    artifactId: OpaqueIdSchema,
    classification: DataClassificationSchema,
    mediaType: z.string().min(1).max(255),
    redactedAt: RedactionStageSchema.optional(),
    sha256: Sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export const EvidenceSourceSchema = z
  .object({
    frameworkName: z.string().min(1).max(128).optional(),
    frameworkVersion: z.string().min(1).max(64).optional(),
    providerName: z.string().min(1).max(128).optional(),
    sdkName: z.string().min(1).max(128),
    sdkVersion: z.string().min(1).max(64),
    serviceName: z.string().min(1).max(128),
    serviceVersion: z.string().min(1).max(128).optional(),
  })
  .strict();

const BoundedAttributesSchema = z
  .record(z.string().min(1).max(128), JsonValueSchema)
  .refine((value) => Object.keys(value).length <= MAX_ATTRIBUTE_KEYS, {
    message: `Attributes cannot contain more than ${MAX_ATTRIBUTE_KEYS} keys`,
  });

const ExtensionValuesSchema = z
  .record(z.string().min(1).max(128), JsonValueSchema)
  .refine((value) => Object.keys(value).length <= MAX_EXTENSION_KEYS, {
    message: `Extension namespaces cannot contain more than ${MAX_EXTENSION_KEYS} keys`,
  });

const ExtensionsSchema = z
  .record(NamespacedExtensionKeySchema, ExtensionValuesSchema)
  .refine((value) => Object.keys(value).length <= MAX_EXTENSION_NAMESPACES, {
    message: `Extensions cannot contain more than ${MAX_EXTENSION_NAMESPACES} namespaces`,
  });

const EvidenceRecordObjectSchema = z
  .object({
    attributes: BoundedAttributesSchema.default({}),
    contentReferences: z.array(ContentReferenceSchema).max(32).default([]),
    endedAt: TimestampSchema.optional(),
    eventId: OpaqueIdSchema,
    extensions: ExtensionsSchema.default({}),
    kind: EvidenceKindSchema,
    name: z.string().min(1).max(256),
    parentSpanId: SpanIdSchema.optional(),
    runId: OpaqueIdSchema.optional(),
    sequence: z.number().int().nonnegative().optional(),
    sessionId: OpaqueIdSchema.optional(),
    source: EvidenceSourceSchema,
    spanId: SpanIdSchema,
    startedAt: TimestampSchema,
    status: EvidenceStatusSchema.default("unset"),
    traceId: TraceIdSchema,
  })
  .strict();

export const EvidenceRecordSchema = z
  .preprocess((value, context) => {
    const violation = jsonComplexityViolation(value);
    if (violation) context.addIssue({ code: "custom", message: violation });
    return value;
  }, EvidenceRecordObjectSchema)
  .superRefine((value, context) => {
    if (value.parentSpanId === value.spanId) {
      context.addIssue({
        code: "custom",
        message: "A span cannot be its own parent",
        path: ["parentSpanId"],
      });
    }

    if (value.endedAt && Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
      context.addIssue({
        code: "custom",
        message: "endedAt cannot be earlier than startedAt",
        path: ["endedAt"],
      });
    }
  });

export const IngestEvidenceRequestSchema = z
  .object({
    events: z.array(EvidenceRecordSchema).min(1).max(MAX_EVIDENCE_BATCH_SIZE),
    schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((value, context) => {
    const eventIds = value.events.map((event) => event.eventId);
    if (new Set(eventIds).size !== eventIds.length) {
      context.addIssue({
        code: "custom",
        message: "events must not contain duplicate eventIds",
        path: ["events"],
      });
    }
  });

export const EvidenceScopeSchema = z
  .object({
    environmentId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
    tenantId: OpaqueIdSchema,
  })
  .strict();

export const EvidenceEnvelopeSchema = z
  .object({
    evidence: EvidenceRecordSchema,
    receivedAt: TimestampSchema,
    schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict();

export type ContentReference = z.infer<typeof ContentReferenceSchema>;
export type DataClassification = z.infer<typeof DataClassificationSchema>;
export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type EvidenceRecordInput = z.input<typeof EvidenceRecordSchema>;
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
export type EvidenceScope = z.infer<typeof EvidenceScopeSchema>;
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;
export type IngestEvidenceRequest = z.infer<typeof IngestEvidenceRequestSchema>;
export type IngestEvidenceRequestInput = z.input<typeof IngestEvidenceRequestSchema>;
