import {
  EVIDENCE_SCHEMA_VERSION,
  type PrincipalContext,
  PrincipalContextSchema,
} from "@proofstack/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Authenticator } from "./auth.js";
import { loadConfig } from "./config.js";

const config = loadConfig({ PROOFSTACK_ENV: "test", PROOFSTACK_LOG_LEVEL: "silent" });
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

const evidence = {
  eventId: "evt_01k3t5d7h9m2p4r6s8v0w2y4z6",
  kind: "agent.run",
  name: "support-agent",
  source: {
    sdkName: "@proofstack/sdk",
    sdkVersion: "0.0.0",
    serviceName: "support-agent",
  },
  spanId: "00f067aa0ba902b7",
  startedAt: "2026-08-28T03:59:59.000Z",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
};

function authenticatorWith(capabilities: PrincipalContext["capabilities"]): Authenticator {
  return {
    authenticate: async () =>
      PrincipalContextSchema.parse({
        authentication: {
          authenticatedAt: "2026-08-28T04:00:00.000Z",
          method: "development",
        },
        capabilities,
        principalId: "usr_local",
        principalType: "user",
        requestId: "req_test_001",
        resourceScope: { mode: "tenant" },
        roles: ["owner"],
        tenantId: "ten_local",
      }),
  };
}

