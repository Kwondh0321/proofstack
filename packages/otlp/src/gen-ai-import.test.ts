import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  mapOtlpGenAiInteractionProposals,
  OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL,
  OTEL_GENAI_SEMANTIC_CONVENTION_VERSION,
  type OtlpGenAiImportDeclaration,
  type OtlpGenAiImportResult,
  PROOFSTACK_OTEL_GENAI_IMPORT_ADAPTER_VERSION,
} from "./gen-ai-import.js";
import { decodeOtlpJson } from "./json-codec.js";
import type {
  OtlpAnyValue,
  OtlpExportTraceServiceRequest,
  OtlpKeyValue,
  OtlpResourceSpans,
  OtlpScopeSpans,
  OtlpSpan,
} from "./model.js";

const completeDeclaration = {
  contentCapture: "complete",
  traceCapture: "complete",
} as const satisfies OtlpGenAiImportDeclaration;

function attribute(key: string, value: OtlpAnyValue): OtlpKeyValue {
  return { key, value };
}

function stringAttribute(key: string, value: string): OtlpKeyValue {
  return attribute(key, { stringValue: value });
}

function jsonAttribute(key: string, value: unknown): OtlpKeyValue {
  return stringAttribute(key, JSON.stringify(value));
}

function identifier(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => ((seed + index) % 255) + 1);
}

function span(
  seed: number,
  attributes: readonly OtlpKeyValue[],
  overrides: Partial<OtlpSpan> = {},
  withDefaultStatus = true,
): OtlpSpan {
  const { status, ...rest } = overrides;
  const base = {
    attributes,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    endTimeUnixNano: "1787980001000000000",
    events: [],
    flags: 1,
    kind: 3,
    links: [],
    name: "genai fixture span",
    parentSpanId: new Uint8Array(),
    spanId: identifier(8, seed),
    startTimeUnixNano: "1787980000000000000",
    traceId: identifier(16, 1),
    traceState: "",
    ...rest,
  };
  if (status) return { ...base, status };
  return withDefaultStatus ? { ...base, status: { code: 1, message: "" } } : base;
}

function modelAttributes(overrides: readonly OtlpKeyValue[] = []): readonly OtlpKeyValue[] {
  const replacementKeys = new Set(overrides.map(({ key }) => key));
  return [
    stringAttribute("gen_ai.operation.name", "chat"),
    stringAttribute("gen_ai.provider.name", "openai"),
    stringAttribute("gen_ai.request.model", "model-version-2026-08-01"),
    attribute("gen_ai.request.stream", { boolValue: false }),
    jsonAttribute("gen_ai.input.messages", [
      { parts: [{ content: "sensitive-model-input", type: "text" }], role: "user" },
    ]),
    jsonAttribute("gen_ai.output.messages", [
      {
        finish_reason: "stop",
        parts: [{ content: "sensitive-model-output", type: "text" }],
        role: "assistant",
      },
    ]),
    stringAttribute("gen_ai.response.id", "response-123"),
    stringAttribute("gen_ai.response.model", "model-version-2026-08-15"),
  ]
    .filter(({ key }) => !replacementKeys.has(key))
    .concat(overrides);
}

function toolAttributes(overrides: readonly OtlpKeyValue[] = []): readonly OtlpKeyValue[] {
  const replacementKeys = new Set(overrides.map(({ key }) => key));
  return [
    stringAttribute("gen_ai.operation.name", "execute_tool"),
    stringAttribute("gen_ai.tool.name", "lookup_inventory"),
    stringAttribute("gen_ai.tool.call.id", "call-123"),
    stringAttribute("gen_ai.tool.type", "function"),
    jsonAttribute("gen_ai.tool.call.arguments", { query: "sensitive-tool-arguments" }),
    jsonAttribute("gen_ai.tool.call.result", { value: "sensitive-tool-result" }),
  ]
    .filter(({ key }) => !replacementKeys.has(key))
    .concat(overrides);
}

function scopeGroup(
  spans: readonly OtlpSpan[],
  overrides: Partial<OtlpScopeSpans> = {},
): OtlpScopeSpans {
  return {
    schemaUrl: OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL,
    scope: {
      attributes: [],
      droppedAttributesCount: 0,
      name: "fixture.instrumentation",
      version: "1.0.0",
    },
    spans,
    ...overrides,
  };
}

