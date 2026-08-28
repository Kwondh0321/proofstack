import { OtlpDecodeError } from "./errors.js";
import { MAX_OTLP_ANY_VALUE_DEPTH, MAX_OTLP_ANY_VALUE_ITEMS } from "./limits.js";
import type {
  OtlpAnyValue,
  OtlpExportTraceServiceRequest,
  OtlpExportTraceServiceResponse,
  OtlpInstrumentationScope,
  OtlpKeyValue,
  OtlpResource,
  OtlpResourceSpans,
  OtlpRpcStatus,
  OtlpScopeSpans,
  OtlpSpan,
  OtlpSpanEvent,
  OtlpSpanLink,
  OtlpSpanStatus,
} from "./model.js";

const INT64_JSON_FIELDS = new Set([
  "endTimeUnixNano",
  "intValue",
  "startTimeUnixNano",
  "timeUnixNano",
]);
const SIGNED_64_MIN = -(2n ** 63n);
const SIGNED_64_MAX = 2n ** 63n - 1n;
const UNSIGNED_64_MAX = 2n ** 64n - 1n;
const HEX_BYTES = /^(?:[0-9a-fA-F]{2})*$/;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
const BASE64 = /^(?:[A-Za-z0-9+/_-]{4})*(?:[A-Za-z0-9+/_-]{2}(?:==)?|[A-Za-z0-9+/_-]{3}=?)?$/;

interface JsonSourceContext {
  readonly source: string;
}

interface OtlpJsonObject extends Record<string, unknown> {
  readonly arrayValue?: unknown;
  readonly attributes?: unknown;
  readonly boolValue?: unknown;
  readonly bytesValue?: unknown;
  readonly code?: unknown;
  readonly doubleValue?: unknown;
  readonly droppedAttributesCount?: unknown;
  readonly droppedEventsCount?: unknown;
  readonly droppedLinksCount?: unknown;
  readonly endTimeUnixNano?: unknown;
  readonly events?: unknown;
  readonly flags?: unknown;
  readonly intValue?: unknown;
  readonly key?: unknown;
  readonly kind?: unknown;
  readonly kvlistValue?: unknown;
  readonly links?: unknown;
  readonly message?: unknown;
  readonly name?: unknown;
  readonly parentSpanId?: unknown;
  readonly resource?: unknown;
  readonly resourceSpans?: unknown;
  readonly schemaUrl?: unknown;
  readonly scope?: unknown;
  readonly scopeSpans?: unknown;
  readonly spanId?: unknown;
  readonly spans?: unknown;
  readonly startTimeUnixNano?: unknown;
  readonly status?: unknown;
  readonly stringValue?: unknown;
  readonly timeUnixNano?: unknown;
  readonly traceId?: unknown;
  readonly traceState?: unknown;
  readonly value?: unknown;
  readonly values?: unknown;
  readonly version?: unknown;
}

type ContextualJsonParse = (
  text: string,
  reviver: (key: string, value: unknown, context?: JsonSourceContext) => unknown,
) => unknown;

function mappingError(message: string, options?: ErrorOptions): OtlpDecodeError {
  return new OtlpDecodeError("invalid_json_mapping", message, options);
}

function decodeUtf8(payload: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch (cause) {
    throw new OtlpDecodeError("invalid_json", "OTLP/JSON body is not valid UTF-8", { cause });
  }
}

function exactIntegerToken(source: string): string {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(source);
  /* v8 ignore next -- JSON.parse context.source is already a syntactically valid JSON number. */
  if (!match) throw mappingError("OTLP 64-bit integer is not a valid JSON integer");

  const sign = match[1] as string;
  const whole = match[2] as string;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent)) {
    throw mappingError("OTLP 64-bit integer exponent is outside the supported range");
  }

  const digits = `${whole}${fraction}`;
  const scale = exponent - fraction.length;
  let integerDigits: string;
  if (scale >= 0) {
    if (digits.length + scale > 21) {
      throw mappingError("OTLP 64-bit integer is outside the supported range");
    }
    integerDigits = `${digits}${"0".repeat(scale)}`;
  } else {
    const boundary = digits.length + scale;
    if (boundary <= 0 || !/^0*$/.test(digits.slice(boundary))) {
      throw mappingError("OTLP 64-bit integer JSON number has a fractional value");
    }
    integerDigits = digits.slice(0, boundary);
  }

  const canonicalDigits = integerDigits.replace(/^0+(?=[0-9])/, "");
  return `${sign}${canonicalDigits}`;
}