async function testApp() {
  const app = await createApp(config, {
    clock: { now: () => new Date("2026-08-28T04:00:00.000Z") },
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("health routes", () => {
  it("reports liveness", async () => {
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("reports readiness", async () => {
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("serves the canonical OpenAPI description", async () => {
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/openapi.json" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      info: { title: "ProofStack API", version: "0.1.0-foundation" },
      openapi: "3.2.0",
    });
  });

  it("refuses to start with an unavailable production authenticator", async () => {
    const production = loadConfig({
      PROOFSTACK_AUTH_MODE: "api_key",
      PROOFSTACK_DATABASE_URL: "postgresql://runtime@db.example.com/proofstack?sslmode=verify-full",
      PROOFSTACK_ENV: "production",
      PROOFSTACK_LOG_LEVEL: "silent",
      PROOFSTACK_STORAGE_MODE: "postgres",
    });

    await expect(createApp(production)).rejects.toThrow("startup refused");
  });

  it("returns a problem document for unknown routes", async () => {
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ code: "route_not_found", status: 404 });
  });
});

describe("evidence routes", () => {
  it("ingests and retrieves a trace", async () => {
    const app = await testApp();
    const ingest = await app.inject({
      body: { events: [evidence], schemaVersion: EVIDENCE_SCHEMA_VERSION },
      method: "POST",
      url: "/v1/projects/prj_local/environments/env_local/evidence",
    });

    expect(ingest.statusCode).toBe(202);
    expect(ingest.json()).toMatchObject({ acceptedEventIds: [evidence.eventId] });

    const trace = await app.inject({
      method: "GET",
      url: `/v1/projects/prj_local/environments/env_local/traces/${evidence.traceId}`,
    });

    expect(trace.statusCode).toBe(200);
    expect(trace.json()).toMatchObject({
      events: [
        {
          receivedAt: "2026-08-28T04:00:00.000Z",
          scope: {
            environmentId: "env_local",
            projectId: "prj_local",
            tenantId: "ten_local",
          },
        },
      ],
      traceId: evidence.traceId,
    });
  });

  it("paginates trace evidence with opaque cursors", async () => {
    const app = await testApp();
    const events = [
      { ...evidence, eventId: "evt_page_a", spanId: "10f067aa0ba902b7" },
      { ...evidence, eventId: "evt_page_b", spanId: "20f067aa0ba902b7" },
      { ...evidence, eventId: "evt_page_c", spanId: "30f067aa0ba902b7" },
    ];
    await app.inject({
      body: { events, schemaVersion: EVIDENCE_SCHEMA_VERSION },
      method: "POST",
      url: "/v1/projects/prj_local/environments/env_local/evidence",
    });

    const first = await app.inject({
      method: "GET",
      url: `/v1/projects/prj_local/environments/env_local/traces/${evidence.traceId}?limit=2`,
    });
    const firstBody = first.json();
    const second = await app.inject({
      method: "GET",
      url: `/v1/projects/prj_local/environments/env_local/traces/${evidence.traceId}?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    });

    expect(first.statusCode).toBe(200);
    expect(firstBody.events).toHaveLength(2);
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      events: [{ evidence: { eventId: "evt_page_c" } }],
    });
    expect(second.json()).not.toHaveProperty("nextCursor");
  });

  it("rejects a forged trace cursor", async () => {
    const app = await testApp();
    const cursor = Buffer.from("not-json").toString("base64url");
    const response = await app.inject({
      method: "GET",
      url: `/v1/projects/prj_local/environments/env_local/traces/${evidence.traceId}?cursor=${cursor}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_trace_cursor", status: 400 });
  });

  it("reports identical retries as duplicates", async () => {
    const app = await testApp();
    const request = {
      body: { events: [evidence], schemaVersion: EVIDENCE_SCHEMA_VERSION },
      method: "POST" as const,
      url: "/v1/projects/prj_local/environments/env_local/evidence",
    };

    await app.inject(request);
    const retry = await app.inject(request);

    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({
      acceptedEventIds: [],
      duplicateEventIds: [evidence.eventId],
    });
  });

  it("returns not found for an unknown trace", async () => {
    const app = await testApp();
    const response = await app.inject({
      method: "GET",
      url: `/v1/projects/prj_local/environments/env_local/traces/${evidence.traceId}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "trace_not_found", status: 404 });
  });

  it("rate limits repeated trace reads", async () => {
    const app = await testApp();
    const request = {
      method: "GET" as const,
      url: `/v1/projects/prj_local/environments/env_local/traces/${evidence.traceId}`,
    };

    for (let attempt = 0; attempt < 600; attempt += 1) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
    }
    const limited = await app.inject(request);

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "http_429", status: 429 });
  });

  it("returns a conflict for reused identifiers with changed evidence", async () => {
    const app = await testApp();
    const url = "/v1/projects/prj_local/environments/env_local/evidence";

    await app.inject({
      body: { events: [evidence], schemaVersion: EVIDENCE_SCHEMA_VERSION },
      method: "POST",
      url,
    });
    const conflict = await app.inject({
      body: {
        events: [{ ...evidence, name: "changed" }],
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
      },
      method: "POST",
      url,
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "evidence_conflict", status: 409 });
  });

  it("rejects malformed evidence without leaking validation internals", async () => {
    const app = await testApp();
    const response = await app.inject({
      body: {
        events: [{ ...evidence, tenantId: "ten_forged", traceId: "invalid" }],
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
      },
      method: "POST",
      url: "/v1/projects/prj_local/environments/env_local/evidence",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request", status: 400 });
  });

  it("maps authorization failures to a forbidden problem", async () => {
    const app = await createApp(config, {
      authenticator: authenticatorWith(["evidence:read"]),
    });
    apps.push(app);

    const response = await app.inject({
      body: { events: [evidence], schemaVersion: EVIDENCE_SCHEMA_VERSION },
      method: "POST",
      url: "/v1/projects/prj_local/environments/env_local/evidence",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "forbidden", status: 403 });
  });

  it("maps oversized payloads without exposing parser internals", async () => {
    const app = await testApp();
    const response = await app.inject({
      body: { oversized: "x".repeat(1024 * 1024 + 1) },
      method: "POST",
      url: "/v1/projects/prj_local/environments/env_local/evidence",
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "http_413", status: 413 });
  });

  it("returns a generic problem for unexpected failures", async () => {
    const app = await createApp(config, {
      authenticator: {
        authenticate: async () => {
          throw new Error("sensitive failure detail");
        },
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/projects/prj_local/environments/env_local/traces/${evidence.traceId}`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("sensitive failure detail");
    expect(response.json()).toMatchObject({ code: "internal_error", status: 500 });
  });
});
