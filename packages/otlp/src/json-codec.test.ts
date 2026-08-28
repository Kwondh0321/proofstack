import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { OtlpDecodeError } from "./errors.js";
import { decodeOtlpJson, encodeOtlpJsonStatus, encodeOtlpJsonTraceResponse } from "./json-codec.js";

const upstreamTrace = readFileSync(
  new URL("../testdata/trace-v1.11.json", import.meta.url),
  "utf8",
);

function request(span: Record<string, unknown>, additions: Record<string, unknown> = {}): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "test-service" } }],
        },
        scopeSpans: [{ scope: { name: "test-scope" }, spans: [span] }],
        ...additions,
      },
    ],
  });
}

const validSpan = {
  endTimeUnixNano: "1787930001000000000",
  name: "test span",
  spanId: "eee19b7ec3c1b174",
  startTimeUnixNano: "1787930000000000000",
  traceId: "5b8efff798038103d269b633813fc60c",
};

describe("OTLP/JSON decoder", () => {
  it("decodes the pinned upstream trace fixture and applies Protobuf defaults", () => {
    const decoded = decodeOtlpJson(upstreamTrace);
    const resource = decoded.resourceSpans[0];
    const scope = resource?.scopeSpans[0];
    const span = scope?.spans[0];

    expect(resource).toMatchObject({
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "my.service" } }],
        droppedAttributesCount: 0,
      },
      schemaUrl: "",
    });
    expect(scope).toMatchObject({
      scope: { name: "my.library", version: "1.0.0" },
      schemaUrl: "",
    });
    expect(Buffer.from(span?.traceId ?? []).toString("hex")).toBe(
      "5b8efff798038103d269b633813fc60c",
    );
    expect(span).toMatchObject({
      droppedAttributesCount: 0,
      endTimeUnixNano: "1544712661000000000",
      flags: 0,
      kind: 2,
      startTimeUnixNano: "1544712660000000000",
      traceState: "",
    });
  });

  it("preserves unsafe numeric int64 tokens, including exponent notation", () => {
    const input = request(validSpan)
      .replace('"1787930000000000000"', "1.787930000000000000e18")
      .replace('"1787930001000000000"', "1787930001000000000");
    const decoded = decodeOtlpJson(input);
    const span = decoded.resourceSpans[0]?.scopeSpans[0]?.spans[0];

    expect(span?.startTimeUnixNano).toBe("1787930000000000000");
    expect(span?.endTimeUnixNano).toBe("1787930001000000000");
  });

  it("canonicalizes signed and negative-scale numeric int64 tokens", () => {
    const decoded = decodeOtlpJson(
      request({
        ...validSpan,
        attributes: [{ key: "signed", value: { intValue: -9.007199254740992e15 } }],
        startTimeUnixNano: 9.007199254740992e15,
      }).replace("9007199254740992", "9.0071992547409920e15"),
    );
    const span = decoded.resourceSpans[0]?.scopeSpans[0]?.spans[0];

    expect(span?.startTimeUnixNano).toBe("9007199254740992");
    expect(span?.attributes[0]?.value).toEqual({ intValue: "-9007199254740992" });
  });

  it("decodes every AnyValue member and URL-safe unpadded base64", () => {
    const decoded = decodeOtlpJson(
      request({
        ...validSpan,
        attributes: [
          { key: "empty", value: {} },
          { key: "text", value: { stringValue: "hello" } },
          { key: "boolean", value: { boolValue: false } },
          { key: "integer", value: { intValue: "9223372036854775807" } },
          { key: "double", value: { doubleValue: 1.25 } },
          { key: "infinite", value: { doubleValue: "-Infinity" } },
          { key: "bytes", value: { bytesValue: "-_8" } },
          {
            key: "array",
            value: { arrayValue: { values: [{ stringValue: "nested" }, null] } },
          },
          {
            key: "map",
            value: {
              kvlistValue: {
                values: [{ key: "nested", value: { intValue: 42 } }],
              },
            },
          },
          { key: "missing" },
        ],
      }),
    );
    const attributes = decoded.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes;

    expect(attributes).toHaveLength(10);
    expect(attributes?.[2]?.value).toEqual({ boolValue: false });
    expect(attributes?.[3]?.value).toEqual({ intValue: "9223372036854775807" });
    expect(attributes?.[5]?.value).toEqual({ doubleValue: "-Infinity" });
    expect(Buffer.from(attributes?.[6]?.value?.bytesValue ?? []).toString("hex")).toBe("fbff");
    expect(attributes?.[7]?.value?.arrayValue?.values[1]).toEqual({});
    expect(attributes?.[8]?.value?.kvlistValue?.values[0]).toMatchObject({
      key: "nested",
      value: { intValue: "42" },
    });
    expect(attributes?.[9]).toEqual({ key: "missing" });
  });

  it("decodes optional resource, scope, status, event, link, counters, and unknown fields", () => {
    const decoded = decodeOtlpJson(
      JSON.stringify({
        futureTopLevelField: true,
        resourceSpans: [
          {
            schemaUrl: "https://example.test/resource/1",
            scopeSpans: [
              {
                schemaUrl: "https://example.test/scope/1",
                spans: [
                  {
                    ...validSpan,
                    droppedAttributesCount: 1,
                    droppedEventsCount: 2,
                    droppedLinksCount: 3,
                    events: [
                      {
                        attributes: [{ key: "event", value: { boolValue: true } }],
                        droppedAttributesCount: 4,
                        name: "event",
                        timeUnixNano: "1787930000500000000",
                      },
                    ],
                    flags: 257,
                    kind: 5,
                    links: [
                      {
                        attributes: [{ key: "link", value: { doubleValue: "NaN" } }],
                        droppedAttributesCount: 5,
                        flags: 1,
                        spanId: "1111111111111111",
                        traceId: "22222222222222222222222222222222",
                        traceState: "vendor=value",
                      },
                    ],
                    parentSpanId: null,
                    status: { code: 2, message: "failed", unknownStatusField: "ignored" },
                    traceState: "proof=value",
                    unknownSpanField: "ignored",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const resource = decoded.resourceSpans[0];
    const scope = resource?.scopeSpans[0];
    const span = scope?.spans[0];

    expect(resource).toEqual({
      schemaUrl: "https://example.test/resource/1",
      scopeSpans: expect.any(Array),
    });
    expect(scope).toMatchObject({ schemaUrl: "https://example.test/scope/1" });
    expect(span).toMatchObject({
      droppedAttributesCount: 1,
      droppedEventsCount: 2,
      droppedLinksCount: 3,
      events: [{ droppedAttributesCount: 4, name: "event" }],
      flags: 257,
      kind: 5,
      links: [{ droppedAttributesCount: 5, traceState: "vendor=value" }],
      status: { code: 2, message: "failed" },
      traceState: "proof=value",
    });
    expect(span?.parentSpanId).toHaveLength(0);
  });

  it("applies scalar defaults to an otherwise empty span message", () => {
    const decoded = decodeOtlpJson(request({}));

    expect(decoded.resourceSpans[0]?.scopeSpans[0]?.spans[0]).toMatchObject({
      endTimeUnixNano: "0",
      kind: 0,
      name: "",
      startTimeUnixNano: "0",
    });
  });

  it.each([
    ["invalid UTF-8", new Uint8Array([0xc3, 0x28]), "invalid_json"],
    ["invalid JSON", "{", "invalid_json"],
    ["non-object root", "[]", "invalid_json_mapping"],
    ["non-array resources", '{"resourceSpans":{}}', "invalid_json_mapping"],
    ["non-object resource", '{"resourceSpans":[false]}', "invalid_json_mapping"],
    ["string enum", request({ ...validSpan, kind: "SPAN_KIND_SERVER" }), "invalid_json_mapping"],
    ["invalid uint32", request({ ...validSpan, flags: -1 }), "invalid_json_mapping"],
    ["oversized uint32", request({ ...validSpan, flags: 0x1_0000_0000 }), "invalid_json_mapping"],
    ["invalid hex", request({ ...validSpan, traceId: "xyz" }), "invalid_json_mapping"],
    ["invalid string field", request({ ...validSpan, name: 12 }), "invalid_json_mapping"],
    [
      "multiple AnyValue members",
      request({
        ...validSpan,
        attributes: [{ key: "bad", value: { boolValue: true, stringValue: "bad" } }],
      }),
      "invalid_json_mapping",
    ],
    [
      "invalid base64",
      request({ ...validSpan, attributes: [{ key: "bad", value: { bytesValue: "***" } }] }),
      "invalid_json_mapping",
    ],
    [
      "noncanonical base64",
      request({ ...validSpan, attributes: [{ key: "bad", value: { bytesValue: "AB==" } }] }),
      "invalid_json_mapping",
    ],
    [
      "invalid int64 type",
      request({ ...validSpan, attributes: [{ key: "bad", value: { intValue: true } }] }),
      "invalid_json_mapping",
    ],
    [
      "noncanonical int64 string",
      request({ ...validSpan, attributes: [{ key: "bad", value: { intValue: "01" } }] }),
      "invalid_json_mapping",
    ],
    [
      "out-of-range int64",
      request({
        ...validSpan,
        attributes: [{ key: "bad", value: { intValue: "9223372036854775808" } }],
      }),
      "invalid_json_mapping",
    ],
    ["negative uint64", request({ ...validSpan, startTimeUnixNano: "-1" }), "invalid_json_mapping"],
    [
      "oversized uint64",
      request({ ...validSpan, startTimeUnixNano: "18446744073709551616" }),
      "invalid_json_mapping",
    ],
    [
      "undersized signed int64",
      request({
        ...validSpan,
        attributes: [{ key: "bad", value: { intValue: "-9223372036854775809" } }],
      }),
      "invalid_json_mapping",
    ],
    [
      "invalid double",
      request({ ...validSpan, attributes: [{ key: "bad", value: { doubleValue: "1.0" } }] }),
      "invalid_json_mapping",
    ],
    [
      "invalid boolean",
      request({ ...validSpan, attributes: [{ key: "bad", value: { boolValue: 1 } }] }),
      "invalid_json_mapping",
    ],
    [
      "oversized numeric exponent",
      request(validSpan).replace('"1787930000000000000"', "1e999999999999999999999"),
      "invalid_json_mapping",
    ],
    [
      "oversized numeric digits",
      request(validSpan).replace('"1787930000000000000"', "1e30"),
      "invalid_json_mapping",
    ],
    [
      "fractional numeric int64",
      request(validSpan).replace('"1787930000000000000"', "1e-20"),
      "invalid_json_mapping",
    ],
  ])("rejects %s", (_name, payload, code) => {
    expect(() => decodeOtlpJson(payload as string | Uint8Array)).toThrowError(
      expect.objectContaining({
        code: code as OtlpDecodeError["code"],
      } satisfies Partial<OtlpDecodeError>),
    );
  });

  it("rejects AnyValue collections and nesting beyond their structural bounds", () => {
    const tooWide = Array.from({ length: 129 }, () => ({ stringValue: "value" }));
    const tooWideMap = Array.from({ length: 129 }, (_, index) => ({
      key: `key-${index}`,
      value: { stringValue: "value" },
    }));
    let nested: Record<string, unknown> = { stringValue: "leaf" };
    for (let depth = 0; depth < 12; depth += 1) {
      nested = { arrayValue: { values: [nested] } };
    }

    expect(() =>
      decodeOtlpJson(
        request({
          ...validSpan,
          attributes: [{ key: "wide", value: { arrayValue: { values: tooWide } } }],
        }),
      ),
    ).toThrow("item limit");
    expect(() =>
      decodeOtlpJson(
        request({
          ...validSpan,
          attributes: [{ key: "wide-map", value: { kvlistValue: { values: tooWideMap } } }],
        }),
      ),
    ).toThrow("item limit");
    expect(() =>
      decodeOtlpJson(request({ ...validSpan, attributes: [{ key: "deep", value: nested }] })),
    ).toThrow("depth limit");
  });

  it("treats null Protobuf fields as unset and ignores snake-case unknown names", () => {
    const decoded = decodeOtlpJson(
      JSON.stringify({ resource_spans: [{ invalid: true }], resourceSpans: null }),
    );

    expect(decoded).toEqual({ resourceSpans: [] });
  });
});

describe("OTLP/JSON response encoder", () => {
  const text = (value: Uint8Array): string => new TextDecoder().decode(value);

  it("encodes empty and partial trace responses with Protobuf JSON int64 spelling", () => {
    expect(text(encodeOtlpJsonTraceResponse({}))).toBe("{}");
    expect(
      JSON.parse(
        text(
          encodeOtlpJsonTraceResponse({
            partialSuccess: {
              errorMessage: "Rejected spans: invalid timestamp (2)",
              rejectedSpans: 2,
            },
          }),
        ),
      ),
    ).toEqual({
      partialSuccess: {
        errorMessage: "Rejected spans: invalid timestamp (2)",
        rejectedSpans: "2",
      },
    });
  });

  it("encodes google.rpc.Status with an optional numeric code", () => {
    expect(JSON.parse(text(encodeOtlpJsonStatus({ code: 3, message: "invalid request" })))).toEqual(
      {
        code: 3,
        message: "invalid request",
      },
    );
    expect(JSON.parse(text(encodeOtlpJsonStatus({ message: "unknown" })))).toEqual({
      message: "unknown",
    });
  });
});
