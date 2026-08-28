import { MAX_EVIDENCE_BATCH_SIZE } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  MAX_ACCEPTED_OTLP_SPANS,
  MAX_OTLP_ANY_VALUE_DEPTH,
  MAX_OTLP_RESOURCE_SPANS,
  MAX_OTLP_SPANS_PER_REQUEST,
  OTLP_PROTO_VERSION,
  type OtlpExportTraceServiceRequest,
} from "./index.js";

describe("OTLP compatibility model", () => {
  it("pins the reviewed protocol version and canonical transaction limit", () => {
    expect(OTLP_PROTO_VERSION).toBe("1.11.0");
    expect(MAX_ACCEPTED_OTLP_SPANS).toBe(MAX_EVIDENCE_BATCH_SIZE);
  });

  it("keeps structural limits finite and wider than one valid request", () => {
    expect(MAX_OTLP_RESOURCE_SPANS).toBeGreaterThan(0);
    expect(MAX_OTLP_ANY_VALUE_DEPTH).toBeGreaterThan(0);
    expect(MAX_OTLP_SPANS_PER_REQUEST).toBeGreaterThan(MAX_ACCEPTED_OTLP_SPANS);
  });

  it("represents an empty OTLP export request without inventing telemetry", () => {
    const request: OtlpExportTraceServiceRequest = { resourceSpans: [] };

    expect(request.resourceSpans).toEqual([]);
  });
});
