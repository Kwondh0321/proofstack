import { createHash } from "node:crypto";
import {
  EVIDENCE_SCHEMA_VERSION,
  EvidenceKindSchema,
  EvidenceRecordSchema,
  type EvidenceRecord,
  type EvidenceSource,
  type EvidenceStatus,
  type JsonObject,
  type JsonValue,
  OpaqueIdSchema,
} from "@proofstack/contracts";
import {
  MAX_ACCEPTED_OTLP_SPANS,
  MAX_OTLP_ANY_VALUE_DEPTH,
  MAX_OTLP_ANY_VALUE_ITEMS,
  MAX_OTLP_ATTRIBUTES,
  MAX_OTLP_BYTES_VALUE_BYTES,
  MAX_OTLP_EVENT_ATTRIBUTES,
  MAX_OTLP_EVENTS,
  MAX_OTLP_LINK_ATTRIBUTES,
  MAX_OTLP_LINKS,
  MAX_OTLP_NORMALIZED_VALUE_NODES,
  MAX_OTLP_REDACTED_FIELDS,
  MAX_OTLP_RESOURCE_SPANS,
  MAX_OTLP_SCOPE_SPANS,
  MAX_OTLP_SPANS_PER_REQUEST,
  MAX_OTLP_STRING_BYTES,
} from "./limits.js";
import type {
  OtlpAnyValue,
  OtlpExportTraceServiceRequest,
  OtlpInstrumentationScope,
  OtlpKeyValue,
  OtlpResource,
  OtlpResourceSpans,
  OtlpScopeSpans,
  OtlpSpan,
} from "./model.js";

export type OtlpSpanRejectionReason =
  | "attribute_limit"
  | "batch_limit"
  | "duplicate_span"
  | "event_limit"
  | "identifier"
  | "invalid_reserved_attribute"
  | "invalid_span"
  | "link_limit"
  | "redaction_limit"
  | "resource_group_limit"
  | "scope_group_limit"
  | "source_limit"
  | "string_limit"
  | "timestamp"
  | "value_limit"
  | "wire_span_limit";

export interface OtlpRejectionCount {
  readonly count: number;
  readonly reason: OtlpSpanRejectionReason;
}

export interface OtlpTraceNormalizationResult {
  readonly acceptedSpans: number;
  readonly errorMessage?: string;
  readonly records: readonly EvidenceRecord[];
  readonly rejectedSpans: number;
  readonly rejectionCounts: readonly OtlpRejectionCount[];
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly totalSpans: number;
}

const REASON_TEXT: Record<OtlpSpanRejectionReason, string> = {
  attribute_limit: "attribute limits exceeded",
  batch_limit: "canonical batch limit exceeded",
  duplicate_span: "duplicate trace and span identity",
  event_limit: "event limits exceeded",
  identifier: "invalid trace or span identifier",
  invalid_reserved_attribute: "invalid reserved ProofStack attribute",
  invalid_span: "canonical evidence validation failed",
  link_limit: "link limits exceeded",
  redaction_limit: "redaction provenance limit exceeded",
  resource_group_limit: "resource group limit exceeded",
  scope_group_limit: "scope group limit exceeded",
  source_limit: "source metadata limits exceeded",
  string_limit: "string limits exceeded",
  timestamp: "invalid span timestamp",
  value_limit: "attribute value limits exceeded",
  wire_span_limit: "wire span limit exceeded",
};

const CONTENT_ATTRIBUTE_KEYS = new Set([
  "gen_ai.completion",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.prompt",
  "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
]);

const OPERATION_KINDS = new Map<string, EvidenceRecord["kind"]>([
  ["chat", "model.generate"],
  ["create_agent", "agent.run"],
  ["embeddings", "model.generate"],
  ["execute_tool", "tool.execute"],
  ["generate_content", "model.generate"],
  ["invoke_agent", "agent.run"],
  ["invoke_workflow", "agent.run"],
  ["retrieval", "retrieval.query"],
  ["text_completion", "model.generate"],
]);

