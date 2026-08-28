import { describe, expect, it, vi } from "vitest";
import { apiHealth, getTrace } from "./proofstack-api.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const traceEvent = {
  evidence: {
    attributes: {},
    contentReferences: [],
    eventId: "evt_web_test",
    extensions: {},
    kind: "agent.run",
    name: "web-test",
    source: {
      sdkName: "@proofstack/sdk",
      sdkVersion: "0.0.0",
      serviceName: "test-agent",
    },
    spanId: "00f067aa0ba902b7",
    startedAt: "2026-08-28T05:00:00.000Z",
    status: "ok",
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

describe("apiHealth", () => {
  it("accepts a valid readiness response", async () => {
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ status: "ready" }));

    await expect(apiHealth(fetcher)).resolves.toEqual({ data: "ready", ok: true });
  });

  it("does not treat malformed responses as healthy", async () => {
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ status: "maybe" }));

    await expect(apiHealth(fetcher)).resolves.toMatchObject({
      kind: "invalid_response",
      ok: false,
    });
  });

  it("reports an unavailable API", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("offline"));

    await expect(apiHealth(fetcher)).resolves.toMatchObject({ kind: "unavailable", ok: false });
  });

  it("reports unhealthy HTTP responses", async () => {
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));

    await expect(apiHealth(fetcher)).resolves.toMatchObject({
      kind: "unavailable",
      message: "API returned HTTP 503",
      ok: false,
    });
  });
});

describe("getTrace", () => {
  it("rejects malformed trace identifiers before issuing a request", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();

    await expect(getTrace("invalid", fetcher)).resolves.toMatchObject({
      kind: "invalid_response",
      ok: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates a trace response", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        events: [traceEvent],
        requestId: "req_test_001",
        schemaVersion: "0.1",
        traceId,
      }),
    );

    await expect(getTrace(traceId, fetcher)).resolves.toMatchObject({
      data: { events: [traceEvent], traceId },
      ok: true,
    });
  });

  it("distinguishes missing, invalid, and unavailable traces", async () => {
    const missing = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    const invalid = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ traceId: "wrong" }));
    const unavailable = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));

    await expect(getTrace(traceId, missing)).resolves.toMatchObject({ kind: "not_found" });
    await expect(getTrace(traceId, invalid)).resolves.toMatchObject({ kind: "invalid_response" });
    await expect(getTrace(traceId, unavailable)).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("handles trace connection failures", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("offline"));

    await expect(getTrace(traceId, fetcher)).resolves.toMatchObject({
      kind: "unavailable",
      message: "API is not reachable",
      ok: false,
    });
  });
});
