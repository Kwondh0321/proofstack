import {
  MAX_OTLP_RESOURCE_SPANS,
  MAX_OTLP_SCOPE_SPANS,
  MAX_OTLP_SPANS_PER_REQUEST,
  MAX_OTLP_STRING_BYTES,
  OTLP_PROTO_VERSION,
} from "./limits.js";
import type {
  OtlpAnyValue,
  OtlpExportTraceServiceRequest,
  OtlpInstrumentationScope,
  OtlpKeyValue,
  OtlpSpan,
} from "./model.js";

export const OTEL_GENAI_SEMANTIC_CONVENTION_VERSION = "1.41.0" as const;
export const OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL =
  "https://opentelemetry.io/schemas/1.41.0" as const;
export const PROOFSTACK_OTEL_GENAI_IMPORT_ADAPTER_NAME = "proofstack.otel_genai.proposal" as const;
export const PROOFSTACK_OTEL_GENAI_IMPORT_ADAPTER_VERSION = "0.1.0" as const;

const MODEL_OPERATIONS = new Set(["chat", "generate_content", "text_completion"]);
const PROPOSAL_LIMITATIONS = [
  "telemetry_content_can_be_filtered_despite_producer_attestation",
  "logical_retry_groups_are_not_attested",
  "artifact_bytes_and_digests_are_not_attested",
  "tool_contract_versions_and_side_effects_are_not_attested",
  "uninstrumented_operations_cannot_be_detected",
] as const;

export type OtlpGenAiImportRejectionCode =
  | "batch_limit"
  | "content_capture_incomplete"
  | "dropped_data"
  | "duplicate_attribute"
  | "duplicate_span"
  | "invalid_attribute"
  | "invalid_identifier"
  | "invalid_timestamp"
  | "missing_attribute"
  | "no_supported_spans"
  | "not_sampled"
  | "trace_capture_incomplete"
  | "unsupported_operation"
  | "unsupported_schema"
  | "unsupported_span_kind"
  | "unsupported_streaming";

export interface OtlpGenAiImportDeclaration {
  readonly contentCapture: "complete" | "omitted" | "truncated" | "unknown";
  readonly traceCapture: "complete" | "partial" | "unknown";
}

export interface OtlpGenAiImportInput {
  readonly declaration: OtlpGenAiImportDeclaration;
  readonly request: OtlpExportTraceServiceRequest;
}

export interface OtlpGenAiImportRejection {
  readonly code: OtlpGenAiImportRejectionCode;
  readonly message: string;
  readonly path: string;
}

interface OtlpGenAiProposalBase {
  readonly endTimeUnixNano: string;
  readonly errorType?: string;
  readonly instrumentationScope?: {
    readonly name: string;
    readonly version?: string;
  };
  readonly observedOutcome: "failed" | "indeterminate" | "succeeded";
  readonly operation: string;
  readonly parentSpanId?: string;
  readonly spanId: string;
  readonly spanName: string;
  readonly startTimeUnixNano: string;
  readonly traceId: string;
}

export interface OtlpGenAiModelInteractionProposal extends OtlpGenAiProposalBase {
  readonly contentSignals: {
    readonly inputMessages: true;
    readonly outputMessages: boolean;
    readonly systemInstructions: boolean;
    readonly toolDefinitions: boolean;
  };
  readonly kind: "model";
  readonly providerName: string;
  readonly requestedModel: string;
  readonly responseId?: string;
  readonly returnedModel?: string;
  readonly streaming: false;
}

export interface OtlpGenAiToolInteractionProposal extends OtlpGenAiProposalBase {
  readonly contentSignals: {
    readonly arguments: true;
    readonly result: boolean;
  };
  readonly kind: "tool";
  readonly sideEffect: "unknown";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolType?: string;
}

export type OtlpGenAiInteractionProposal =
  | OtlpGenAiModelInteractionProposal
  | OtlpGenAiToolInteractionProposal;