const MAX_DATE_MILLISECONDS = 253_402_300_799_999n;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

class SpanNormalizationError extends Error {
  constructor(readonly reason: OtlpSpanRejectionReason) {
    super(REASON_TEXT[reason]);
    this.name = "SpanNormalizationError";
  }
}

interface AttributeContext {
  readonly attributes: JsonObject;
  readonly redactedFields: readonly string[];
}

interface ValueNodeBudget {
  remaining: number;
}

function reject(reason: OtlpSpanRejectionReason): never {
  throw new SpanNormalizationError(reason);
}

function validUnicode(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

function boundedString(
  value: string,
  maximumCharacters: number,
  reason: OtlpSpanRejectionReason = "string_limit",
  allowEmpty = true,
): string {
  if (
    (!allowEmpty && value.length === 0) ||
    value.length > maximumCharacters ||
    Buffer.byteLength(value, "utf8") > MAX_OTLP_STRING_BYTES ||
    !validUnicode(value)
  ) {
    reject(reason);
  }
  return value;
}

function normalizedInteger(value: number | string): number | string {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    reject("value_limit");
  }
  return parsed >= BigInt(Number.MIN_SAFE_INTEGER) && parsed <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(parsed)
    : parsed.toString();
}

function normalizeAnyValue(
  value: OtlpAnyValue | undefined,
  budget: ValueNodeBudget,
  depth = 0,
): JsonValue {
  budget.remaining -= 1;
  if (budget.remaining < 0) reject("value_limit");
  if (!value) return null;
  if (depth > MAX_OTLP_ANY_VALUE_DEPTH) reject("value_limit");
  const members = [
    value.arrayValue,
    value.boolValue,
    value.bytesValue,
    value.doubleValue,
    value.intValue,
    value.kvlistValue,
    value.stringValue,
  ].filter((member) => member !== undefined);
  if (members.length === 0) return null;
  if (members.length > 1) reject("value_limit");

  if (value.stringValue !== undefined) {
    return boundedString(value.stringValue, MAX_OTLP_STRING_BYTES);
  }
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return normalizedInteger(value.intValue);
  if (value.doubleValue !== undefined) {
    if (typeof value.doubleValue === "string") return value.doubleValue;
    if (Number.isNaN(value.doubleValue)) return "NaN";
    if (value.doubleValue === Number.POSITIVE_INFINITY) return "Infinity";
    if (value.doubleValue === Number.NEGATIVE_INFINITY) return "-Infinity";
    return value.doubleValue;
  }
  if (value.bytesValue !== undefined) {
    if (value.bytesValue.byteLength > MAX_OTLP_BYTES_VALUE_BYTES) reject("value_limit");
    return Buffer.from(value.bytesValue).toString("base64");
  }
  if (value.arrayValue) {
    if (value.arrayValue.values.length > MAX_OTLP_ANY_VALUE_ITEMS) reject("value_limit");
    return value.arrayValue.values.map((item) => normalizeAnyValue(item, budget, depth + 1));
  }
  const kvlistValue = value.kvlistValue as NonNullable<OtlpAnyValue["kvlistValue"]>;
  if (kvlistValue.values.length > MAX_OTLP_ANY_VALUE_ITEMS) reject("value_limit");
  const normalized: Record<string, JsonValue> = {};
  for (const entry of kvlistValue.values) {
    const key = boundedString(entry.key, 128, "value_limit", false);
    if (Object.hasOwn(normalized, key)) reject("value_limit");
    normalized[key] = normalizeAnyValue(entry.value, budget, depth + 1);
  }
  return normalized;
}