function parseJson(text: string): unknown {
  try {
    return (JSON.parse as ContextualJsonParse)(text, (key, value, context) => {
      if (typeof value === "number" && INT64_JSON_FIELDS.has(key) && !Number.isSafeInteger(value)) {
        /* v8 ignore next -- Node >=24 supplies context.source to primitive reviver calls. */
        if (!context?.source) {
          throw mappingError("Runtime cannot preserve an OTLP 64-bit JSON number");
        }
        return exactIntegerToken(context.source);
      }
      return value;
    });
  } catch (cause) {
    if (cause instanceof OtlpDecodeError) throw cause;
    throw new OtlpDecodeError("invalid_json", "OTLP/JSON body is not valid JSON", { cause });
  }
}

function object(value: unknown, field: string): OtlpJsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw mappingError(`${field} must be an object`);
  }
  return value as OtlpJsonObject;
}

function optionalObject(value: unknown, field: string): OtlpJsonObject | undefined {
  return value === undefined || value === null ? undefined : object(value, field);
}

function array(value: unknown, field: string): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw mappingError(`${field} must be an array`);
  return value;
}

function string(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw mappingError(`${field} must be a string`);
  return value;
}

function uint32(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > 0xffff_ffff) {
    throw mappingError(`${field} must be an unsigned 32-bit JSON number`);
  }
  return value;
}

function enumNumber(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || typeof value !== "number") {
    throw mappingError(`${field} must be an integer enum value`);
  }
  return value;
}

function integer64(value: unknown, field: string, unsigned = false): string {
  if (value === undefined || value === null) return "0";
  const candidate = typeof value === "number" && Number.isSafeInteger(value) ? `${value}` : value;
  if (typeof candidate !== "string" || !INTEGER.test(candidate)) {
    throw mappingError(`${field} must be a decimal 64-bit integer`);
  }

  const parsed = BigInt(candidate);
  const minimum = unsigned ? 0n : SIGNED_64_MIN;
  const maximum = unsigned ? UNSIGNED_64_MAX : SIGNED_64_MAX;
  if (parsed < minimum || parsed > maximum) {
    throw mappingError(`${field} is outside the ${unsigned ? "unsigned" : "signed"} 64-bit range`);
  }
  return parsed.toString();
}

function double(value: unknown, field: string): number | "Infinity" | "-Infinity" | "NaN" {
  if (typeof value === "number") return value;
  if (value === "Infinity" || value === "-Infinity" || value === "NaN") return value;
  throw mappingError(`${field} must be a JSON number or a Protobuf non-finite string`);
}

function hexBytes(value: unknown, field: string): Uint8Array {
  const encoded = string(value, field);
  if (!HEX_BYTES.test(encoded))
    throw mappingError(`${field} must be an even-length hexadecimal string`);
  return Uint8Array.from(Buffer.from(encoded, "hex"));
}

function base64Bytes(value: unknown, field: string): Uint8Array {
  const encoded = string(value, field);
  if (!BASE64.test(encoded)) throw mappingError(`${field} must be a valid base64 string`);
  const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const bytes = Buffer.from(padded, "base64");
  if (bytes.toString("base64") !== padded) {
    throw mappingError(`${field} must be a canonical base64 value`);
  }
  return Uint8Array.from(bytes);
}

