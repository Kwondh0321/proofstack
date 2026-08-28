import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { OtlpDecodeError } from "./errors.js";
import { decodeOtlpJson } from "./json-codec.js";
import {
  decodeOtlpProtobuf,
  encodeOtlpProtobufRequest,
  encodeOtlpProtobufStatus,
  encodeOtlpProtobufTraceResponse,
} from "./protobuf-codec.js";
import { protobufType } from "./protobuf-schema.js";

const upstreamTrace = readFileSync(
  new URL("../testdata/trace-v1.11.json", import.meta.url),
  "utf8",
);

describe("OTLP/Protobuf codec", () => {
  it("round-trips the upstream JSON fixture through the binary schema", () => {
    const expected = decodeOtlpJson(upstreamTrace);
    const encoded = encodeOtlpProtobufRequest(expected);
    const decoded = decodeOtlpProtobuf(encoded);

    expect(decoded).toEqual(expected);
  });

  it("preserves nested AnyValue, non-finite doubles, events, links, and status", () => {
    const expected = decodeOtlpJson(
      JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                {
                  key: "nested",
                  value: {
                    kvlistValue: {
                      values: [
                        {
                          key: "items",
                          value: {
                            arrayValue: {
                              values: [{ doubleValue: "Infinity" }, { bytesValue: "AQI=" }],
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    endTimeUnixNano: "1787930001000000000",
                    events: [
                      {
                        name: "event",
                        timeUnixNano: "1787930000500000000",
                      },
                    ],
                    links: [
                      {
                        spanId: "1111111111111111",
                        traceId: "22222222222222222222222222222222",
                      },
                    ],
                    name: "binary",
                    spanId: "eee19b7ec3c1b174",
                    startTimeUnixNano: "1787930000000000000",
                    status: { code: 2, message: "failed" },
                    traceId: "5b8efff798038103d269b633813fc60c",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(decodeOtlpProtobuf(encodeOtlpProtobufRequest(expected))).toEqual(expected);
  });

  it("ignores a forward-compatible unknown top-level wire field", () => {
    const encoded = encodeOtlpProtobufRequest(decodeOtlpJson(upstreamTrace));
    const withUnknown = Uint8Array.from([...encoded, 0x9a, 0x06, 0x00]);

    expect(decodeOtlpProtobuf(withUnknown)).toEqual(decodeOtlpProtobuf(encoded));
  });

  it("decodes an empty binary request as a successful empty message", () => {
    expect(decodeOtlpProtobuf(new Uint8Array())).toEqual({ resourceSpans: [] });
  });

  it("rejects truncated and malformed binary messages with a stable code", () => {
    for (const payload of [new Uint8Array([0x0a, 0x02, 0x01]), new Uint8Array([0x80])]) {
      expect(() => decodeOtlpProtobuf(payload)).toThrowError(
        expect.objectContaining({
          code: "invalid_protobuf",
        } satisfies Partial<OtlpDecodeError>),
      );
    }
  });

  it("encodes full success, partial success, and RPC status messages", () => {
    expect(encodeOtlpProtobufTraceResponse({})).toEqual(new Uint8Array());
    expect(
      Buffer.from(
        encodeOtlpProtobufTraceResponse({
          partialSuccess: { errorMessage: "bad", rejectedSpans: 2 },
        }),
      ).toString("hex"),
    ).toBe("0a0708021203626164");
    expect(Buffer.from(encodeOtlpProtobufStatus({ code: 3, message: "bad" })).toString("hex")).toBe(
      "08031203626164",
    );
  });

  it("exposes only the three reviewed message roots", () => {
    expect(protobufType("request").name).toBe("ExportTraceServiceRequest");
    expect(protobufType("response").name).toBe("ExportTraceServiceResponse");
    expect(protobufType("status").name).toBe("Status");
  });
});
