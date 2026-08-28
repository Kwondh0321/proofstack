export type OtlpInteger = number | string;
export type OtlpDouble = number | "Infinity" | "-Infinity" | "NaN";

export interface OtlpAnyValue {
  readonly arrayValue?: { readonly values: readonly OtlpAnyValue[] };
  readonly boolValue?: boolean;
  readonly bytesValue?: Uint8Array;
  readonly doubleValue?: OtlpDouble;
  readonly intValue?: OtlpInteger;
  readonly kvlistValue?: { readonly values: readonly OtlpKeyValue[] };
  readonly stringValue?: string;
}

export interface OtlpKeyValue {
  readonly key: string;
  readonly value?: OtlpAnyValue;
}

export interface OtlpResource {
  readonly attributes: readonly OtlpKeyValue[];
  readonly droppedAttributesCount: number;
}

export interface OtlpInstrumentationScope {
  readonly attributes: readonly OtlpKeyValue[];
  readonly droppedAttributesCount: number;
  readonly name: string;
  readonly version: string;
}

export interface OtlpSpanEvent {
  readonly attributes: readonly OtlpKeyValue[];
  readonly droppedAttributesCount: number;
  readonly name: string;
  readonly timeUnixNano: string;
}

export interface OtlpSpanLink {
  readonly attributes: readonly OtlpKeyValue[];
  readonly droppedAttributesCount: number;
  readonly flags: number;
  readonly spanId: Uint8Array;
  readonly traceId: Uint8Array;
  readonly traceState: string;
}

export interface OtlpSpanStatus {
  readonly code: number;
  readonly message: string;
}

export interface OtlpSpan {
  readonly attributes: readonly OtlpKeyValue[];
  readonly droppedAttributesCount: number;
  readonly droppedEventsCount: number;
  readonly droppedLinksCount: number;
  readonly endTimeUnixNano: string;
  readonly events: readonly OtlpSpanEvent[];
  readonly flags: number;
  readonly kind: number;
  readonly links: readonly OtlpSpanLink[];
  readonly name: string;
  readonly parentSpanId: Uint8Array;
  readonly spanId: Uint8Array;
  readonly startTimeUnixNano: string;
  readonly status?: OtlpSpanStatus;
  readonly traceId: Uint8Array;
  readonly traceState: string;
}

export interface OtlpScopeSpans {
  readonly schemaUrl: string;
  readonly scope?: OtlpInstrumentationScope;
  readonly spans: readonly OtlpSpan[];
}

export interface OtlpResourceSpans {
  readonly resource?: OtlpResource;
  readonly schemaUrl: string;
  readonly scopeSpans: readonly OtlpScopeSpans[];
}

export interface OtlpExportTraceServiceRequest {
  readonly resourceSpans: readonly OtlpResourceSpans[];
}

export interface OtlpTracePartialSuccess {
  readonly errorMessage: string;
  readonly rejectedSpans: number;
}

export interface OtlpExportTraceServiceResponse {
  readonly partialSuccess?: OtlpTracePartialSuccess;
}

export type OtlpHttpEncoding = "json" | "protobuf";