export type OtlpGenAiImportResult =
  | {
      readonly adapter: {
        readonly name: typeof PROOFSTACK_OTEL_GENAI_IMPORT_ADAPTER_NAME;
        readonly version: typeof PROOFSTACK_OTEL_GENAI_IMPORT_ADAPTER_VERSION;
      };
      readonly limitations: typeof PROPOSAL_LIMITATIONS;
      readonly proposals: readonly OtlpGenAiInteractionProposal[];
      readonly publishable: false;
      readonly semanticConvention: {
        readonly schemaUrl: typeof OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL;
        readonly version: typeof OTEL_GENAI_SEMANTIC_CONVENTION_VERSION;
      };
      readonly sourceFormat: {
        readonly name: "otlp.trace";
        readonly version: typeof OTLP_PROTO_VERSION;
      };
      readonly status: "mapped_as_untrusted_proposal";
    }
  | {
      readonly proposals: readonly [];
      readonly publishable: false;
      readonly rejections: readonly OtlpGenAiImportRejection[];
      readonly status: "rejected";
    };

interface AttributeIndexResult {
  readonly attributes?: ReadonlyMap<string, OtlpAnyValue | undefined>;
  readonly rejection?: OtlpGenAiImportRejection;
}

function rejection(
  code: OtlpGenAiImportRejectionCode,
  message: string,
  path: string,
): OtlpGenAiImportRejection {
  return { code, message, path };
}

function rejected(rejections: readonly OtlpGenAiImportRejection[]): OtlpGenAiImportResult {
  return { proposals: [], publishable: false, rejections, status: "rejected" };
}

function attributeIndex(values: readonly OtlpKeyValue[], path: string): AttributeIndexResult {
  const attributes = new Map<string, OtlpAnyValue | undefined>();
  for (const [index, attribute] of values.entries()) {
    if (attributes.has(attribute.key)) {
      return {
        rejection: rejection(
          "duplicate_attribute",
          `Duplicate attribute ${attribute.key}`,
          `${path}.${index}`,
        ),
      };
    }
    attributes.set(attribute.key, attribute.value);
  }
  return { attributes };
}

function anyValueMemberCount(value: OtlpAnyValue): number {
  return [
    value.arrayValue,
    value.boolValue,
    value.bytesValue,
    value.doubleValue,
    value.intValue,
    value.kvlistValue,
    value.stringValue,
  ].filter((member) => member !== undefined).length;
}

function optionalString(
  attributes: ReadonlyMap<string, OtlpAnyValue | undefined>,
  key: string,
  path: string,
  rejections: OtlpGenAiImportRejection[],
): string | undefined {
  if (!attributes.has(key)) return undefined;
  const value = attributes.get(key);
  if (
    !value ||
    anyValueMemberCount(value) !== 1 ||
    typeof value.stringValue !== "string" ||
    value.stringValue.length === 0 ||
    value.stringValue.length > 256
  ) {
    rejections.push(
      rejection("invalid_attribute", `${key} must be a non-empty bounded string`, `${path}.${key}`),
    );
    return undefined;
  }
  return value.stringValue;
}

function requiredString(
  attributes: ReadonlyMap<string, OtlpAnyValue | undefined>,
  key: string,
  path: string,
  rejections: OtlpGenAiImportRejection[],
): string | undefined {
  if (!attributes.has(key)) {
    rejections.push(rejection("missing_attribute", `${key} is required`, `${path}.${key}`));
    return undefined;
  }
  return optionalString(attributes, key, path, rejections);
}

function optionalBoolean(
  attributes: ReadonlyMap<string, OtlpAnyValue | undefined>,
  key: string,
  path: string,
  rejections: OtlpGenAiImportRejection[],
): boolean | undefined {
  if (!attributes.has(key)) return undefined;
  const value = attributes.get(key);
  if (!value || anyValueMemberCount(value) !== 1 || typeof value.boolValue !== "boolean") {
    rejections.push(rejection("invalid_attribute", `${key} must be a boolean`, `${path}.${key}`));
    return undefined;
  }
  return value.boolValue;
}

