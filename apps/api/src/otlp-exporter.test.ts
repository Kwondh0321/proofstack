import { OTLPTraceExporter as OtlpJsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as OtlpProtobufTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const PROJECT_ID = "prj_local";
const ENVIRONMENT_ID = "env_local";

describe("official OpenTelemetry exporters", () => {
  it.each([
    ["HTTP/JSON", OtlpJsonTraceExporter],
    ["HTTP/Protobuf", OtlpProtobufTraceExporter],
  ])("ingests a trace emitted by the %s exporter", async (_name, Exporter) => {
    const app = await createApp(
      loadConfig({ PROOFSTACK_ENV: "test", PROOFSTACK_LOG_LEVEL: "silent" }),
    );
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const exporter = new Exporter({
      headers: {
        "X-ProofStack-Environment-Id": ENVIRONMENT_ID,
        "X-ProofStack-Project-Id": PROJECT_ID,
      },
      url: `${address}/v1/traces`,
    });
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    try {
      const span = provider
        .getTracer("proofstack-exporter-compatibility", "1.0.0")
        .startSpan("official exporter trace", {
          attributes: { "proofstack.evidence.kind": "agent.run" },
        });
      const traceId = span.spanContext().traceId;
      const spanId = span.spanContext().spanId;
      span.end();
      await provider.forceFlush();

      const trace = await app.inject({
        method: "GET",
        url: `/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/traces/${traceId}`,
      });

      expect(trace.statusCode).toBe(200);
      expect(trace.json()).toMatchObject({
        events: [
          {
            evidence: {
              kind: "agent.run",
              name: "official exporter trace",
              source: {
                sdkName: "proofstack-exporter-compatibility",
                sdkVersion: "1.0.0",
              },
              spanId,
            },
            scope: {
              environmentId: ENVIRONMENT_ID,
              projectId: PROJECT_ID,
              tenantId: "ten_local",
            },
          },
        ],
        traceId,
      });
    } finally {
      await provider.shutdown();
      await app.close();
    }
  });
});
