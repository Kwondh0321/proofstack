import type { JsonObject } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { decodeOtlpJson } from "./json-codec.js";
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
  MAX_OTLP_REDACTED_FIELDS,
  MAX_OTLP_RESOURCE_SPANS,
  MAX_OTLP_SCOPE_SPANS,
  MAX_OTLP_SPANS_PER_REQUEST,
  MAX_OTLP_STRING_BYTES,
} from "./limits.js";
import type {
  OtlpAnyValue,
  OtlpExportTraceServiceRequest,
  OtlpKeyValue,
  OtlpSpan,
} from "./model.js";
import { normalizeOtlpTraceRequest } from "./normalize.js";

function identifier(bytes: number, seed: number): Uint8Array {
  const value = Uint8Array.from({ length: bytes }, (_, index) => index + 1);
  new DataView(value.buffer).setUint32(bytes - 4, seed, false);
  return value;
}

function span(seed = 1, overrides: Partial<OtlpSpan> = {}): OtlpSpan {
  return {
    attributes: [],
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    endTimeUnixNano: "1787930001000000000",
    events: [],
    flags: 1,
    kind: 1,
    links: [],
    name: `span-${seed}`,
    parentSpanId: new Uint8Array(),
    spanId: identifier(8, seed),
    startTimeUnixNano: "1787930000000000000",
    traceId: identifier(16, seed + 20),
    traceState: "",
    ...overrides,
  };
}

function request(
  spans: readonly OtlpSpan[],
  options: {
    readonly resourceAttributes?: readonly OtlpKeyValue[];
    readonly scopeAttributes?: readonly OtlpKeyValue[];
  } = {},
) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: options.resourceAttributes ?? [],
          droppedAttributesCount: 0,
        },
        schemaUrl: "https://opentelemetry.io/schemas/1.0.0",
        scopeSpans: [
          {
            schemaUrl: "https://opentelemetry.io/schemas/1.0.0",
            scope: {
              attributes: options.scopeAttributes ?? [],
              droppedAttributesCount: 0,
              name: "test.instrumentation",
              version: "1.2.3",
            },
            spans,
          },
        ],
      },
    ],
  };
}

function attribute(key: string, value: JsonObject[keyof JsonObject]): OtlpKeyValue {
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "number") return { key, value: { intValue: `${value}` } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: {} };
}

function expectSingleRejection(
  input: OtlpExportTraceServiceRequest,
  reason: string,
): ReturnType<typeof normalizeOtlpTraceRequest> {
  const result = normalizeOtlpTraceRequest(input);
  expect(result).toMatchObject({
    acceptedSpans: 0,
    rejectedSpans: 1,
    rejectionCounts: [{ count: 1, reason }],
    totalSpans: 1,
  });
  return result;
}

function repeatedAttributes(count: number, prefix = "key"): OtlpKeyValue[] {
  return Array.from({ length: count }, (_, index) => attribute(`${prefix}-${index}`, index));
}

