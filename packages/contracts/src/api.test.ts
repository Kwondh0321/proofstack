import { describe, expect, it } from "vitest";
import {
  IngestEvidenceResponseSchema,
  LivenessResponseSchema,
  ProblemDocumentSchema,
  ReadinessResponseSchema,
  TraceResponseSchema,
} from "./api.js";

describe("HTTP response contracts", () => {
  it("validates health responses exactly", () => {
    expect(LivenessResponseSchema.safeParse({ status: "ok" }).success).toBe(true);
    expect(ReadinessResponseSchema.safeParse({ status: "ready" }).success).toBe(true);
    expect(LivenessResponseSchema.safeParse({ status: "ok", version: "unknown" }).success).toBe(
      false,
    );
  });

  it("validates evidence acknowledgements", () => {
    expect(
      IngestEvidenceResponseSchema.safeParse({
        acceptedEventIds: ["evt_accepted"],
        duplicateEventIds: ["evt_duplicate"],
        requestId: "req_test_001",
        schemaVersion: "0.1",
      }).success,
    ).toBe(true);
  });

  it("rejects ambiguous evidence acknowledgements", () => {
    const acknowledgement = {
      acceptedEventIds: ["evt_shared"],
      duplicateEventIds: ["evt_shared"],
      requestId: "req_test_001",
      schemaVersion: "0.1",
    };

    expect(IngestEvidenceResponseSchema.safeParse(acknowledgement).success).toBe(false);
    expect(
      IngestEvidenceResponseSchema.safeParse({
        ...acknowledgement,
        acceptedEventIds: [],
        duplicateEventIds: [],
      }).success,
    ).toBe(false);
  });

  it("validates empty trace responses", () => {
    expect(
      TraceResponseSchema.safeParse({
        events: [],
        requestId: "req_test_001",
        schemaVersion: "0.1",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      }).success,
    ).toBe(true);
  });

  it("validates problem documents without arbitrary fields", () => {
    const problem = {
      code: "invalid_request",
      detail: "The request does not match the required contract",
      requestId: "req_test_001",
      status: 400,
      title: "Invalid request",
      type: "https://proofstack.dev/problems/invalid-request",
    };

    expect(ProblemDocumentSchema.safeParse(problem).success).toBe(true);
    expect(ProblemDocumentSchema.safeParse({ ...problem, stack: "secret" }).success).toBe(false);
  });
});