function normalizeKeyValues(
  values: readonly OtlpKeyValue[],
  path: string,
  maximum: number,
  inheritedRedactions: readonly string[],
  budget: ValueNodeBudget,
): AttributeContext {
  if (values.length > maximum)
    reject(maximum === MAX_OTLP_ATTRIBUTES ? "attribute_limit" : "value_limit");
  const attributes: Record<string, JsonValue> = {};
  const redactedFields = [...inheritedRedactions];

  for (const entry of values) {
    const key = boundedString(entry.key, 128, "attribute_limit", false);
    if (Object.hasOwn(attributes, key)) reject("attribute_limit");
    if (CONTENT_ATTRIBUTE_KEYS.has(key)) {
      redactedFields.push(`${path}.${key}`);
      if (redactedFields.length > MAX_OTLP_REDACTED_FIELDS) reject("redaction_limit");
      continue;
    }
    attributes[key] = normalizeAnyValue(entry.value, budget);
  }

  return { attributes, redactedFields };
}

function hexIdentifier(bytes: Uint8Array, length: number, optional = false): string | undefined {
  if (optional && bytes.byteLength === 0) return undefined;
  if (bytes.byteLength !== length || bytes.every((byte) => byte === 0)) reject("identifier");
  return Buffer.from(bytes).toString("hex");
}

function timestamp(nanoseconds: string): string {
  let value: bigint;
  try {
    value = BigInt(nanoseconds);
  } catch {
    reject("timestamp");
  }
  if (value <= 0 || value / NANOSECONDS_PER_MILLISECOND > MAX_DATE_MILLISECONDS) {
    reject("timestamp");
  }
  return new Date(Number(value / NANOSECONDS_PER_MILLISECOND)).toISOString();
}

function optionalAttributeString(
  attributes: JsonObject,
  key: string,
  maximum: number,
  reserved = false,
): string | undefined {
  const value = attributes[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    if (reserved) reject("invalid_reserved_attribute");
    return undefined;
  }
  const normalized = boundedString(
    value,
    maximum,
    reserved ? "invalid_reserved_attribute" : "source_limit",
  );
  if (reserved && normalized.length === 0) reject("invalid_reserved_attribute");
  return normalized;
}

function source(
  resourceAttributes: JsonObject,
  scope: OtlpInstrumentationScope | undefined,
  spanAttributes: JsonObject,
): EvidenceSource {
  const serviceName =
    optionalAttributeString(resourceAttributes, "service.name", 128) || "unknown_service";
  const serviceVersion = optionalAttributeString(resourceAttributes, "service.version", 128);
  const resourceSdkName = optionalAttributeString(resourceAttributes, "telemetry.sdk.name", 128);
  const resourceSdkVersion = optionalAttributeString(
    resourceAttributes,
    "telemetry.sdk.version",
    64,
  );
  const scopeName = scope?.name ? boundedString(scope.name, 128, "source_limit") : undefined;
  const scopeVersion = scope?.version
    ? boundedString(scope.version, 64, "source_limit")
    : undefined;
  const frameworkName = optionalAttributeString(
    spanAttributes,
    "proofstack.framework.name",
    128,
    true,
  );
  const frameworkVersion = optionalAttributeString(
    spanAttributes,
    "proofstack.framework.version",
    64,
    true,
  );
  const providerName = optionalAttributeString(spanAttributes, "gen_ai.provider.name", 128);

  return {
    ...(frameworkName ? { frameworkName } : {}),
    ...(frameworkVersion ? { frameworkVersion } : {}),
    ...(providerName ? { providerName } : {}),
    sdkName: scopeName || resourceSdkName || "opentelemetry",
    sdkVersion: scopeVersion || resourceSdkVersion || "unknown",
    serviceName,
    ...(serviceVersion ? { serviceVersion } : {}),
  };
}

function reservedOpaqueId(attributes: JsonObject, key: string): string | undefined {
  const value = attributes[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !OpaqueIdSchema.safeParse(value).success) {
    reject("invalid_reserved_attribute");
  }
  return value;
}

