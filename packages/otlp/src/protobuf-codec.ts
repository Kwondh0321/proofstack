import type { Message } from "protobufjs";
import { decodeOtlpJson } from "./json-codec.js";
import { OtlpDecodeError } from "./errors.js";
import type {
  OtlpExportTraceServiceRequest,
  OtlpExportTraceServiceResponse,
  OtlpRpcStatus,
} from "./model.js";
import {
  exportTraceRequestType,
  exportTraceResponseType,
  rpcStatusType,
} from "./protobuf-schema.js";

const IDENTIFIER_FIELDS = new Set(["parentSpanId", "spanId", "traceId"]);

function toOtlpJsonValue(value: unknown, field?: string): unknown {
  if (field && IDENTIFIER_FIELDS.has(field) && typeof value === "string") {
    return Buffer.from(value, "base64").toString("hex");
  }
  if (Array.isArray(value)) return value.map((item) => toOtlpJsonValue(item));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, toOtlpJsonValue(child, key)]),
  );
}

function protobufObject(message: Message): Record<string, unknown> {
  return message.$type.toObject(message, {
    arrays: true,
    bytes: String,
    enums: Number,
    json: true,
    longs: String,
    objects: true,
    oneofs: true,
  }) as Record<string, unknown>;
}

export function decodeOtlpProtobuf(payload: Uint8Array): OtlpExportTraceServiceRequest {
  try {
    const decoded = exportTraceRequestType.decode(payload);
    const jsonCompatible = toOtlpJsonValue(protobufObject(decoded));
    return decodeOtlpJson(JSON.stringify(jsonCompatible));
  } catch (cause) {
    throw new OtlpDecodeError("invalid_protobuf", "OTLP/Protobuf body is not decodable", {
      cause,
    });
  }
}

export function encodeOtlpProtobufRequest(request: OtlpExportTraceServiceRequest): Uint8Array {
  return Uint8Array.from(
    exportTraceRequestType.encode(exportTraceRequestType.fromObject(request)).finish(),
  );
}

export function encodeOtlpProtobufTraceResponse(
  response: OtlpExportTraceServiceResponse,
): Uint8Array {
  return Uint8Array.from(
    exportTraceResponseType.encode(exportTraceResponseType.fromObject(response)).finish(),
  );
}

export function encodeOtlpProtobufStatus(status: OtlpRpcStatus): Uint8Array {
  return Uint8Array.from(rpcStatusType.encode(rpcStatusType.fromObject(status)).finish());
}
