import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import {
  decodeOtlpJson,
  decodeOtlpProtobuf,
  encodeOtlpJsonStatus,
  encodeOtlpJsonTraceResponse,
  encodeOtlpProtobufStatus,
  encodeOtlpProtobufTraceResponse,
  OtlpDecodeError,
  type OtlpExportTraceServiceRequest,
  type OtlpExportTraceServiceResponse,
  type OtlpHttpEncoding,
  type OtlpRpcStatus,
} from "@proofstack/otlp";

export const OTLP_JSON_MEDIA_TYPE = "application/json";
export const OTLP_PROTOBUF_MEDIA_TYPE = "application/x-protobuf";

const gunzipAsync = promisify(gunzip);

export type OtlpContentEncoding = "gzip" | "identity";
export type OtlpHttpErrorCode =
  | "body_too_large"
  | "invalid_compression"
  | "invalid_payload"
  | "unsupported_content_encoding"
  | "unsupported_media_type";

export interface EncodedOtlpResponse {
  readonly body: Uint8Array;
  readonly contentType: typeof OTLP_JSON_MEDIA_TYPE | typeof OTLP_PROTOBUF_MEDIA_TYPE;
}

export class OtlpHttpError extends Error {
  constructor(
    readonly code: OtlpHttpErrorCode,
    readonly statusCode: number,
    readonly rpcCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OtlpHttpError";
  }
}

function invalidMediaType(): OtlpHttpError {
  return new OtlpHttpError(
    "unsupported_media_type",
    415,
    3,
    "OTLP traces require application/json or application/x-protobuf",
  );
}

export function parseOtlpMediaType(value: string | undefined): OtlpHttpEncoding {
  if (!value) throw invalidMediaType();
  const segments = value.split(";").map((segment) => segment.trim().toLowerCase());
  const mediaType = segments.shift();
  if (mediaType === OTLP_PROTOBUF_MEDIA_TYPE && segments.length === 0) return "protobuf";
  if (
    mediaType === OTLP_JSON_MEDIA_TYPE &&
    (segments.length === 0 || (segments.length === 1 && segments[0] === "charset=utf-8"))
  ) {
    return "json";
  }
  throw invalidMediaType();
}

export function parseOtlpContentEncoding(value: string | undefined): OtlpContentEncoding {
  if (value === undefined || value.trim().toLowerCase() === "identity") return "identity";
  if (value.trim().toLowerCase() === "gzip") return "gzip";
  throw new OtlpHttpError(
    "unsupported_content_encoding",
    415,
    3,
    "OTLP traces support only identity or gzip content encoding",
  );
}

function hasErrorCode(value: unknown, code: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    (value as { readonly code?: unknown }).code === code
  );
}

export async function decompressOtlpBody(
  payload: Uint8Array,
  encoding: OtlpContentEncoding,
  limitBytes: number,
): Promise<Uint8Array> {
  if (encoding === "identity") {
    if (payload.byteLength > limitBytes) {
      throw new OtlpHttpError(
        "body_too_large",
        413,
        8,
        "OTLP request body exceeds the configured decompressed size limit",
      );
    }
    return payload;
  }

  try {
    const decompressed = await gunzipAsync(payload, { maxOutputLength: limitBytes });
    return Uint8Array.from(decompressed);
  } catch (cause) {
    if (hasErrorCode(cause, "ERR_BUFFER_TOO_LARGE")) {
      throw new OtlpHttpError(
        "body_too_large",
        413,
        8,
        "OTLP request body exceeds the configured decompressed size limit",
        { cause },
      );
    }
    throw new OtlpHttpError("invalid_compression", 400, 3, "OTLP gzip request body is invalid", {
      cause,
    });
  }
}

export async function decodeOtlpHttpRequest(
  payload: Uint8Array,
  mediaType: string | undefined,
  contentEncoding: string | undefined,
  decompressedBodyLimitBytes: number,
): Promise<{
  readonly encoding: OtlpHttpEncoding;
  readonly request: OtlpExportTraceServiceRequest;
}> {
  const encoding = parseOtlpMediaType(mediaType);
  const compression = parseOtlpContentEncoding(contentEncoding);
  const body = await decompressOtlpBody(payload, compression, decompressedBodyLimitBytes);
  try {
    return {
      encoding,
      request: encoding === "json" ? decodeOtlpJson(body) : decodeOtlpProtobuf(body),
    };
  } catch (cause) {
    /* v8 ignore next -- Public codecs translate every untrusted decode failure to OtlpDecodeError. */
    if (!(cause instanceof OtlpDecodeError)) throw cause;
    throw new OtlpHttpError("invalid_payload", 400, 3, "OTLP trace request body is invalid", {
      cause,
    });
  }
}

export function encodeOtlpTraceResponse(
  encoding: OtlpHttpEncoding,
  response: OtlpExportTraceServiceResponse,
): EncodedOtlpResponse {
  return encoding === "json"
    ? { body: encodeOtlpJsonTraceResponse(response), contentType: OTLP_JSON_MEDIA_TYPE }
    : {
        body: encodeOtlpProtobufTraceResponse(response),
        contentType: OTLP_PROTOBUF_MEDIA_TYPE,
      };
}

export function encodeOtlpStatus(
  encoding: OtlpHttpEncoding,
  status: OtlpRpcStatus,
): EncodedOtlpResponse {
  return encoding === "json"
    ? { body: encodeOtlpJsonStatus(status), contentType: OTLP_JSON_MEDIA_TYPE }
    : { body: encodeOtlpProtobufStatus(status), contentType: OTLP_PROTOBUF_MEDIA_TYPE };
}
