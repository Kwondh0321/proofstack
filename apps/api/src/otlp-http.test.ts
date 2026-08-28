import { gzipSync } from "node:zlib";
import { encodeOtlpProtobufRequest } from "@proofstack/otlp";
import { describe, expect, it } from "vitest";
import {
  decodeOtlpHttpRequest,
  decompressOtlpBody,
  encodeOtlpStatus,
  encodeOtlpTraceResponse,
  OtlpHttpError,
  parseOtlpContentEncoding,
  parseOtlpMediaType,
} from "./otlp-http.js";

const jsonRequest = JSON.stringify({ resourceSpans: [] });
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

describe("OTLP HTTP transport", () => {
  it.each([
    ["application/json", "json"],
    ["Application/JSON; Charset=UTF-8", "json"],
    ["application/x-protobuf", "protobuf"],
  ] as const)("recognizes media type %s", (value, encoding) => {
    expect(parseOtlpMediaType(value)).toBe(encoding);
  });

  it.each([
    undefined,
    "text/plain",
    "application/json; charset=latin1",
    "application/json; charset=utf-8; profile=otlp",
    "application/x-protobuf; charset=binary",
  ])("rejects unsupported media type %s", (value) => {
    expect(() => parseOtlpMediaType(value)).toThrowError(
      expect.objectContaining({ code: "unsupported_media_type", statusCode: 415 }),
    );
  });

  it("recognizes only identity and gzip content encodings", () => {
    expect(parseOtlpContentEncoding(undefined)).toBe("identity");
    expect(parseOtlpContentEncoding(" Identity ")).toBe("identity");
    expect(parseOtlpContentEncoding("GZIP")).toBe("gzip");
    expect(() => parseOtlpContentEncoding("br")).toThrowError(
      expect.objectContaining({ code: "unsupported_content_encoding", statusCode: 415 }),
    );
  });

  it("passes identity bodies through at the exact decompressed limit", async () => {
    const payload = bytes("1234");
    await expect(decompressOtlpBody(payload, "identity", 4)).resolves.toBe(payload);
    await expect(decompressOtlpBody(payload, "identity", 3)).rejects.toMatchObject({
      code: "body_too_large",
      rpcCode: 8,
      statusCode: 413,
    });
  });

  it("decompresses gzip while stopping expansion beyond the configured limit", async () => {
    const payload = gzipSync(bytes(jsonRequest));
    await expect(decompressOtlpBody(payload, "gzip", 1024)).resolves.toEqual(bytes(jsonRequest));
    await expect(decompressOtlpBody(payload, "gzip", 4)).rejects.toMatchObject({
      code: "body_too_large",
      statusCode: 413,
    });
  });

  it("rejects malformed gzip without exposing zlib details", async () => {
    await expect(decompressOtlpBody(bytes("not-gzip"), "gzip", 1024)).rejects.toMatchObject({
      code: "invalid_compression",
      message: "OTLP gzip request body is invalid",
      statusCode: 400,
    });
  });

  it("decodes JSON and Protobuf trace bodies after transport processing", async () => {
    await expect(
      decodeOtlpHttpRequest(bytes(jsonRequest), "application/json", undefined, 1024),
    ).resolves.toEqual({ encoding: "json", request: { resourceSpans: [] } });

    const protobuf = encodeOtlpProtobufRequest({ resourceSpans: [] });
    await expect(
      decodeOtlpHttpRequest(protobuf, "application/x-protobuf", "identity", 1024),
    ).resolves.toEqual({ encoding: "protobuf", request: { resourceSpans: [] } });
  });

  it.each([
    ["application/json", bytes("{")],
    ["application/x-protobuf", Uint8Array.from([0xff])],
  ])("maps malformed %s bodies to a stable client error", async (mediaType, payload) => {
    await expect(decodeOtlpHttpRequest(payload, mediaType, undefined, 1024)).rejects.toMatchObject({
      code: "invalid_payload",
      message: "OTLP trace request body is invalid",
      rpcCode: 3,
      statusCode: 400,
    });
  });

  it("encodes successful and failed responses in the request representation", () => {
    const jsonSuccess = encodeOtlpTraceResponse("json", {
      partialSuccess: { errorMessage: "one rejected", rejectedSpans: 1 },
    });
    const protobufSuccess = encodeOtlpTraceResponse("protobuf", {
      partialSuccess: { errorMessage: "one rejected", rejectedSpans: 1 },
    });
    const jsonFailure = encodeOtlpStatus("json", { code: 3, message: "invalid request" });
    const protobufFailure = encodeOtlpStatus("protobuf", { code: 13, message: "internal error" });

    expect(jsonSuccess.contentType).toBe("application/json");
    expect(JSON.parse(text(jsonSuccess.body))).toMatchObject({
      partialSuccess: { rejectedSpans: "1" },
    });
    expect(protobufSuccess).toMatchObject({ contentType: "application/x-protobuf" });
    expect(protobufSuccess.body.byteLength).toBeGreaterThan(0);
    expect(JSON.parse(text(jsonFailure.body))).toEqual({ code: 3, message: "invalid request" });
    expect(protobufFailure).toMatchObject({ contentType: "application/x-protobuf" });
    expect(protobufFailure.body.byteLength).toBeGreaterThan(0);
  });

  it("preserves typed transport error identity", () => {
    const error = new OtlpHttpError("invalid_payload", 400, 3, "invalid", {
      cause: new Error("codec detail"),
    });
    expect(error).toMatchObject({
      cause: expect.any(Error),
      code: "invalid_payload",
      name: "OtlpHttpError",
      rpcCode: 3,
      statusCode: 400,
    });
  });
});
