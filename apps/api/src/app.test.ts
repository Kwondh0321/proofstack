import {
  EVIDENCE_SCHEMA_VERSION,
  type PrincipalContext,
  PrincipalContextSchema,
} from "@proofstack/contracts";
import {
  ApiKeyCredentialNotActiveError,
  generateBrowserSessionCredentials,
  InvalidApiKeyLifecycleInputError,
} from "@proofstack/identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import {
  type Authenticator,
  AuthenticationRequiredError,
  BrowserSessionRequestAuthenticator,
} from "./auth.js";
import { loadConfig } from "./config.js";
import type { IdentityStorage } from "./identity-storage.js";
import type { OidcRuntime } from "./oidc-runtime.js";

const config = loadConfig({ PROOFSTACK_ENV: "test", PROOFSTACK_LOG_LEVEL: "silent" });
const OIDC_ENV = {
  PROOFSTACK_OIDC_CLIENT_ID: "proofstack-console",
  PROOFSTACK_OIDC_CLIENT_SECRET: "provider-client-secret",
  PROOFSTACK_OIDC_ISSUER: "https://identity.example.test/tenant",
  PROOFSTACK_OIDC_REDIRECT_URI: "https://proofstack.example.test/v1/auth/oidc/callback",
  PROOFSTACK_OIDC_TRANSACTION_SECRET: "A".repeat(43),
} as const;
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

  it("treats an injected repository as ready unless a check is provided", async () => {
    const app = await createApp(config, {
      repository: {
        append: async () => ({ acceptedEventIds: [], duplicateEventIds: [] }),
        listByTrace: async () => ({ cursorFound: true, events: [], hasMore: false }),
      },
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
  });

  it("reports dependency readiness failures without affecting liveness", async () => {
    const app = await createApp(config, {
      checkReadiness: async () => {
        throw new Error("database unavailable");
      },
      repository: {
        append: async () => ({ acceptedEventIds: [], duplicateEventIds: [] }),
        listByTrace: async () => ({ cursorFound: true, events: [], hasMore: false }),
      },
    });
    apps.push(app);

    const readiness = await app.inject({ method: "GET", url: "/health/ready" });
    const liveness = await app.inject({ method: "GET", url: "/health/live" });

    expect(readiness.statusCode).toBe(503);
    expect(readiness.headers["content-type"]).toContain("application/problem+json");
    expect(readiness.json()).toMatchObject({ code: "not_ready", status: 503 });
    expect(liveness.statusCode).toBe(200);
  });

  it("serves the canonical OpenAPI description", async () => {
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/openapi.json" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      info: { title: "ProofStack API", version: "0.7.0-workflow-1" },
      openapi: "3.2.0",
    });
  });

  it("composes OIDC browser routes, credentialed CORS, and stable rejection problems", async () => {
    const oidcConfig = loadConfig({
      ...OIDC_ENV,
      PROOFSTACK_AUTH_MODE: "oidc",
      PROOFSTACK_CORS_ORIGIN: "https://console.example.test",
      PROOFSTACK_ENV: "test",
      PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
      PROOFSTACK_LOG_LEVEL: "silent",
    });
    const credentials = generateBrowserSessionCredentials((size) => new Uint8Array(size).fill(23));
    const browserSessions = new BrowserSessionRequestAuthenticator(
      {
        authenticate: async (_value, requestId) => ({
          csrfDigest: credentials.csrfDigest,
          principal: PrincipalContextSchema.parse({
            authentication: {
              authenticatedAt: "2026-08-28T04:00:00.000Z",
              credentialId: "ses_app_oidc",
              method: "oidc",
            },
            capabilities: ["evidence:ingest", "evidence:read"],
            principalId: "usr_app_oidc",
            principalType: "user",
            requestId,
            resourceScope: { mode: "tenant" },
            roles: ["member"],
            tenantId: "ten_local",
          }),
          sessionDigest: credentials.sessionDigest,
        }),
      },
      "https://console.example.test",
    );
    const login = {
      begin: vi.fn(async () => ({
        authorizationUrl: "https://identity.example.test/authorize",
        expiresAt: "2026-08-28T04:10:00.000Z",
        interactionToken: "A".repeat(43),
      })),
      complete: vi.fn(async () => ({
        absoluteExpiresAt: "2026-08-28T16:00:00.000Z",
        csrfToken: credentials.csrfToken,
        idleExpiresAt: "2026-08-28T04:30:00.000Z",
        returnTo: "/",
        sessionToken: credentials.sessionToken,
      })),
    };
    const identityStorage: IdentityStorage = {
      checkReadiness: async () => undefined,
      close: async () => undefined,
      oidcRepository: {} as IdentityStorage["oidcRepository"],
      repository: {
        confirmActiveUse: async () => true,
        create: async () => ({ createdAt: "2026-08-28T04:00:00.000Z" }),
        findActiveByPrefix: async () => null,
        findById: async () => null,
        revoke: async () => true,
        rotate: async () => ({ createdAt: "2026-08-28T04:00:00.000Z" }),
      },
    };
    const oidcRuntime: OidcRuntime = {
      browserSessions,
      login,
      sessionLifecycle: { revoke: async () => true },
    };
    const app = await createApp(oidcConfig, { identityStorage, oidcRuntime });
    apps.push(app);

    const started = await app.inject({ method: "GET", url: "/v1/auth/oidc/login" });
    const session = await app.inject({
      headers: {
        cookie: `__Host-proofstack_session=${credentials.sessionToken}`,
        origin: "https://console.example.test",
      },
      method: "GET",
      url: "/v1/auth/session",
    });
    const invalidCallback = await app.inject({
      method: "GET",
      url: `/v1/auth/oidc/callback?code=provider-code&state=${"A".repeat(43)}`,
    });
    const rejectedMutation = await app.inject({
      body: { events: [evidence], schemaVersion: EVIDENCE_SCHEMA_VERSION },
      headers: { cookie: `__Host-proofstack_session=${credentials.sessionToken}` },
      method: "POST",
      url: "/v1/projects/prj_local/environments/env_local/evidence",
    });
    const missingSession = await app.inject({
      method: "GET",
      url: `/v1/projects/prj_local/environments/env_local/traces/${evidence.traceId}`,
    });

    expect(started.statusCode).toBe(302);
    expect(login.begin).toHaveBeenCalledWith("/");
    expect(session.statusCode).toBe(200);
    expect(session.headers["access-control-allow-origin"]).toBe("https://console.example.test");
    expect(session.headers["access-control-allow-credentials"]).toBe("true");
    expect(session.json()).toMatchObject({ principal: { principalId: "usr_app_oidc" } });
    expect(invalidCallback.statusCode).toBe(400);
    expect(invalidCallback.json()).toMatchObject({ code: "invalid_oidc_login" });
    expect(rejectedMutation.statusCode).toBe(403);
    expect(rejectedMutation.json()).toMatchObject({ code: "browser_request_rejected" });
    expect(missingSession.statusCode).toBe(401);
    expect(missingSession.headers).not.toHaveProperty("www-authenticate");
  });

  it("composes API key authentication with isolated identity readiness", async () => {
    let identityReadinessChecks = 0;
    const identityStorage: IdentityStorage = {
      checkReadiness: async () => {
        identityReadinessChecks += 1;
      },
      close: async () => undefined,
      oidcRepository: {} as IdentityStorage["oidcRepository"],
      repository: {
        confirmActiveUse: async () => true,
        create: async () => ({ createdAt: "2026-08-28T04:00:00.000Z" }),
        findActiveByPrefix: async () => null,
        findById: async () => null,
        revoke: async () => true,
        rotate: async () => ({ createdAt: "2026-08-28T04:00:00.000Z" }),
      },
    };
    const apiKeyConfig = loadConfig({
      PROOFSTACK_AUTH_MODE: "api_key",
      PROOFSTACK_ENV: "test",
      PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
      PROOFSTACK_LOG_LEVEL: "silent",
    });
    const app = await createApp(apiKeyConfig, { identityStorage });
    apps.push(app);

    const readiness = await app.inject({ method: "GET", url: "/health/ready" });
    const protectedRoute = await app.inject({
      method: "GET",
      url: `/v1/projects/prj_local/environments/env_local/traces/${evidence.traceId}`,
    });

    expect(readiness.statusCode).toBe(200);
    expect(identityReadinessChecks).toBe(1);
    expect(protectedRoute.statusCode).toBe(401);
    expect(protectedRoute.headers["www-authenticate"]).toBe('Bearer realm="proofstack"');
    expect(protectedRoute.json()).toMatchObject({ code: "unauthenticated", status: 401 });
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

  it("does not expose credential rejection details", async () => {
    const app = await createApp(config, {
      authenticator: {
        authenticate: async () => {
          throw new AuthenticationRequiredError({ cause: new Error("sensitive key detail") });
        },
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/projects/prj_local/environments/env_local/traces/${evidence.traceId}`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("sensitive key detail");
    expect(response.json()).toMatchObject({
      code: "unauthenticated",
      detail: "Authentication is required or invalid",
      status: 401,
    });
  });

  it("authenticates before disclosing protected request validation", async () => {
    const app = await createApp(config, {
      authenticator: {
        authenticate: async () => {
          throw new AuthenticationRequiredError();
        },
      },
    });
    apps.push(app);

    const response = await app.inject({
      body: { invalid: true },
      method: "POST",
      url: "/v1/projects/INVALID/environments/INVALID/evidence",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "unauthenticated" });
  });
});

describe("identity management routes", () => {
  it("reports unavailable identity storage explicitly", async () => {
    const app = await testApp();
    const response = await app.inject({
      body: {
        capabilities: ["evidence:ingest"],
        name: "unavailable-test",
        resourceScope: { mode: "tenant" },
      },
      method: "POST",
      url: "/v1/identity/api-keys",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "identity_unavailable", status: 503 });
  });

  it("maps lifecycle validation and inactive credentials to stable problems", async () => {
    const invalid = await createApp(config, {
      apiKeyLifecycle: {
        issue: async () => {
          throw new InvalidApiKeyLifecycleInputError("expiration is outside the allowed window");
        },
        revoke: async () => false,
        rotate: async () => {
          throw new ApiKeyCredentialNotActiveError("key_inactive");
        },
      },
    });
    apps.push(invalid);

    const invalidIssue = await invalid.inject({
      body: {
        capabilities: ["evidence:ingest"],
        name: "invalid-test",
        resourceScope: { mode: "tenant" },
      },
      method: "POST",
      url: "/v1/identity/api-keys",
    });
    const inactiveRotation = await invalid.inject({
      method: "POST",
      url: "/v1/identity/api-keys/key_inactive/rotate",
    });

    expect(invalidIssue.statusCode).toBe(400);
    expect(invalidIssue.json()).toMatchObject({ code: "invalid_api_key_request", status: 400 });
    expect(inactiveRotation.statusCode).toBe(409);
    expect(inactiveRotation.json()).toMatchObject({ code: "api_key_not_active", status: 409 });
  });
});
