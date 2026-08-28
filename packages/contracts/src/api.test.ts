import { describe, expect, it } from "vitest";
import {
  BrowserLogoutResponseSchema,
  BrowserSessionResponseSchema,
  IngestEvidenceResponseSchema,
  LivenessResponseSchema,
  MAX_TRACE_PAGE_SIZE,
  ProblemDocumentSchema,
  ReadinessResponseSchema,
  TraceResponseSchema,
} from "./api.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const browserPrincipal = {
  authentication: {
    authenticatedAt: "2026-08-28T05:00:00.000Z",
    credentialId: "ses_contract_test",
    method: "oidc",
  },
  capabilities: ["evidence:read"],
  principalId: "usr_contract_test",
  principalType: "user",
  requestId: "req_test_001",
  resourceScope: { mode: "tenant" },
  roles: ["viewer"],
  tenantId: "ten_contract_test",
} as const;
const traceEnvelope = {
  evidence: {
    eventId: "evt_contract_test",
    kind: "custom",
    name: "contract-test",
    source: {
      sdkName: "@proofstack/sdk",
      sdkVersion: "0.0.0",
      serviceName: "test-agent",
    },
    spanId: "00f067aa0ba902b7",
    startedAt: "2026-08-28T05:00:00.000Z",
    traceId,
  },
  receivedAt: "2026-08-28T05:00:00.100Z",
  schemaVersion: "0.1",
  scope: {
    environmentId: "env_local",
    projectId: "prj_local",
    tenantId: "ten_local",
  },
};

describe("HTTP response contracts", () => {
  it("validates health responses exactly", () => {
    expect(LivenessResponseSchema.safeParse({ status: "ok" }).success).toBe(true);
    expect(ReadinessResponseSchema.safeParse({ status: "ready" }).success).toBe(true);
    expect(LivenessResponseSchema.safeParse({ status: "ok", version: "unknown" }).success).toBe(
      false,
    );
  });

  it("validates browser session and logout responses", () => {
    expect(
      BrowserSessionResponseSchema.safeParse({
        principal: browserPrincipal,
        requestId: "req_test_001",
      }).success,
    ).toBe(true);
    expect(
      BrowserSessionResponseSchema.safeParse({
        principal: browserPrincipal,
        requestId: "req_different",
      }).success,
    ).toBe(false);
    expect(
      BrowserLogoutResponseSchema.safeParse({ requestId: "req_test_001", revoked: true }).success,
    ).toBe(true);
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

  it("rejects empty trace responses", () => {
    expect(
      TraceResponseSchema.safeParse({
        events: [],
        requestId: "req_test_001",
        schemaVersion: "0.1",
        traceId,
      }).success,
    ).toBe(false);
  });

  it("bounds trace response pages and cursors", () => {
    const oversized = TraceResponseSchema.safeParse({
      events: Array.from({ length: MAX_TRACE_PAGE_SIZE + 1 }, () => traceEnvelope),
      requestId: "req_test_001",
      schemaVersion: "0.1",
      traceId,
    });
    const malformedCursor = TraceResponseSchema.safeParse({
      events: [traceEnvelope],
      nextCursor: "not a cursor",
      requestId: "req_test_001",
      schemaVersion: "0.1",
      traceId,
    });

    expect(oversized.success).toBe(false);
    expect(malformedCursor.success).toBe(false);
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
