import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpEvidenceTransport, TransportError } from "./transport.js";

const event = {
  attributes: {},
  contentReferences: [],
  eventId: "evt_transport",
  extensions: {},
  kind: "custom" as const,
  name: "transport-test",
  source: {
    sdkName: "@proofstack/sdk",
    sdkVersion: "0.0.0",
    serviceName: "test-agent",
  },
  spanId: "00f067aa0ba902b7",
  startedAt: "2026-08-28T05:00:00.000Z",
  status: "unset" as const,
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
};

describe("HttpEvidenceTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends the canonical request to the scoped endpoint", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    const transport = new HttpEvidenceTransport({
      apiKey: "secret-test-key",
      endpoint: "https://proofstack.example/base/",
      environmentId: "env_local",
      fetch,
      projectId: "prj_local",
    });

    await transport.send([event]);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://proofstack.example/base/v1/projects/prj_local/environments/env_local/evidence",
    );
    expect(request?.headers).toMatchObject({
      authorization: "Bearer secret-test-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({ schemaVersion: "0.1" });
  });

  it("returns a bounded transport error for rejected requests", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("x".repeat(1_000), { status: 503 }));
    const transport = new HttpEvidenceTransport({
      endpoint: "https://proofstack.example",
      environmentId: "env_local",
      fetch,
      projectId: "prj_local",
    });

    const promise = transport.send([event]);

    await expect(promise).rejects.toBeInstanceOf(TransportError);
    await expect(promise).rejects.toMatchObject({ status: 503 });
    await expect(promise).rejects.toSatisfy((error: Error) => error.message.length < 600);
  });

  it("validates transport timeouts", () => {
    expect(
      () =>
        new HttpEvidenceTransport({
          endpoint: "https://proofstack.example",
          environmentId: "env_local",
          projectId: "prj_local",
          timeoutMs: 0,
        }),
    ).toThrow("positive integer");
  });

  it("maps network failures without leaking non-error values", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue("offline");
    const transport = new HttpEvidenceTransport({
      endpoint: "https://proofstack.example",
      environmentId: "env_local",
      fetch,
      projectId: "prj_local",
    });

    await expect(transport.send([event])).rejects.toThrow("unknown error");
  });

  it("aborts requests at the configured timeout", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const transport = new HttpEvidenceTransport({
      endpoint: "https://proofstack.example",
      environmentId: "env_local",
      fetch,
      projectId: "prj_local",
      timeoutMs: 10,
    });

    const assertion = expect(transport.send([event])).rejects.toThrow("timed out after 10ms");
    await vi.advanceTimersByTimeAsync(10);

    await assertion;
  });

  it("requires a fetch implementation", () => {
    vi.stubGlobal("fetch", undefined);

    expect(
      () =>
        new HttpEvidenceTransport({
          endpoint: "https://proofstack.example",
          environmentId: "env_local",
          projectId: "prj_local",
        }),
    ).toThrow("No fetch implementation");
  });
});