function sequence(attributes: JsonObject): number | undefined {
  const value = attributes["proofstack.sequence"];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    reject("invalid_reserved_attribute");
  }
  return value;
}

function evidenceKind(attributes: JsonObject): EvidenceRecord["kind"] {
  const explicit = attributes["proofstack.evidence.kind"];
  if (explicit !== undefined) {
    const parsed = EvidenceKindSchema.safeParse(explicit);
    if (!parsed.success) reject("invalid_reserved_attribute");
    return parsed.data;
  }
  const operation = attributes["gen_ai.operation.name"];
  return typeof operation === "string" ? (OPERATION_KINDS.get(operation) ?? "custom") : "custom";
}

function evidenceStatus(span: OtlpSpan): EvidenceStatus {
  if (span.status?.code === 1) return "ok";
  if (span.status?.code === 2) return "error";
  return "unset";
}

function normalizeEvents(
  span: OtlpSpan,
  inheritedRedactions: readonly string[],
  budget: ValueNodeBudget,
): { readonly items: readonly JsonObject[]; readonly redactedFields: readonly string[] } {
  if (span.events.length > MAX_OTLP_EVENTS) reject("event_limit");
  let redactedFields = [...inheritedRedactions];
  const items = span.events.map((event, index) => {
    const normalized = normalizeKeyValues(
      event.attributes,
      `events.${index}.attributes`,
      MAX_OTLP_EVENT_ATTRIBUTES,
      redactedFields,
      budget,
    );
    redactedFields = [...normalized.redactedFields];
    return {
      attributes: normalized.attributes,
      droppedAttributesCount: event.droppedAttributesCount,
      name: boundedString(event.name, 256, "event_limit", false),
      timeUnixNano: timestamp(event.timeUnixNano),
      timeUnixNanoExact: event.timeUnixNano,
    };
  });
  return { items, redactedFields };
}

function normalizeLinks(
  span: OtlpSpan,
  inheritedRedactions: readonly string[],
  budget: ValueNodeBudget,
): { readonly items: readonly JsonObject[]; readonly redactedFields: readonly string[] } {
  if (span.links.length > MAX_OTLP_LINKS) reject("link_limit");
  let redactedFields = [...inheritedRedactions];
  const items = span.links.map((link, index) => {
    const normalized = normalizeKeyValues(
      link.attributes,
      `links.${index}.attributes`,
      MAX_OTLP_LINK_ATTRIBUTES,
      redactedFields,
      budget,
    );
    redactedFields = [...normalized.redactedFields];
    return {
      attributes: normalized.attributes,
      droppedAttributesCount: link.droppedAttributesCount,
      flags: link.flags,
      spanId: hexIdentifier(link.spanId, 8) as string,
      traceId: hexIdentifier(link.traceId, 16) as string,
      traceState: boundedString(link.traceState, 512, "link_limit"),
    };
  });
  return { items, redactedFields };
}

function eventId(traceId: string, spanId: string): string {
  return `evt_${createHash("sha256").update(traceId).update(":").update(spanId).digest("hex").slice(0, 32)}`;
}

