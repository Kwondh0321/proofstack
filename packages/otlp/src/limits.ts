import { MAX_EVIDENCE_BATCH_SIZE } from "@proofstack/contracts";

export const OTLP_PROTO_VERSION = "1.11.0" as const;
export const MAX_ACCEPTED_OTLP_SPANS = MAX_EVIDENCE_BATCH_SIZE;
export const MAX_OTLP_RESOURCE_SPANS = 64;
export const MAX_OTLP_SCOPE_SPANS = 128;
export const MAX_OTLP_SPANS_PER_REQUEST = 1_024;
export const MAX_OTLP_ATTRIBUTES = 128;
export const MAX_OTLP_EVENT_ATTRIBUTES = 64;
export const MAX_OTLP_EVENTS = 128;
export const MAX_OTLP_LINK_ATTRIBUTES = 64;
export const MAX_OTLP_LINKS = 128;
export const MAX_OTLP_ANY_VALUE_DEPTH = 10;
export const MAX_OTLP_ANY_VALUE_ITEMS = 128;
export const MAX_OTLP_NORMALIZED_VALUE_NODES = 16_384;
export const MAX_OTLP_STRING_BYTES = 64 * 1_024;
export const MAX_OTLP_BYTES_VALUE_BYTES = 64 * 1_024;
export const MAX_OTLP_REDACTED_FIELDS = 128;