function contentSignal(
  attributes: ReadonlyMap<string, OtlpAnyValue | undefined>,
  key: string,
  required: boolean,
  shape: "array" | "object",
  path: string,
  rejections: OtlpGenAiImportRejection[],
): boolean {
  if (!attributes.has(key)) {
    if (required) {
      rejections.push(rejection("missing_attribute", `${key} is required`, `${path}.${key}`));
    }
    return false;
  }
  const value = attributes.get(key);
  if (!value || anyValueMemberCount(value) !== 1 || !hasContentShape(value, shape)) {
    rejections.push(
      rejection(
        "invalid_attribute",
        `${key} must be a ${shape} encoded as structured OTLP or bounded JSON`,
        `${path}.${key}`,
      ),
    );
    return false;
  }
  return true;
}

function hasContentShape(value: OtlpAnyValue, shape: "array" | "object"): boolean {
  if (value.stringValue !== undefined) {
    if (
      value.stringValue.length === 0 ||
      Buffer.byteLength(value.stringValue, "utf8") > MAX_OTLP_STRING_BYTES
    ) {
      return false;
    }
    try {
      const parsed: unknown = JSON.parse(value.stringValue);
      return shape === "array"
        ? Array.isArray(parsed)
        : typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }
  return shape === "array" ? value.arrayValue !== undefined : value.kvlistValue !== undefined;
}

function identifier(value: Uint8Array, expectedBytes: number): string | undefined {
  if (value.byteLength !== expectedBytes || value.every((byte) => byte === 0)) return undefined;
  return Buffer.from(value).toString("hex");
}

function validTimestampRange(span: OtlpSpan): boolean {
  try {
    const start = BigInt(span.startTimeUnixNano);
    const end = BigInt(span.endTimeUnixNano);
    return start > 0n && end >= start;
  } catch {
    return false;
  }
}

function observedOutcome(
  span: OtlpSpan,
  errorType: string | undefined,
  path: string,
  rejections: OtlpGenAiImportRejection[],
): "failed" | "indeterminate" | "succeeded" {
  const statusCode = span.status?.code ?? 0;
  if (![0, 1, 2].includes(statusCode)) {
    rejections.push(
      rejection("invalid_attribute", "OTLP span status code is unsupported", `${path}.status.code`),
    );
    return "indeterminate";
  }
  if (statusCode === 2) {
    if (!errorType) {
      rejections.push(
        rejection(
          "missing_attribute",
          "error.type is required for an error span",
          `${path}.attributes.error.type`,
        ),
      );
    }
    return "failed";
  }
  if (errorType) {
    rejections.push(
      rejection(
        "invalid_attribute",
        "error.type contradicts a non-error span status",
        `${path}.attributes.error.type`,
      ),
    );
  }
  return statusCode === 1 ? "succeeded" : "indeterminate";
}

function schemaUrl(resourceSchemaUrl: string, scopeSchemaUrl: string): string | undefined {
  if (resourceSchemaUrl && scopeSchemaUrl && resourceSchemaUrl !== scopeSchemaUrl) return undefined;
  return scopeSchemaUrl || resourceSchemaUrl || undefined;
}

function isGenAiSpan(span: OtlpSpan): boolean {
  return span.attributes.some(({ key }) => key === "gen_ai.operation.name");
}

function batchLimitRejection(
  request: OtlpExportTraceServiceRequest,
): OtlpGenAiImportRejection | undefined {
  if (request.resourceSpans.length > MAX_OTLP_RESOURCE_SPANS) {
    return rejection("batch_limit", "OTLP resource group limit exceeded", "request.resourceSpans");
  }
  const scopeCount = request.resourceSpans.reduce(
    (count, resourceSpans) => count + resourceSpans.scopeSpans.length,
    0,
  );
  if (scopeCount > MAX_OTLP_SCOPE_SPANS) {
    return rejection("batch_limit", "OTLP scope group limit exceeded", "request.resourceSpans");
  }
  const spanCount = request.resourceSpans.reduce(
    (count, resourceSpans) =>
      count +
      resourceSpans.scopeSpans.reduce(
        (resourceCount, scopeSpans) => resourceCount + scopeSpans.spans.length,
        0,
      ),
    0,
  );
  return spanCount > MAX_OTLP_SPANS_PER_REQUEST
    ? rejection("batch_limit", "OTLP span limit exceeded", "request.resourceSpans")
    : undefined;
}

function instrumentationScope(
  scope: OtlpInstrumentationScope | undefined,
  path: string,
  rejections: OtlpGenAiImportRejection[],
): OtlpGenAiProposalBase["instrumentationScope"] {
  if (!scope) return undefined;
  if (scope.name.length === 0 || scope.name.length > 256 || scope.version.length > 256) {
    rejections.push(
      rejection(
        "invalid_attribute",
        "Instrumentation scope name and version must be bounded",
        `${path}.scope`,
      ),
    );
    return undefined;
  }
  return {
    name: scope.name,
    ...(scope.version ? { version: scope.version } : {}),
  };
}

export function mapOtlpGenAiInteractionProposals(
  input: OtlpGenAiImportInput,
): OtlpGenAiImportResult {
  if (input.declaration.contentCapture !== "complete") {
    return rejected([
      rejection(
        "content_capture_incomplete",
        "The producer did not attest an unmodified complete content capture",
        "declaration.contentCapture",
      ),
    ]);
  }
  if (input.declaration.traceCapture !== "complete") {
    return rejected([
      rejection(
        "trace_capture_incomplete",
        "The producer did not attest a complete declared trace boundary",
        "declaration.traceCapture",
      ),
    ]);
  }
  const limitRejection = batchLimitRejection(input.request);
  if (limitRejection) return rejected([limitRejection]);

  const proposals: OtlpGenAiInteractionProposal[] = [];
  const rejections: OtlpGenAiImportRejection[] = [];
  const spanIdentities = new Set<string>();

  input.request.resourceSpans.forEach((resourceSpans, resourceIndex) => {
    const resourcePath = `request.resourceSpans.${resourceIndex}`;
    if (!resourceSpans.scopeSpans.some((scopeSpans) => scopeSpans.spans.some(isGenAiSpan))) return;
    if ((resourceSpans.resource?.droppedAttributesCount ?? 0) > 0) {
      rejections.push(
        rejection("dropped_data", "Resource attributes were dropped", `${resourcePath}.resource`),
      );
      return;
    }

    resourceSpans.scopeSpans.forEach((scopeSpans, scopeIndex) => {
      if (!scopeSpans.spans.some(isGenAiSpan)) return;
      const scopePath = `${resourcePath}.scopeSpans.${scopeIndex}`;
      if ((scopeSpans.scope?.droppedAttributesCount ?? 0) > 0) {
        rejections.push(
          rejection("dropped_data", "Instrumentation scope attributes were dropped", scopePath),
        );
        return;
      }
      if (
        schemaUrl(resourceSpans.schemaUrl, scopeSpans.schemaUrl) !==
        OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL
      ) {
        rejections.push(
          rejection(
            "unsupported_schema",
            `Only ${OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL} is supported`,
            `${scopePath}.schemaUrl`,
          ),
        );
        return;
      }

      scopeSpans.spans.forEach((span, spanIndex) => {
        const spanPath = `${scopePath}.spans.${spanIndex}`;
        const indexed = attributeIndex(span.attributes, `${spanPath}.attributes`);
        if (indexed.rejection) {
          rejections.push(indexed.rejection);
          return;
        }
        const attributes = indexed.attributes as ReadonlyMap<string, OtlpAnyValue | undefined>;
        if (!attributes.has("gen_ai.operation.name")) return;
        const rejectionCount = rejections.length;
        const operation = requiredString(
          attributes,
          "gen_ai.operation.name",
          `${spanPath}.attributes`,
          rejections,
        );
        if (!operation) return;
        if (!MODEL_OPERATIONS.has(operation) && operation !== "execute_tool") {
          rejections.push(
            rejection(
              "unsupported_operation",
              `GenAI operation ${operation} is not supported by this adapter`,
              `${spanPath}.attributes.gen_ai.operation.name`,
            ),
          );
          return;
        }
        if (
          span.droppedAttributesCount > 0 ||
          span.droppedEventsCount > 0 ||
          span.droppedLinksCount > 0 ||
          span.events.some(({ droppedAttributesCount }) => droppedAttributesCount > 0) ||
          span.links.some(({ droppedAttributesCount }) => droppedAttributesCount > 0)
        ) {
          rejections.push(
            rejection("dropped_data", "The GenAI span contains dropped telemetry", spanPath),
          );
        }
        if ((span.flags & 1) !== 1) {
          rejections.push(
            rejection(
              "not_sampled",
              "The GenAI span does not carry the sampled trace flag",
              spanPath,
            ),
          );
        }
        const traceId = identifier(span.traceId, 16);
        const spanId = identifier(span.spanId, 8);
        const parentSpanId = identifier(span.parentSpanId, 8);
        if (!traceId || !spanId || (span.parentSpanId.byteLength > 0 && !parentSpanId)) {
          rejections.push(
            rejection("invalid_identifier", "The GenAI span identity is invalid", spanPath),
          );
        }
        if (!validTimestampRange(span)) {
          rejections.push(
            rejection("invalid_timestamp", "The GenAI span timestamp range is invalid", spanPath),
          );
        }
        if (traceId && spanId) {
          const identity = `${traceId}:${spanId}`;
          if (spanIdentities.has(identity)) {
            rejections.push(
              rejection("duplicate_span", "The GenAI span identity is duplicated", spanPath),
            );
          }
          spanIdentities.add(identity);
        }

        const errorType = optionalString(
          attributes,
          "error.type",
          `${spanPath}.attributes`,
          rejections,
        );
        const outcome = observedOutcome(span, errorType, spanPath, rejections);
        const scope = instrumentationScope(scopeSpans.scope, scopePath, rejections);
        if (span.name.length === 0 || span.name.length > 256) {
          rejections.push(
            rejection(
              "invalid_attribute",
              "OTLP span name must be a non-empty bounded string",
              `${spanPath}.name`,
            ),
          );
        }
        const common = {
          endTimeUnixNano: span.endTimeUnixNano,
          ...(errorType ? { errorType } : {}),
          ...(scope ? { instrumentationScope: scope } : {}),
          observedOutcome: outcome,
          operation,
          ...(parentSpanId ? { parentSpanId } : {}),
          spanId: spanId ?? "",
          spanName: span.name,
          startTimeUnixNano: span.startTimeUnixNano,
          traceId: traceId ?? "",
        } as const;

        if (MODEL_OPERATIONS.has(operation)) {
          if (span.kind !== 1 && span.kind !== 3) {
            rejections.push(
              rejection(
                "unsupported_span_kind",
                "GenAI model spans must use INTERNAL or CLIENT span kind",
                `${spanPath}.kind`,
              ),
            );
          }
          const providerName = requiredString(
            attributes,
            "gen_ai.provider.name",
            `${spanPath}.attributes`,
            rejections,
          );
          const requestedModel = requiredString(
            attributes,
            "gen_ai.request.model",
            `${spanPath}.attributes`,
            rejections,
          );
          const returnedModel = optionalString(
            attributes,
            "gen_ai.response.model",
            `${spanPath}.attributes`,
            rejections,
          );
          const responseId = optionalString(
            attributes,
            "gen_ai.response.id",
            `${spanPath}.attributes`,
            rejections,
          );
          const streaming = optionalBoolean(
            attributes,
            "gen_ai.request.stream",
            `${spanPath}.attributes`,
            rejections,
          );
          if (streaming === true) {
            rejections.push(
              rejection(
                "unsupported_streaming",
                "OTLP streaming chunks cannot prove a complete frame sequence",
                `${spanPath}.attributes.gen_ai.request.stream`,
              ),
            );
          }
          const inputMessages = contentSignal(
            attributes,
            "gen_ai.input.messages",
            true,
            "array",
            `${spanPath}.attributes`,
            rejections,
          );
          const outputMessages = contentSignal(
            attributes,
            "gen_ai.output.messages",
            outcome === "succeeded",
            "array",
            `${spanPath}.attributes`,
            rejections,
          );
          const systemInstructions = contentSignal(
            attributes,
            "gen_ai.system_instructions",
            false,
            "array",
            `${spanPath}.attributes`,
            rejections,
          );
          const toolDefinitions = contentSignal(
            attributes,
            "gen_ai.tool.definitions",
            false,
            "array",
            `${spanPath}.attributes`,
            rejections,
          );
          if (rejections.length === rejectionCount) {
            proposals.push({
              ...common,
              contentSignals: {
                inputMessages: inputMessages as true,
                outputMessages,
                systemInstructions,
                toolDefinitions,
              },
              kind: "model",
              providerName: providerName as string,
              requestedModel: requestedModel as string,
              ...(responseId ? { responseId } : {}),
              ...(returnedModel ? { returnedModel } : {}),
              streaming: false,
            });
          }
          return;
        }

        if (span.kind !== 1) {
          rejections.push(
            rejection(
              "unsupported_span_kind",
              "GenAI tool spans must use INTERNAL span kind",
              `${spanPath}.kind`,
            ),
          );
        }

        const toolName = requiredString(
          attributes,
          "gen_ai.tool.name",
          `${spanPath}.attributes`,
          rejections,
        );
        const toolCallId = requiredString(
          attributes,
          "gen_ai.tool.call.id",
          `${spanPath}.attributes`,
          rejections,
        );
        const toolType = optionalString(
          attributes,
          "gen_ai.tool.type",
          `${spanPath}.attributes`,
          rejections,
        );
        const argumentsPresent = contentSignal(
          attributes,
          "gen_ai.tool.call.arguments",
          true,
          "object",
          `${spanPath}.attributes`,
          rejections,
        );
        const resultPresent = contentSignal(
          attributes,
          "gen_ai.tool.call.result",
          outcome === "succeeded",
          "object",
          `${spanPath}.attributes`,
          rejections,
        );
        if (rejections.length === rejectionCount) {
          proposals.push({
            ...common,
            contentSignals: { arguments: argumentsPresent as true, result: resultPresent },
            kind: "tool",
            sideEffect: "unknown",
            toolCallId: toolCallId as string,
            toolName: toolName as string,
            ...(toolType ? { toolType } : {}),
          });
        }
      });
    });
  });

  if (rejections.length > 0) return rejected(rejections);
  if (proposals.length === 0) {
    return rejected([
      rejection(
        "no_supported_spans",
        "No supported OpenTelemetry GenAI model or tool spans were present",
        "request.resourceSpans",
      ),
    ]);
  }
  return {
    adapter: {
      name: PROOFSTACK_OTEL_GENAI_IMPORT_ADAPTER_NAME,
      version: PROOFSTACK_OTEL_GENAI_IMPORT_ADAPTER_VERSION,
    },
    limitations: PROPOSAL_LIMITATIONS,
    proposals,
    publishable: false,
    semanticConvention: {
      schemaUrl: OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL,
      version: OTEL_GENAI_SEMANTIC_CONVENTION_VERSION,
    },
    sourceFormat: { name: "otlp.trace", version: OTLP_PROTO_VERSION },
    status: "mapped_as_untrusted_proposal",
  };
}