function normalizeSpan(
  span: OtlpSpan,
  resourceSpans: OtlpResourceSpans,
  scopeSpans: OtlpScopeSpans,
  resourceContext: AttributeContext,
  scopeContext: AttributeContext,
  budget: ValueNodeBudget,
): EvidenceRecord {
  const traceId = hexIdentifier(span.traceId, 16) as string;
  const spanId = hexIdentifier(span.spanId, 8) as string;
  const parentSpanId = hexIdentifier(span.parentSpanId, 8, true);
  if (parentSpanId === spanId) reject("identifier");

  const startedAt = timestamp(span.startTimeUnixNano);
  const endedAt = timestamp(span.endTimeUnixNano);
  if (BigInt(span.endTimeUnixNano) < BigInt(span.startTimeUnixNano)) reject("timestamp");

  const spanContext = normalizeKeyValues(
    span.attributes,
    "span.attributes",
    MAX_OTLP_ATTRIBUTES,
    [...resourceContext.redactedFields, ...scopeContext.redactedFields],
    budget,
  );
  const events = normalizeEvents(span, spanContext.redactedFields, budget);
  const links = normalizeLinks(span, events.redactedFields, budget);
  const redactedFields = links.redactedFields;
  const extensions: Record<string, JsonObject> = {
    "opentelemetry.resource": {
      attributes: resourceContext.attributes,
      droppedAttributesCount: resourceSpans.resource?.droppedAttributesCount ?? 0,
      present: resourceSpans.resource !== undefined,
      schemaUrl: boundedString(resourceSpans.schemaUrl, 2_048),
    },
    "opentelemetry.scope": {
      attributes: scopeContext.attributes,
      droppedAttributesCount: scopeSpans.scope?.droppedAttributesCount ?? 0,
      name: boundedString(scopeSpans.scope?.name ?? "", 128, "source_limit"),
      present: scopeSpans.scope !== undefined,
      schemaUrl: boundedString(scopeSpans.schemaUrl, 2_048),
      version: boundedString(scopeSpans.scope?.version ?? "", 64, "source_limit"),
    },
    "opentelemetry.span": {
      droppedAttributesCount: span.droppedAttributesCount,
      droppedEventsCount: span.droppedEventsCount,
      droppedLinksCount: span.droppedLinksCount,
      endTimeUnixNano: span.endTimeUnixNano,
      flags: span.flags,
      kind: span.kind,
      startTimeUnixNano: span.startTimeUnixNano,
      statusMessage: boundedString(span.status?.message ?? "", 2_048),
      statusPresent: span.status !== undefined,
      traceState: boundedString(span.traceState, 512),
    },
  };
  if (events.items.length > 0) extensions["opentelemetry.events"] = { items: [...events.items] };
  if (links.items.length > 0) extensions["opentelemetry.links"] = { items: [...links.items] };
  if (redactedFields.length > 0) {
    extensions["proofstack.redaction"] = {
      fields: [...redactedFields],
      ruleset: "otlp-known-content-v1",
      stage: "ingest",
    };
  }

  const runId = reservedOpaqueId(spanContext.attributes, "proofstack.run.id");
  const sequenceNumber = sequence(spanContext.attributes);
  const sessionId = reservedOpaqueId(spanContext.attributes, "proofstack.session.id");
  const candidate = EvidenceRecordSchema.safeParse({
    attributes: spanContext.attributes,
    endedAt,
    eventId: eventId(traceId, spanId),
    extensions,
    kind: evidenceKind(spanContext.attributes),
    name: boundedString(span.name, 256, "string_limit", false),
    ...(parentSpanId ? { parentSpanId } : {}),
    ...(runId ? { runId } : {}),
    ...(sequenceNumber !== undefined ? { sequence: sequenceNumber } : {}),
    ...(sessionId ? { sessionId } : {}),
    source: source(resourceContext.attributes, scopeSpans.scope, spanContext.attributes),
    spanId,
    startedAt,
    status: evidenceStatus(span),
    traceId,
  });
  /* v8 ignore next -- Earlier bounds construct a valid canonical record; this guards contract drift. */
  if (!candidate.success) reject("invalid_span");
  return candidate.data;
}

function contextForResource(
  resource: OtlpResource | undefined,
  budget: ValueNodeBudget,
): AttributeContext {
  return normalizeKeyValues(
    resource?.attributes ?? [],
    "resource.attributes",
    MAX_OTLP_ATTRIBUTES,
    [],
    budget,
  );
}

function contextForScope(
  scope: OtlpInstrumentationScope | undefined,
  budget: ValueNodeBudget,
): AttributeContext {
  return normalizeKeyValues(
    scope?.attributes ?? [],
    "scope.attributes",
    MAX_OTLP_ATTRIBUTES,
    [],
    budget,
  );
}

