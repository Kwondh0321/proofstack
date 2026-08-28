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

const ISO_INSTANT_PARTS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u;

function hasSupportedEvidenceTimestampForm(value: string): boolean {
  const match = ISO_INSTANT_PARTS.exec(value);
  const whole = match?.[1];
  const offset = match?.[3];
  if (!whole || !offset || whole.startsWith("0000-")) return false;
  if (offset === "Z") return true;
  return Number(offset.slice(1, 3)) <= 15;
}

export const EvidenceTimestampSchema = TimestampSchema.refine(hasSupportedEvidenceTimestampForm, {
  message:
    "Evidence timestamps require a positive ISO year and Z or a PostgreSQL-compatible offset through +/-15:59",
});

export function evidenceTimestampOrderKey(value: string): bigint {
  const parsed = EvidenceTimestampSchema.safeParse(value);
  if (!parsed.success)
    throw new TypeError("Evidence timestamp must be a supported ISO 8601 instant");

  const match = ISO_INSTANT_PARTS.exec(parsed.data);
  const whole = match?.[1];
  const offset = match?.[3];
  if (!whole || !offset) throw new TypeError("Evidence timestamp must be an ISO 8601 instant");

  const wholeMilliseconds = Date.parse(`${whole}${offset}`);
  if (!Number.isSafeInteger(wholeMilliseconds)) {
    throw new TypeError("Evidence timestamp is outside the supported instant range");
  }

  const fraction = match[2] ?? "";
  // PostgreSQL parses the fraction as binary floating point before applying
  // ties-to-even microsecond rounding. Preserve that step so cursors agree.
  const parsedFraction = fraction.length === 0 ? 0 : Number(`0.${fraction}`);
  const scaledMicroseconds = parsedFraction * 1_000_000;
  const lowerMicroseconds = Math.floor(scaledMicroseconds);
  const remainder = scaledMicroseconds - lowerMicroseconds;
  const shouldRoundUp = remainder > 0.5 || (remainder === 0.5 && lowerMicroseconds % 2 === 1);
  const fractionalMicroseconds = BigInt(lowerMicroseconds + (shouldRoundUp ? 1 : 0));

  return BigInt(wholeMilliseconds) * 1_000n + fractionalMicroseconds;
}

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
    endedAt: EvidenceTimestampSchema.optional(),
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
    startedAt: EvidenceTimestampSchema,
    status: EvidenceStatusSchema.default("unset"),
    traceId: TraceIdSchema,
  })
  .strict();

type EvidenceRecordObjectInput = z.input<typeof EvidenceRecordObjectSchema>;
type EvidenceRecordObjectOutput = z.output<typeof EvidenceRecordObjectSchema>;

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

    if (
      value.endedAt &&
      evidenceTimestampOrderKey(value.endedAt) < evidenceTimestampOrderKey(value.startedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "endedAt cannot be earlier than startedAt",
        path: ["endedAt"],
      });
    }
  }) as z.ZodType<EvidenceRecordObjectOutput, EvidenceRecordObjectInput>;

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
    receivedAt: EvidenceTimestampSchema,
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