function anyValue(value: unknown, field: string, depth = 0): OtlpAnyValue {
  if (value === undefined || value === null) return {};
  if (depth > MAX_OTLP_ANY_VALUE_DEPTH) {
    throw mappingError(`${field} exceeds the OTLP AnyValue depth limit`);
  }
  const input = object(value, field);
  const candidates = [
    "arrayValue",
    "boolValue",
    "bytesValue",
    "doubleValue",
    "intValue",
    "kvlistValue",
    "stringValue",
  ] as const;
  const known = candidates.filter((key) => input[key] !== undefined && input[key] !== null);
  if (known.length > 1) throw mappingError(`${field} sets more than one AnyValue member`);
  const selected = known[0];
  if (!selected) return {};

  switch (selected) {
    case "stringValue":
      return { stringValue: string(input.stringValue, `${field}.stringValue`) };
    case "boolValue":
      if (typeof input.boolValue !== "boolean") {
        throw mappingError(`${field}.boolValue must be a boolean`);
      }
      return { boolValue: input.boolValue };
    case "intValue":
      return { intValue: integer64(input.intValue, `${field}.intValue`) };
    case "doubleValue":
      return { doubleValue: double(input.doubleValue, `${field}.doubleValue`) };
    case "bytesValue":
      return { bytesValue: base64Bytes(input.bytesValue, `${field}.bytesValue`) };
    case "arrayValue": {
      const values = array(
        optionalObject(input.arrayValue, `${field}.arrayValue`)?.values,
        `${field}.arrayValue.values`,
      );
      if (values.length > MAX_OTLP_ANY_VALUE_ITEMS) {
        throw mappingError(`${field}.arrayValue exceeds the item limit`);
      }
      return {
        arrayValue: {
          values: values.map((item, index) =>
            anyValue(item, `${field}.arrayValue.values.${index}`, depth + 1),
          ),
        },
      };
    }
    case "kvlistValue": {
      const values = array(
        optionalObject(input.kvlistValue, `${field}.kvlistValue`)?.values,
        `${field}.kvlistValue.values`,
      );
      if (values.length > MAX_OTLP_ANY_VALUE_ITEMS) {
        throw mappingError(`${field}.kvlistValue exceeds the item limit`);
      }
      return {
        kvlistValue: {
          values: values.map((item, index) =>
            keyValue(item, `${field}.kvlistValue.values.${index}`, depth + 1),
          ),
        },
      };
    }
  }
}

function keyValue(value: unknown, field: string, depth = 0): OtlpKeyValue {
  const input = object(value, field);
  const parsedValue =
    input.value === undefined || input.value === null
      ? undefined
      : anyValue(input.value, `${field}.value`, depth);
  return {
    key: string(input.key, `${field}.key`),
    ...(parsedValue ? { value: parsedValue } : {}),
  };
}

function attributes(value: unknown, field: string): readonly OtlpKeyValue[] {
  return array(value, field).map((item, index) => keyValue(item, `${field}.${index}`));
}

function resource(value: unknown, field: string): OtlpResource | undefined {
  const input = optionalObject(value, field);
  if (!input) return undefined;
  return {
    attributes: attributes(input.attributes, `${field}.attributes`),
    droppedAttributesCount: uint32(input.droppedAttributesCount, `${field}.droppedAttributesCount`),
  };
}

function scope(value: unknown, field: string): OtlpInstrumentationScope | undefined {
  const input = optionalObject(value, field);
  if (!input) return undefined;
  return {
    attributes: attributes(input.attributes, `${field}.attributes`),
    droppedAttributesCount: uint32(input.droppedAttributesCount, `${field}.droppedAttributesCount`),
    name: string(input.name, `${field}.name`),
    version: string(input.version, `${field}.version`),
  };
}

function spanEvent(value: unknown, field: string): OtlpSpanEvent {
  const input = object(value, field);
  return {
    attributes: attributes(input.attributes, `${field}.attributes`),
    droppedAttributesCount: uint32(input.droppedAttributesCount, `${field}.droppedAttributesCount`),
    name: string(input.name, `${field}.name`),
    timeUnixNano: integer64(input.timeUnixNano, `${field}.timeUnixNano`, true),
  };
}

function spanLink(value: unknown, field: string): OtlpSpanLink {
  const input = object(value, field);
  return {
    attributes: attributes(input.attributes, `${field}.attributes`),
    droppedAttributesCount: uint32(input.droppedAttributesCount, `${field}.droppedAttributesCount`),
    flags: uint32(input.flags, `${field}.flags`),
    spanId: hexBytes(input.spanId, `${field}.spanId`),
    traceId: hexBytes(input.traceId, `${field}.traceId`),
    traceState: string(input.traceState, `${field}.traceState`),
  };
}