function errorMessage(rejections: readonly OtlpRejectionCount[]): string | undefined {
  if (rejections.length === 0) return undefined;
  return `Rejected spans: ${rejections.map(({ count, reason }) => `${REASON_TEXT[reason]} (${count})`).join("; ")}`;
}

export function normalizeOtlpTraceRequest(
  request: OtlpExportTraceServiceRequest,
): OtlpTraceNormalizationResult {
  const records: EvidenceRecord[] = [];
  const rejected = new Map<OtlpSpanRejectionReason, number>();
  const eventIds = new Set<string>();
  const valueNodeBudget: ValueNodeBudget = { remaining: MAX_OTLP_NORMALIZED_VALUE_NODES };
  let scopeGroupCount = 0;
  let totalSpans = 0;

  const recordRejection = (reason: OtlpSpanRejectionReason): void => {
    rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
  };

  for (const [resourceIndex, resourceSpans] of request.resourceSpans.entries()) {
    let resourceContext: AttributeContext | SpanNormalizationError;
    try {
      resourceContext = contextForResource(resourceSpans.resource, valueNodeBudget);
    } catch (error) {
      /* v8 ignore next -- Resource normalization only raises the typed rejection above. */
      if (!(error instanceof SpanNormalizationError)) throw error;
      resourceContext = error;
    }

    for (const scopeSpans of resourceSpans.scopeSpans) {
      const currentScopeIndex = scopeGroupCount;
      scopeGroupCount += 1;
      let scopeContext: AttributeContext | SpanNormalizationError;
      try {
        scopeContext =
          resourceContext instanceof SpanNormalizationError
            ? resourceContext
            : contextForScope(scopeSpans.scope, valueNodeBudget);
      } catch (error) {
        /* v8 ignore next -- Scope normalization only raises the typed rejection above. */
        if (!(error instanceof SpanNormalizationError)) throw error;
        scopeContext = error;
      }

      for (const span of scopeSpans.spans) {
        totalSpans += 1;
        if (resourceIndex >= MAX_OTLP_RESOURCE_SPANS) {
          recordRejection("resource_group_limit");
          continue;
        }
        if (currentScopeIndex >= MAX_OTLP_SCOPE_SPANS) {
          recordRejection("scope_group_limit");
          continue;
        }
        if (totalSpans > MAX_OTLP_SPANS_PER_REQUEST) {
          recordRejection("wire_span_limit");
          continue;
        }
        if (resourceContext instanceof SpanNormalizationError) {
          recordRejection(resourceContext.reason);
          continue;
        }
        if (scopeContext instanceof SpanNormalizationError) {
          recordRejection(scopeContext.reason);
          continue;
        }
        if (records.length >= MAX_ACCEPTED_OTLP_SPANS) {
          recordRejection("batch_limit");
          continue;
        }

        try {
          const normalized = normalizeSpan(
            span,
            resourceSpans,
            scopeSpans,
            resourceContext,
            scopeContext,
            valueNodeBudget,
          );
          if (eventIds.has(normalized.eventId)) {
            recordRejection("duplicate_span");
            continue;
          }
          eventIds.add(normalized.eventId);
          records.push(normalized);
        } catch (error) {
          /* v8 ignore next -- Span normalization only raises the typed rejection above. */
          if (!(error instanceof SpanNormalizationError)) throw error;
          recordRejection(error.reason);
        }
      }
    }
  }

  const rejectionCounts = [...rejected].map(([reason, count]) => ({ count, reason }));
  const rejectedSpans = rejectionCounts.reduce((total, entry) => total + entry.count, 0);
  const diagnostic = errorMessage(rejectionCounts);
  return {
    acceptedSpans: records.length,
    ...(diagnostic ? { errorMessage: diagnostic } : {}),
    records,
    rejectedSpans,
    rejectionCounts,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    totalSpans,
  };
}
