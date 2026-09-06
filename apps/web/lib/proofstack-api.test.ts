import { afterEach, describe, expect, it, vi } from "vitest";
import { apiHealth, getTrace, MAX_TRACE_RESPONSE_BYTES } from "./proofstack-api.js";

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
const traceResponseHeaders = {
  "cache-control": "private, no-store",
  "content-type": "application/json; charset=utf-8",
};

function traceResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      events: [traceEvent],
      requestId: "req_test_001",
      schemaVersion: "0.1",
      traceId,
      ...overrides,
    },
    { headers: traceResponseHeaders },
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function hangingFetch() {
  return vi.fn<typeof globalThis.fetch>(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
}

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

  it("bounds readiness requests with a timeout", async () => {
    vi.useFakeTimers();
    const result = apiHealth(hangingFetch(), 10);

    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toMatchObject({
      kind: "unavailable",
      message: "ProofStack API request timed out after 10ms",
    });
  });

  it("rejects unsafe API connection settings before fetching", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    const unsafeSettings = [
      ["not-a-url", "PROOFSTACK_API_URL must be a valid absolute URL"],
      ["file:///tmp/proofstack", "PROOFSTACK_API_URL must use HTTP or HTTPS"],
      [
        "https://user:secret@proofstack.example",
        "PROOFSTACK_API_URL must not contain embedded credentials",
      ],
      [
        "http://proofstack.internal:4318",
        "Unencrypted PROOFSTACK_API_URL values must use an explicit loopback host",
      ],
    ] as const;

    for (const [value, message] of unsafeSettings) {
      vi.stubEnv("PROOFSTACK_API_URL", value);
      await expect(apiHealth(fetcher)).resolves.toMatchObject({
        kind: "unavailable",
        message,
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("removes API base queries and fragments", async () => {
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ status: "ready" }));
    vi.stubEnv("PROOFSTACK_API_URL", "https://proofstack.example/base?debug=true#local");

    await apiHealth(fetcher);

    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://proofstack.example/base/health/ready");
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
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(traceResponse());

    await expect(getTrace(traceId, fetcher)).resolves.toMatchObject({
      data: { events: [traceEvent], traceId },
      ok: true,
    });
  });

  it("forwards an opaque cursor and validated server-only browser session", async () => {
    const cursor = "cursor_page_2";
    const browserSessionToken = `pss_v1_${"A".repeat(42)}E`;
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(traceResponse());

    await getTrace(traceId, fetcher, { browserSessionToken, cursor });

    expect(String(fetcher.mock.calls[0]?.[0])).toContain(`?cursor=${cursor}`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      headers: { cookie: `__Host-proofstack_session=${browserSessionToken}` },
    });
  });

  it("rejects malformed sessions, cursors, and configured scopes before issuing a request", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();

    await expect(
      getTrace(traceId, fetcher, { browserSessionToken: "invalid" }),
    ).resolves.toMatchObject({ kind: "invalid_response", ok: false });
    await expect(getTrace(traceId, fetcher, { cursor: "invalid cursor" })).resolves.toMatchObject({
      kind: "invalid_response",
      ok: false,
    });
    vi.stubEnv("PROOFSTACK_PROJECT_ID", "INVALID");
    await expect(getTrace(traceId, fetcher)).resolves.toMatchObject({
      kind: "unavailable",
      message: "Configured project or environment ID is invalid",
      ok: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("distinguishes missing, invalid, and unavailable traces", async () => {
    const missing = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    const invalid = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ traceId: "wrong" }, { headers: traceResponseHeaders }));
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

  it("bounds trace requests with a timeout", async () => {
    vi.useFakeTimers();
    const result = getTrace(traceId, hangingFetch(), { timeoutMs: 10 });

    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toMatchObject({
      kind: "unavailable",
      message: "ProofStack API request timed out after 10ms",
    });
  });

  it.each([
    [
      "an unsafe media type",
      new Response("{}", {
        headers: { "cache-control": "no-store", "content-type": "text/plain" },
      }),
      "unexpected media type",
    ],
    [
      "a cacheable response",
      new Response("{}", { headers: { "content-type": "application/json" } }),
      "no-store",
    ],
    ["an empty response", new Response(null, { headers: traceResponseHeaders }), "empty"],
    ["invalid JSON", new Response("not-json", { headers: traceResponseHeaders }), "invalid JSON"],
    [
      "an oversized declared response",
      new Response("{}", {
        headers: {
          ...traceResponseHeaders,
          "content-length": String(MAX_TRACE_RESPONSE_BYTES + 1),
        },
      }),
      "too large",
    ],
  ])("fails closed on %s", async (_name, response, message) => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);

    await expect(getTrace(traceId, fetcher)).resolves.toMatchObject({
      kind: "invalid_response",
      message: expect.stringContaining(message),
      ok: false,
    });
  });

  it("bounds a streamed trace response without trusting content length", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("x".repeat(MAX_TRACE_RESPONSE_BYTES + 1), {
        headers: traceResponseHeaders,
      }),
    );

    await expect(getTrace(traceId, fetcher)).resolves.toMatchObject({
      kind: "invalid_response",
      message: "Trace API response is too large",
      ok: false,
    });
  });

  it("rejects valid contracts with substituted trace identity or configured scope", async () => {
    const otherTraceId = "0bf92f3577b34da6a3ce929d0e0e4736";
    const variants = [
      traceResponse({ traceId: otherTraceId }),
      traceResponse({
        events: [{ ...traceEvent, evidence: { ...traceEvent.evidence, traceId: otherTraceId } }],
      }),
      traceResponse({
        events: [{ ...traceEvent, scope: { ...traceEvent.scope, projectId: "prj_other" } }],
      }),
      traceResponse({
        events: [{ ...traceEvent, scope: { ...traceEvent.scope, environmentId: "env_other" } }],
      }),
      traceResponse({
        events: [
          traceEvent,
          { ...traceEvent, scope: { ...traceEvent.scope, tenantId: "ten_other" } },
        ],
      }),
    ];

    for (const response of variants) {
      const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      await expect(getTrace(traceId, fetcher)).resolves.toMatchObject({
        kind: "invalid_response",
        message: "Trace response failed identity or scope verification",
        ok: false,
      });
    }
  });
});