function resourceGroup(
  scopeSpans: readonly OtlpScopeSpans[],
  overrides: Partial<OtlpResourceSpans> = {},
): OtlpResourceSpans {
  return {
    resource: { attributes: [], droppedAttributesCount: 0 },
    schemaUrl: OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL,
    scopeSpans,
    ...overrides,
  };
}

function requestFrom(resourceSpans: readonly OtlpResourceSpans[]): OtlpExportTraceServiceRequest {
  return { resourceSpans };
}

function request(
  spans: readonly OtlpSpan[],
  schemaUrl: string = OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL,
): OtlpExportTraceServiceRequest {
  return requestFrom([
    resourceGroup([scopeGroup(spans, { schemaUrl })], {
      schemaUrl,
    }),
  ]);
}

function map(
  traceRequest: OtlpExportTraceServiceRequest,
  declaration: OtlpGenAiImportDeclaration = completeDeclaration,
): OtlpGenAiImportResult {
  return mapOtlpGenAiInteractionProposals({ declaration, request: traceRequest });
}

function rejectionCodes(result: OtlpGenAiImportResult): readonly string[] {
  return result.status === "rejected" ? result.rejections.map(({ code }) => code) : [];
}

describe("OpenTelemetry GenAI interaction proposal import", () => {
  it("maps the pinned model and tool fixture without exposing captured content", () => {
    const fixture = decodeOtlpJson(
      readFileSync(new URL("../testdata/gen-ai-semconv-v1.41.0.json", import.meta.url), "utf8"),
    );
    const result = map(fixture);

    expect(result).toMatchObject({
      adapter: { version: PROOFSTACK_OTEL_GENAI_IMPORT_ADAPTER_VERSION },
      proposals: [
        {
          contentSignals: { inputMessages: true, outputMessages: true },
          kind: "model",
          providerName: "openai",
          requestedModel: "model-version-2026-08-01",
        },
        {
          contentSignals: { arguments: true, result: true },
          kind: "tool",
          sideEffect: "unknown",
          toolCallId: "call-123",
        },
      ],
      publishable: false,
      semanticConvention: {
        schemaUrl: OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL,
        version: OTEL_GENAI_SEMANTIC_CONVENTION_VERSION,
      },
      status: "mapped_as_untrusted_proposal",
    });
    expect(JSON.stringify(result)).not.toContain("sensitive-model-input");
    expect(JSON.stringify(result)).not.toContain("sensitive-model-output");
    expect(JSON.stringify(result)).not.toContain("sensitive-tool-arguments");
    expect(JSON.stringify(result)).not.toContain("sensitive-tool-result");
  });

  it("maps provider-neutral structured content without inventing optional provenance", () => {
    const structuredArray: OtlpAnyValue = {
      arrayValue: { values: [{ kvlistValue: { values: [] } }] },
    };
    const structuredObject: OtlpAnyValue = {
      kvlistValue: { values: [stringAttribute("safe-key", "sensitive-structured-value")] },
    };
    const model = span(
      3,
      modelAttributes([
        stringAttribute("gen_ai.operation.name", "generate_content"),
        attribute("gen_ai.input.messages", structuredArray),
        attribute("gen_ai.output.messages", structuredArray),
        attribute("gen_ai.system_instructions", structuredArray),
        attribute("gen_ai.tool.definitions", structuredArray),
      ]).filter(
        ({ key }) =>
          !["gen_ai.request.stream", "gen_ai.response.id", "gen_ai.response.model"].includes(key),
      ),
      { kind: 1 },
    );
    const tool = span(
      4,
      toolAttributes([
        attribute("gen_ai.tool.call.arguments", structuredObject),
        attribute("gen_ai.tool.call.result", structuredObject),
      ]).filter(({ key }) => key !== "gen_ai.tool.type"),
      { kind: 1, parentSpanId: identifier(8, 3) },
    );
    const result = map(
      requestFrom([
        {
          schemaUrl: OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL,
          scopeSpans: [
            scopeGroup([model, tool], {
              scope: {
                attributes: [],
                droppedAttributesCount: 0,
                name: "structured.instrumentation",
                version: "",
              },
            }),
          ],
        },
      ]),
    );

    expect(result).toMatchObject({
      proposals: [
        {
          contentSignals: {
            inputMessages: true,
            outputMessages: true,
            systemInstructions: true,
            toolDefinitions: true,
          },
          instrumentationScope: { name: "structured.instrumentation" },
          kind: "model",
          operation: "generate_content",
        },
        {
          contentSignals: { arguments: true, result: true },
          kind: "tool",
          parentSpanId: Buffer.from(identifier(8, 3)).toString("hex"),
        },
      ],
      status: "mapped_as_untrusted_proposal",
    });
    expect(JSON.stringify(result)).not.toContain("sensitive-structured-value");
  });

  it("ignores unrelated scope metadata while retaining original candidate paths", () => {
    const unrelated = span(1, [stringAttribute("http.request.method", "GET")]);
    const candidate = span(2, modelAttributes());
    const result = map(
      requestFrom([
        resourceGroup([
          scopeGroup([unrelated], {
            schemaUrl: "",
            scope: {
              attributes: [],
              droppedAttributesCount: 1,
              name: "unrelated",
              version: "",
            },
          }),
          scopeGroup([unrelated, candidate]),
        ]),
      ]),
    );

    expect(result).toMatchObject({
      proposals: [{ spanId: Buffer.from(candidate.spanId).toString("hex") }],
    });
  });

  it.each([
    {
      name: "resource-only",
      resourceSchemaUrl: OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL,
      scopeSchemaUrl: "",
    },
    {
      name: "scope-only",
      resourceSchemaUrl: "",
      scopeSchemaUrl: OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL,
    },
  ])("accepts a pinned $name schema declaration", ({ resourceSchemaUrl, scopeSchemaUrl }) => {
    const result = map(
      requestFrom([
        resourceGroup([scopeGroup([span(1, modelAttributes())], { schemaUrl: scopeSchemaUrl })], {
          schemaUrl: resourceSchemaUrl,
        }),
      ]),
    );

    expect(result.status).toBe("mapped_as_untrusted_proposal");
  });

  it("rejects conflicting and absent schema declarations", () => {
    const conflicting = map(
      requestFrom([
        resourceGroup(
          [
            scopeGroup([span(1, modelAttributes())], {
              schemaUrl: "https://opentelemetry.io/schemas/1.40.0",
            }),
          ],
          { schemaUrl: OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL },
        ),
      ]),
    );
    const absent = map(
      requestFrom([
        resourceGroup([scopeGroup([span(2, modelAttributes())], { schemaUrl: "" })], {
          schemaUrl: "",
        }),
      ]),
    );

    expect(rejectionCodes(conflicting)).toEqual(["unsupported_schema"]);
    expect(rejectionCodes(absent)).toEqual(["unsupported_schema"]);
  });

  it.each([
    {
      name: "resource groups",
      traceRequest: requestFrom(Array.from({ length: 65 }, () => resourceGroup([]))),
    },
    {
      name: "scope groups",
      traceRequest: requestFrom([resourceGroup(Array.from({ length: 129 }, () => scopeGroup([])))]),
    },
    {
      name: "spans",
      traceRequest: requestFrom([
        resourceGroup([
          scopeGroup(
            Array.from({ length: 1_025 }, (_, index) =>
              span(index + 1, [stringAttribute("http.request.method", "GET")]),
            ),
          ),
        ]),
      ]),
    },
  ])("rejects oversized $name before semantic mapping", ({ traceRequest }) => {
    expect(rejectionCodes(map(traceRequest))).toEqual(["batch_limit"]);
  });

  it.each(["omitted", "truncated", "unknown"] as const)(
    "rejects %s producer content capture",
    (contentCapture) => {
      const result = map(request([span(1, modelAttributes())]), {
        contentCapture,
        traceCapture: "complete",
      });

      expect(rejectionCodes(result)).toEqual(["content_capture_incomplete"]);
    },
  );

  it.each(["partial", "unknown"] as const)("rejects %s producer trace capture", (traceCapture) => {
    const result = map(request([span(1, modelAttributes())]), {
      contentCapture: "complete",
      traceCapture,
    });

    expect(rejectionCodes(result)).toEqual(["trace_capture_incomplete"]);
  });

  it("rejects unknown convention versions instead of guessing a migration", () => {
    const result = map(
      request([span(1, modelAttributes())], "https://opentelemetry.io/schemas/1.42.0"),
    );

    expect(rejectionCodes(result)).toEqual(["unsupported_schema"]);
  });

  it("rejects unsampled and dropped telemetry", () => {
    const result = map(
      request([
        span(1, modelAttributes(), { flags: 0 }),
        span(2, toolAttributes(), { droppedAttributesCount: 1, kind: 1 }),
      ]),
    );

    expect(rejectionCodes(result)).toEqual(["not_sampled", "dropped_data"]);
  });

  it("rejects streaming because OTLP cannot attest an exact frame sequence", () => {
    const result = map(
      request([
        span(1, modelAttributes([attribute("gen_ai.request.stream", { boolValue: true })])),
      ]),
    );

    expect(rejectionCodes(result)).toEqual(["unsupported_streaming"]);
  });

  it("requires capture-critical model attributes even when the convention marks content opt-in", () => {
    const attributes = modelAttributes().filter(
      ({ key }) => key !== "gen_ai.request.model" && key !== "gen_ai.input.messages",
    );
    const result = map(request([span(1, attributes)]));

    expect(rejectionCodes(result)).toEqual(["missing_attribute", "missing_attribute"]);
  });

  it.each([
    { label: "a missing value", value: undefined },
    { label: "multiple AnyValue members", value: { boolValue: true, stringValue: "value" } },
    { label: "the wrong AnyValue member", value: { boolValue: true } },
    { label: "an empty string", value: { stringValue: "" } },
    { label: "an oversized string", value: { stringValue: "x".repeat(257) } },
  ] satisfies readonly { label: string; value: OtlpAnyValue | undefined }[])(
    "rejects $label for a bounded string attribute",
    ({ value }) => {
      const result = map(
        request([
          span(
            1,
            modelAttributes([
              value === undefined
                ? { key: "gen_ai.response.model" }
                : attribute("gen_ai.response.model", value),
            ]),
          ),
        ]),
      );

      expect(rejectionCodes(result)).toEqual(["invalid_attribute"]);
    },
  );

  it.each([
    { label: "a missing value", value: undefined },
    { label: "multiple AnyValue members", value: { boolValue: false, stringValue: "false" } },
    { label: "a non-boolean member", value: { stringValue: "false" } },
  ] satisfies readonly { label: string; value: OtlpAnyValue | undefined }[])(
    "rejects $label for the streaming flag",
    ({ value }) => {
      const result = map(
        request([
          span(
            1,
            modelAttributes([
              value === undefined
                ? { key: "gen_ai.request.stream" }
                : attribute("gen_ai.request.stream", value),
            ]),
          ),
        ]),
      );

      expect(rejectionCodes(result)).toEqual(["invalid_attribute"]);
    },
  );

  it.each([
    { label: "a missing value", value: undefined },
    {
      label: "multiple AnyValue members",
      value: { arrayValue: { values: [] }, stringValue: "[]" },
    },
    { label: "an empty JSON string", value: { stringValue: "" } },
    { label: "oversized JSON", value: { stringValue: `"${"x".repeat(65_536)}"` } },
    { label: "malformed JSON", value: { stringValue: "[" } },
    { label: "a JSON object", value: { stringValue: "{}" } },
    { label: "a structured object", value: { kvlistValue: { values: [] } } },
  ] satisfies readonly { label: string; value: OtlpAnyValue | undefined }[])(
    "rejects $label where the messages schema requires an array",
    ({ value }) => {
      const result = map(
        request([
          span(
            1,
            modelAttributes([
              value === undefined
                ? { key: "gen_ai.input.messages" }
                : attribute("gen_ai.input.messages", value),
            ]),
          ),
        ]),
      );

      expect(rejectionCodes(result)).toEqual(["invalid_attribute"]);
    },
  );

  it.each([
    { label: "a JSON array", value: { stringValue: "[]" } },
    { label: "JSON null", value: { stringValue: "null" } },
    { label: "a JSON primitive", value: { stringValue: "1" } },
    { label: "a structured array", value: { arrayValue: { values: [] } } },
  ] satisfies readonly { label: string; value: OtlpAnyValue }[])(
    "rejects $label where tool content requires an object",
    ({ value }) => {
      const result = map(
        request([
          span(1, toolAttributes([attribute("gen_ai.tool.call.arguments", value)]), { kind: 1 }),
        ]),
      );

      expect(rejectionCodes(result)).toEqual(["invalid_attribute"]);
    },
  );

  it("rejects a malformed required operation before attempting semantic mapping", () => {
    const result = map(
      request([
        span(1, modelAttributes([attribute("gen_ai.operation.name", { boolValue: true })])),
      ]),
    );

    expect(rejectionCodes(result)).toEqual(["invalid_attribute"]);
  });

  it("requires every tool identity and successful result field", () => {
    const attributes = toolAttributes().filter(
      ({ key }) =>
        ![
          "gen_ai.tool.name",
          "gen_ai.tool.call.id",
          "gen_ai.tool.call.arguments",
          "gen_ai.tool.call.result",
        ].includes(key),
    );
    const result = map(request([span(1, attributes, { kind: 1 })]));

    expect(rejectionCodes(result)).toEqual([
      "missing_attribute",
      "missing_attribute",
      "missing_attribute",
      "missing_attribute",
    ]);
  });

  it("maps explicit failures without inventing absent output content", () => {
    const attributes = modelAttributes([stringAttribute("error.type", "provider_timeout")]).filter(
      ({ key }) => key !== "gen_ai.output.messages",
    );
    const result = map(request([span(1, attributes, { status: { code: 2, message: "" } })]));

    expect(result).toMatchObject({
      proposals: [
        {
          contentSignals: { outputMessages: false },
          errorType: "provider_timeout",
          observedOutcome: "failed",
        },
      ],
      publishable: false,
      status: "mapped_as_untrusted_proposal",
    });
  });

  it("requires error.type for failed spans", () => {
    const result = map(
      request([span(1, modelAttributes(), { status: { code: 2, message: "failed" } })]),
    );

    expect(rejectionCodes(result)).toEqual(["missing_attribute"]);
  });

  it("maps an unset OTLP outcome as indeterminate without requiring output content", () => {
    const attributes = modelAttributes().filter(
      ({ key }) => key !== "gen_ai.output.messages" && key !== "gen_ai.request.stream",
    );
    const result = map(request([span(1, attributes, {}, false)]));

    expect(result).toMatchObject({
      proposals: [{ contentSignals: { outputMessages: false }, observedOutcome: "indeterminate" }],
      status: "mapped_as_untrusted_proposal",
    });
  });

  it("rejects unsupported or contradictory OTLP outcomes", () => {
    const unsupported = map(
      request([span(1, modelAttributes(), { status: { code: 3, message: "unknown" } })]),
    );
    const contradictory = map(
      request([
        span(2, modelAttributes([stringAttribute("error.type", "unexpected")]), {
          status: { code: 1, message: "" },
        }),
      ]),
    );

    expect(rejectionCodes(unsupported)).toEqual(["invalid_attribute"]);
    expect(rejectionCodes(contradictory)).toEqual(["invalid_attribute"]);
  });

  it.each([
    { label: "span attributes", overrides: { droppedAttributesCount: 1 } },
    { label: "span events", overrides: { droppedEventsCount: 1 } },
    { label: "span links", overrides: { droppedLinksCount: 1 } },
    {
      label: "event attributes",
      overrides: {
        events: [
          {
            attributes: [],
            droppedAttributesCount: 1,
            name: "event",
            timeUnixNano: "1787980000000000000",
          },
        ],
      },
    },
    {
      label: "link attributes",
      overrides: {
        links: [
          {
            attributes: [],
            droppedAttributesCount: 1,
            flags: 1,
            spanId: identifier(8, 9),
            traceId: identifier(16, 9),
            traceState: "",
          },
        ],
      },
    },
  ] satisfies readonly { label: string; overrides: Partial<OtlpSpan> }[])(
    "rejects dropped $label",
    ({ overrides }) => {
      expect(rejectionCodes(map(request([span(1, modelAttributes(), overrides)])))).toEqual([
        "dropped_data",
      ]);
    },
  );

  it("rejects dropped resource and instrumentation-scope metadata for candidate spans", () => {
    const droppedResource = map(
      requestFrom([
        resourceGroup([scopeGroup([span(1, modelAttributes())])], {
          resource: { attributes: [], droppedAttributesCount: 1 },
        }),
      ]),
    );
    const droppedScope = map(
      requestFrom([
        resourceGroup([
          scopeGroup([span(2, modelAttributes())], {
            scope: {
              attributes: [],
              droppedAttributesCount: 1,
              name: "fixture.instrumentation",
              version: "1.0.0",
            },
          }),
        ]),
      ]),
    );

    expect(rejectionCodes(droppedResource)).toEqual(["dropped_data"]);
    expect(rejectionCodes(droppedScope)).toEqual(["dropped_data"]);
  });

  it("ignores dropped metadata in a wholly unrelated resource group", () => {
    const result = map(
      requestFrom([
        resourceGroup([scopeGroup([span(1, [stringAttribute("http.request.method", "GET")])])], {
          resource: { attributes: [], droppedAttributesCount: 1 },
          schemaUrl: "",
        }),
        resourceGroup([scopeGroup([span(2, modelAttributes())])]),
      ]),
    );

    expect(result.status).toBe("mapped_as_untrusted_proposal");
  });

  it.each([
    { label: "an absent scope", scope: undefined },
    {
      label: "an empty scope name",
      scope: { attributes: [], droppedAttributesCount: 0, name: "", version: "" },
    },
    {
      label: "an oversized scope name",
      scope: { attributes: [], droppedAttributesCount: 0, name: "x".repeat(257), version: "" },
    },
    {
      label: "an oversized scope version",
      scope: {
        attributes: [],
        droppedAttributesCount: 0,
        name: "fixture.instrumentation",
        version: "x".repeat(257),
      },
    },
  ] satisfies readonly { label: string; scope: OtlpScopeSpans["scope"] }[])(
    "handles $label without fabricating provenance",
    ({ label, scope }) => {
      const candidateScope = scope
        ? scopeGroup([span(1, modelAttributes())], { scope })
        : {
            schemaUrl: OTEL_GENAI_SEMANTIC_CONVENTION_SCHEMA_URL,
            spans: [span(1, modelAttributes())],
          };
      const result = map(requestFrom([resourceGroup([candidateScope])]));

      if (label === "an absent scope") {
        expect(result).toMatchObject({ proposals: [{ kind: "model" }] });
        expect(
          result.status === "mapped_as_untrusted_proposal" && result.proposals[0],
        ).not.toHaveProperty("instrumentationScope");
      } else {
        expect(rejectionCodes(result)).toEqual(["invalid_attribute"]);
      }
    },
  );

  it.each([
    { kind: 2, label: "model" as const, traceSpan: span(1, modelAttributes(), { kind: 2 }) },
    { kind: 3, label: "tool" as const, traceSpan: span(2, toolAttributes(), { kind: 3 }) },
  ])("rejects unsupported $label span kind $kind", ({ traceSpan }) => {
    expect(rejectionCodes(map(request([traceSpan])))).toEqual(["unsupported_span_kind"]);
  });

  it("rejects unsupported GenAI operations and empty imports", () => {
    const unsupported = map(
      request([span(1, [stringAttribute("gen_ai.operation.name", "invoke_agent")])]),
    );
    const unrelated = map(request([span(2, [stringAttribute("http.request.method", "GET")])]));

    expect(rejectionCodes(unsupported)).toEqual(["unsupported_operation"]);
    expect(rejectionCodes(unrelated)).toEqual(["no_supported_spans"]);
  });

  it("rejects duplicate attributes and duplicate span identities", () => {
    const duplicateAttribute = map(
      request([
        span(1, [
          ...modelAttributes(),
          stringAttribute("gen_ai.provider.name", "another-provider"),
        ]),
      ]),
    );
    const duplicate = span(2, modelAttributes());
    const duplicateSpan = map(request([duplicate, duplicate]));

    expect(rejectionCodes(duplicateAttribute)).toEqual(["duplicate_attribute"]);
    expect(rejectionCodes(duplicateSpan)).toEqual(["duplicate_span"]);
  });

  it("rejects invalid identifiers and timestamp ranges", () => {
    const invalidSpanAndRange = map(
      request([
        span(1, modelAttributes(), {
          endTimeUnixNano: "100",
          spanId: new Uint8Array(8),
          startTimeUnixNano: "101",
        }),
      ]),
    );
    const invalidTrace = map(
      request([span(2, modelAttributes(), { traceId: new Uint8Array(16) })]),
    );
    const invalidParent = map(
      request([span(3, modelAttributes(), { parentSpanId: new Uint8Array([1]) })]),
    );
    const nonNumericTimestamp = map(
      request([span(4, modelAttributes(), { startTimeUnixNano: "not-a-number" })]),
    );
    const zeroTimestamp = map(
      request([
        span(5, modelAttributes(), {
          endTimeUnixNano: "1",
          startTimeUnixNano: "0",
        }),
      ]),
    );

    expect(rejectionCodes(invalidSpanAndRange)).toEqual([
      "invalid_identifier",
      "invalid_timestamp",
    ]);
    expect(rejectionCodes(invalidTrace)).toEqual(["invalid_identifier"]);
    expect(rejectionCodes(invalidParent)).toEqual(["invalid_identifier"]);
    expect(rejectionCodes(nonNumericTimestamp)).toEqual(["invalid_timestamp"]);
    expect(rejectionCodes(zeroTimestamp)).toEqual(["invalid_timestamp"]);
  });

  it.each(["", "x".repeat(257)])("rejects an unbounded span name", (name) => {
    expect(rejectionCodes(map(request([span(1, modelAttributes(), { name })])))).toEqual([
      "invalid_attribute",
    ]);
  });
});