describe("OTLP trace normalization", () => {
  it("maps one span into deterministic canonical evidence with OTLP provenance", () => {
    const input = decodeOtlpJson(
      JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "agent-service" } },
                { key: "service.version", value: { stringValue: "2026.8" } },
              ],
              droppedAttributesCount: 2,
            },
            schemaUrl: "https://example.test/resource/1",
            scopeSpans: [
              {
                scope: { name: "otel-agent", version: "3.0.0" },
                schemaUrl: "https://example.test/scope/1",
                spans: [
                  {
                    attributes: [
                      { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
                      { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
                    ],
                    droppedAttributesCount: 3,
                    droppedEventsCount: 4,
                    droppedLinksCount: 5,
                    endTimeUnixNano: "1787930001000000999",
                    flags: 257,
                    kind: 2,
                    name: "invoke support agent",
                    parentSpanId: "1111111111111111",
                    spanId: "eee19b7ec3c1b174",
                    startTimeUnixNano: "1787930000000000123",
                    status: { code: 1, message: "complete" },
                    traceId: "5b8efff798038103d269b633813fc60c",
                    traceState: "vendor=value",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const result = normalizeOtlpTraceRequest(input);
    const record = result.records[0];

    expect(result).toMatchObject({ acceptedSpans: 1, rejectedSpans: 0, totalSpans: 1 });
    expect(result).not.toHaveProperty("errorMessage");
    expect(record).toMatchObject({
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.provider.name": "openai",
      },
      endedAt: "2026-08-28T15:13:21.000Z",
      eventId: "evt_08babcb8abb39fc5cd59551281063adc",
      kind: "agent.run",
      name: "invoke support agent",
      parentSpanId: "1111111111111111",
      source: {
        providerName: "openai",
        sdkName: "otel-agent",
        sdkVersion: "3.0.0",
        serviceName: "agent-service",
        serviceVersion: "2026.8",
      },
      spanId: "eee19b7ec3c1b174",
      startedAt: "2026-08-28T15:13:20.000Z",
      status: "ok",
      traceId: "5b8efff798038103d269b633813fc60c",
    });
    expect(record?.extensions).toMatchObject({
      "opentelemetry.resource": {
        droppedAttributesCount: 2,
        present: true,
        schemaUrl: "https://example.test/resource/1",
      },
      "opentelemetry.scope": {
        name: "otel-agent",
        present: true,
        version: "3.0.0",
      },
      "opentelemetry.span": {
        droppedAttributesCount: 3,
        droppedEventsCount: 4,
        droppedLinksCount: 5,
        endTimeUnixNano: "1787930001000000999",
        startTimeUnixNano: "1787930000000000123",
        statusMessage: "complete",
        statusPresent: true,
        traceState: "vendor=value",
      },
    });
  });

  it.each([
    ["invoke_agent", "agent.run"],
    ["invoke_workflow", "agent.run"],
    ["create_agent", "agent.run"],
    ["execute_tool", "tool.execute"],
    ["retrieval", "retrieval.query"],
    ["chat", "model.generate"],
    ["generate_content", "model.generate"],
    ["text_completion", "model.generate"],
    ["embeddings", "model.generate"],
    ["future_operation", "custom"],
  ])("maps operation %s conservatively to %s", (operation, kind) => {
    const result = normalizeOtlpTraceRequest(
      request([span(1, { attributes: [attribute("gen_ai.operation.name", operation)] })]),
    );

    expect(result.records[0]?.kind).toBe(kind);
  });

  it("honors validated ProofStack hints and source fallbacks", () => {
    const result = normalizeOtlpTraceRequest(
      request(
        [
          span(1, {
            attributes: [
              attribute("proofstack.evidence.kind", "policy.decision"),
              attribute("proofstack.framework.name", "agent-kit"),
              attribute("proofstack.framework.version", "2.0"),
              attribute("proofstack.run.id", "run_001"),
              attribute("proofstack.session.id", "ses_001"),
              attribute("proofstack.sequence", 7),
            ],
            status: { code: 2, message: "denied" },
          }),
        ],
        {
          resourceAttributes: [
            attribute("telemetry.sdk.name", "otel-sdk"),
            attribute("telemetry.sdk.version", "1.0"),
          ],
        },
      ),
    );

    expect(result.records[0]).toMatchObject({
      kind: "policy.decision",
      runId: "run_001",
      sequence: 7,
      sessionId: "ses_001",
      source: {
        frameworkName: "agent-kit",
        frameworkVersion: "2.0",
        sdkName: "test.instrumentation",
        sdkVersion: "1.2.3",
        serviceName: "unknown_service",
      },
      status: "error",
    });
  });

  it("removes known content everywhere and preserves bounded redaction provenance", () => {
    const secret = "DO-NOT-PERSIST";
    const content = attribute("gen_ai.input.messages", secret);
    const result = normalizeOtlpTraceRequest(
      request(
        [
          span(1, {
            attributes: [content, attribute("safe", "metadata")],
            events: [
              {
                attributes: [attribute("gen_ai.tool.call.arguments", secret)],
                droppedAttributesCount: 0,
                name: "tool",
                timeUnixNano: "1787930000500000000",
              },
            ],
            links: [
              {
                attributes: [attribute("gen_ai.output.messages", secret)],
                droppedAttributesCount: 0,
                flags: 1,
                spanId: identifier(8, 90),
                traceId: identifier(16, 80),
                traceState: "",
              },
            ],
          }),
        ],
        { resourceAttributes: [content], scopeAttributes: [content] },
      ),
    );
    const serialized = JSON.stringify(result.records[0]);

    expect(serialized).not.toContain(secret);
    expect(result.records[0]?.attributes).toEqual({ safe: "metadata" });
    expect(result.records[0]?.extensions["proofstack.redaction"]).toEqual({
      fields: [
        "resource.attributes.gen_ai.input.messages",
        "scope.attributes.gen_ai.input.messages",
        "span.attributes.gen_ai.input.messages",
        "events.0.attributes.gen_ai.tool.call.arguments",
        "links.0.attributes.gen_ai.output.messages",
      ],
      ruleset: "otlp-known-content-v1",
      stage: "ingest",
    });
  });

  it("normalizes arbitrary AnyValue without losing integer, byte, or non-finite meaning", () => {
    const result = normalizeOtlpTraceRequest(
      request([
        span(1, {
          attributes: [
            { key: "empty" },
            { key: "small", value: { intValue: "42" } },
            { key: "large", value: { intValue: "9223372036854775807" } },
            { key: "bytes", value: { bytesValue: Uint8Array.from([1, 2, 3]) } },
            { key: "nan", value: { doubleValue: Number.NaN } },
            { key: "positive", value: { doubleValue: Number.POSITIVE_INFINITY } },
            { key: "negative", value: { doubleValue: Number.NEGATIVE_INFINITY } },
            { key: "encoded-nan", value: { doubleValue: "NaN" } },
            { key: "finite", value: { doubleValue: 1.25 } },
            {
              key: "nested",
              value: {
                kvlistValue: {
                  values: [
                    {
                      key: "items",
                      value: { arrayValue: { values: [{ boolValue: false }, {}] } },
                    },
                  ],
                },
              },
            },
          ],
        }),
      ]),
    );

    expect(result.records[0]?.attributes).toEqual({
      bytes: "AQID",
      "encoded-nan": "NaN",
      empty: null,
      finite: 1.25,
      large: "9223372036854775807",
      nan: "NaN",
      negative: "-Infinity",
      nested: { items: [false, null] },
      positive: "Infinity",
      small: 42,
    });
  });

  it("rejects malformed or over-complex AnyValue variants", () => {
    let tooDeep: OtlpAnyValue = { boolValue: true };
    for (let index = 0; index <= MAX_OTLP_ANY_VALUE_DEPTH; index += 1) {
      tooDeep = { arrayValue: { values: [tooDeep] } };
    }

    const cases: readonly [string, OtlpAnyValue, string][] = [
      ["invalid integer", { intValue: "not-an-integer" }, "value_limit"],
      ["excessive depth", tooDeep, "value_limit"],
      ["multiple members", { boolValue: true, stringValue: "ambiguous" }, "value_limit"],
      [
        "oversized bytes",
        { bytesValue: new Uint8Array(MAX_OTLP_BYTES_VALUE_BYTES + 1) },
        "value_limit",
      ],
      [
        "oversized array",
        {
          arrayValue: { values: Array.from({ length: MAX_OTLP_ANY_VALUE_ITEMS + 1 }, () => ({})) },
        },
        "value_limit",
      ],
      [
        "oversized map",
        {
          kvlistValue: {
            values: repeatedAttributes(MAX_OTLP_ANY_VALUE_ITEMS + 1, "nested"),
          },
        },
        "value_limit",
      ],
      [
        "duplicate map key",
        {
          kvlistValue: {
            values: [attribute("duplicate", 1), attribute("duplicate", 2)],
          },
        },
        "value_limit",
      ],
      ["oversized string", { stringValue: "x".repeat(MAX_OTLP_STRING_BYTES + 1) }, "string_limit"],
      ["invalid Unicode", { stringValue: "\ud800" }, "string_limit"],
    ];

    for (const [name, value, reason] of cases) {
      const result = expectSingleRejection(
        request([span(1, { attributes: [{ key: name, value }] })]),
        reason,
      );
      expect(result.errorMessage).toContain("Rejected spans:");
    }
  });

  it("uses bounded source defaults when resource and scope metadata are absent or empty", () => {
    const result = normalizeOtlpTraceRequest({
      resourceSpans: [
        {
          resource: {
            attributes: [
              attribute("service.name", ""),
              attribute("service.version", ""),
              attribute("telemetry.sdk.name", ""),
              attribute("telemetry.sdk.version", ""),
              { key: "gen_ai.provider.name", value: { intValue: "7" } },
            ],
            droppedAttributesCount: 0,
          },
          schemaUrl: "",
          scopeSpans: [
            {
              schemaUrl: "",
              spans: [
                span(1, {
                  attributes: [{ key: "gen_ai.provider.name", value: { intValue: "7" } }],
                }),
              ],
            },
          ],
        },
        {
          schemaUrl: "",
          scopeSpans: [{ schemaUrl: "", spans: [span(2)] }],
        },
      ],
    });

    expect(result.records[0]?.source).toEqual({
      sdkName: "opentelemetry",
      sdkVersion: "unknown",
      serviceName: "unknown_service",
    });
    expect(result.records[1]?.extensions).toMatchObject({
      "opentelemetry.resource": {
        droppedAttributesCount: 0,
        present: false,
      },
      "opentelemetry.scope": {
        droppedAttributesCount: 0,
        name: "",
        present: false,
        version: "",
      },
    });
  });

  it("falls back to resource SDK metadata when instrumentation scope is absent", () => {
    const result = normalizeOtlpTraceRequest({
      resourceSpans: [
        {
          resource: {
            attributes: [
              attribute("telemetry.sdk.name", "resource-sdk"),
              attribute("telemetry.sdk.version", "9.1"),
            ],
            droppedAttributesCount: 0,
          },
          schemaUrl: "",
          scopeSpans: [{ schemaUrl: "", spans: [span()] }],
        },
      ],
    });

    expect(result.records[0]?.source).toMatchObject({
      sdkName: "resource-sdk",
      sdkVersion: "9.1",
    });
  });

  it.each([
    ["zero trace", { traceId: new Uint8Array(16) }, "identifier"],
    ["short span", { spanId: new Uint8Array(7) }, "identifier"],
    ["self parent", { parentSpanId: identifier(8, 1) }, "identifier"],
    ["zero start", { startTimeUnixNano: "0" }, "timestamp"],
    ["invalid start", { startTimeUnixNano: "invalid" }, "timestamp"],
    ["out-of-range end", { endTimeUnixNano: "253402300800000000000" }, "timestamp"],
    ["backwards time", { endTimeUnixNano: "1787929999000000000" }, "timestamp"],
    ["empty name", { name: "" }, "string_limit"],
    ["oversized name", { name: "x".repeat(257) }, "string_limit"],
    ["invalid name Unicode", { name: "\ud800" }, "string_limit"],
    [
      "unknown kind hint",
      { attributes: [attribute("proofstack.evidence.kind", "unknown")] },
      "invalid_reserved_attribute",
    ],
    [
      "invalid run hint",
      { attributes: [attribute("proofstack.run.id", "INVALID")] },
      "invalid_reserved_attribute",
    ],
    [
      "unsafe sequence",
      { attributes: [{ key: "proofstack.sequence", value: { intValue: "9223372036854775807" } }] },
      "invalid_reserved_attribute",
    ],
    [
      "non-string framework",
      { attributes: [{ key: "proofstack.framework.name", value: { intValue: "1" } }] },
      "invalid_reserved_attribute",
    ],
    [
      "empty framework",
      { attributes: [attribute("proofstack.framework.name", "")] },
      "invalid_reserved_attribute",
    ],
  ])("partially rejects %s", (_name, overrides, reason) => {
    const result = normalizeOtlpTraceRequest(request([span(1, overrides as Partial<OtlpSpan>)]));

    expect(result).toMatchObject({
      acceptedSpans: 0,
      errorMessage: expect.stringContaining("Rejected spans:"),
      rejectedSpans: 1,
      rejectionCounts: [{ count: 1, reason }],
      totalSpans: 1,
    });
  });

  it("enforces span, event, and link structural bounds", () => {
    const event = {
      attributes: [] as OtlpKeyValue[],
      droppedAttributesCount: 0,
      name: "event",
      timeUnixNano: "1787930000500000000",
    };
    const link = {
      attributes: [] as OtlpKeyValue[],
      droppedAttributesCount: 0,
      flags: 0,
      spanId: identifier(8, 91),
      traceId: identifier(16, 92),
      traceState: "",
    };
    const cases: readonly [string, Partial<OtlpSpan>, string][] = [
      [
        "span attributes",
        { attributes: repeatedAttributes(MAX_OTLP_ATTRIBUTES + 1) },
        "attribute_limit",
      ],
      [
        "events",
        { events: Array.from({ length: MAX_OTLP_EVENTS + 1 }, () => event) },
        "event_limit",
      ],
      [
        "event attributes",
        { events: [{ ...event, attributes: repeatedAttributes(MAX_OTLP_EVENT_ATTRIBUTES + 1) }] },
        "value_limit",
      ],
      ["event name", { events: [{ ...event, name: "" }] }, "event_limit"],
      ["event timestamp", { events: [{ ...event, timeUnixNano: "invalid" }] }, "timestamp"],
      ["links", { links: Array.from({ length: MAX_OTLP_LINKS + 1 }, () => link) }, "link_limit"],
      [
        "link attributes",
        { links: [{ ...link, attributes: repeatedAttributes(MAX_OTLP_LINK_ATTRIBUTES + 1) }] },
        "value_limit",
      ],
      ["link identifier", { links: [{ ...link, traceId: new Uint8Array(16) }] }, "identifier"],
      ["link trace state", { links: [{ ...link, traceState: "x".repeat(513) }] }, "link_limit"],
    ];

    for (const [_name, overrides, reason] of cases) {
      expectSingleRejection(request([span(1, overrides)]), reason);
    }
  });

  it("rejects excessive accumulated redaction provenance", () => {
    const content = attribute("gen_ai.input.messages", "secret");
    const events = Array.from({ length: MAX_OTLP_REDACTED_FIELDS }, (_, index) => ({
      attributes: [content],
      droppedAttributesCount: 0,
      name: `event-${index}`,
      timeUnixNano: "1787930000500000000",
    }));

    expectSingleRejection(
      request([span(1, { events })], { resourceAttributes: [content] }),
      "redaction_limit",
    );
  });

  it("applies invalid resource and scope context to every contained span", () => {
    const invalidResource = normalizeOtlpTraceRequest(
      request([span(1)], { resourceAttributes: repeatedAttributes(MAX_OTLP_ATTRIBUTES + 1) }),
    );
    const invalidScope = normalizeOtlpTraceRequest(
      request([span(2)], { scopeAttributes: repeatedAttributes(MAX_OTLP_ATTRIBUTES + 1) }),
    );

    expect(invalidResource.rejectionCounts).toEqual([{ count: 1, reason: "attribute_limit" }]);
    expect(invalidScope.rejectionCounts).toEqual([{ count: 1, reason: "attribute_limit" }]);
  });

  it("bounds resource and scope group fan-out before accepting spans", () => {
    const resourceGroups = Array.from({ length: MAX_OTLP_RESOURCE_SPANS + 1 }, (_, index) => ({
      schemaUrl: "",
      scopeSpans: [
        {
          schemaUrl: "",
          spans: index === MAX_OTLP_RESOURCE_SPANS ? [span(1)] : [],
        },
      ],
    }));
    const scopeGroups = Array.from({ length: MAX_OTLP_SCOPE_SPANS + 1 }, (_, index) => ({
      schemaUrl: "",
      spans: index === MAX_OTLP_SCOPE_SPANS ? [span(2)] : [],
    }));

    expectSingleRejection({ resourceSpans: resourceGroups }, "resource_group_limit");
    expectSingleRejection(
      { resourceSpans: [{ schemaUrl: "", scopeSpans: scopeGroups }] },
      "scope_group_limit",
    );
  });

  it("rejects duplicate attributes and duplicate span identity without losing earlier spans", () => {
    const duplicateAttributes = span(2, {
      attributes: [attribute("same", "one"), attribute("same", "two")],
    });
    const result = normalizeOtlpTraceRequest(request([span(1), span(1), duplicateAttributes]));

    expect(result.acceptedSpans).toBe(1);
    expect(result.rejectedSpans).toBe(2);
    expect(result.rejectionCounts).toEqual([
      { count: 1, reason: "duplicate_span" },
      { count: 1, reason: "attribute_limit" },
    ]);
  });

  it("enforces the atomic canonical batch and absolute wire span bounds", () => {
    const spans = Array.from({ length: MAX_OTLP_SPANS_PER_REQUEST + 2 }, (_, index) =>
      span(index + 1),
    );
    const result = normalizeOtlpTraceRequest(request(spans));

    expect(result.acceptedSpans).toBe(MAX_ACCEPTED_OTLP_SPANS);
    expect(result.totalSpans).toBe(MAX_OTLP_SPANS_PER_REQUEST + 2);
    expect(result.rejectionCounts).toEqual([
      {
        count: MAX_OTLP_SPANS_PER_REQUEST - MAX_ACCEPTED_OTLP_SPANS,
        reason: "batch_limit",
      },
      { count: 2, reason: "wire_span_limit" },
    ]);
  });

  it("accepts an empty request without inventing a partial success", () => {
    expect(normalizeOtlpTraceRequest({ resourceSpans: [] })).toEqual({
      acceptedSpans: 0,
      records: [],
      rejectedSpans: 0,
      rejectionCounts: [],
      schemaVersion: "0.1",
      totalSpans: 0,
    });
  });
});