function spanStatus(value: unknown, field: string): OtlpSpanStatus | undefined {
  const input = optionalObject(value, field);
  if (!input) return undefined;
  return {
    code: enumNumber(input.code, `${field}.code`),
    message: string(input.message, `${field}.message`),
  };
}

function span(value: unknown, field: string): OtlpSpan {
  const input = object(value, field);
  const parsedStatus = spanStatus(input.status, `${field}.status`);
  return {
    attributes: attributes(input.attributes, `${field}.attributes`),
    droppedAttributesCount: uint32(input.droppedAttributesCount, `${field}.droppedAttributesCount`),
    droppedEventsCount: uint32(input.droppedEventsCount, `${field}.droppedEventsCount`),
    droppedLinksCount: uint32(input.droppedLinksCount, `${field}.droppedLinksCount`),
    endTimeUnixNano: integer64(input.endTimeUnixNano, `${field}.endTimeUnixNano`, true),
    events: array(input.events, `${field}.events`).map((item, index) =>
      spanEvent(item, `${field}.events.${index}`),
    ),
    flags: uint32(input.flags, `${field}.flags`),
    kind: enumNumber(input.kind, `${field}.kind`),
    links: array(input.links, `${field}.links`).map((item, index) =>
      spanLink(item, `${field}.links.${index}`),
    ),
    name: string(input.name, `${field}.name`),
    parentSpanId: hexBytes(input.parentSpanId, `${field}.parentSpanId`),
    spanId: hexBytes(input.spanId, `${field}.spanId`),
    startTimeUnixNano: integer64(input.startTimeUnixNano, `${field}.startTimeUnixNano`, true),
    ...(parsedStatus ? { status: parsedStatus } : {}),
    traceId: hexBytes(input.traceId, `${field}.traceId`),
    traceState: string(input.traceState, `${field}.traceState`),
  };
}

function scopeSpans(value: unknown, field: string): OtlpScopeSpans {
  const input = object(value, field);
  const parsedScope = scope(input.scope, `${field}.scope`);
  return {
    schemaUrl: string(input.schemaUrl, `${field}.schemaUrl`),
    ...(parsedScope ? { scope: parsedScope } : {}),
    spans: array(input.spans, `${field}.spans`).map((item, index) =>
      span(item, `${field}.spans.${index}`),
    ),
  };
}

function resourceSpans(value: unknown, field: string): OtlpResourceSpans {
  const input = object(value, field);
  const parsedResource = resource(input.resource, `${field}.resource`);
  return {
    ...(parsedResource ? { resource: parsedResource } : {}),
    schemaUrl: string(input.schemaUrl, `${field}.schemaUrl`),
    scopeSpans: array(input.scopeSpans, `${field}.scopeSpans`).map((item, index) =>
      scopeSpans(item, `${field}.scopeSpans.${index}`),
    ),
  };
}

export function decodeOtlpJson(payload: string | Uint8Array): OtlpExportTraceServiceRequest {
  const root = object(
    parseJson(typeof payload === "string" ? payload : decodeUtf8(payload)),
    "request",
  );
  return {
    resourceSpans: array(root.resourceSpans, "request.resourceSpans").map((item, index) =>
      resourceSpans(item, `request.resourceSpans.${index}`),
    ),
  };
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function encodeOtlpJsonTraceResponse(response: OtlpExportTraceServiceResponse): Uint8Array {
  const partialSuccess = response.partialSuccess;
  return encodeJson(
    partialSuccess
      ? {
          partialSuccess: {
            errorMessage: partialSuccess.errorMessage,
            rejectedSpans: `${partialSuccess.rejectedSpans}`,
          },
        }
      : {},
  );
}

export function encodeOtlpJsonStatus(status: OtlpRpcStatus): Uint8Array {
  return encodeJson({
    ...(status.code !== undefined ? { code: status.code } : {}),
    message: status.message,
  });
}
