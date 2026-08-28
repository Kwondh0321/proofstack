import { gzipSync } from "node:zlib";
import { PrincipalContextSchema, type PrincipalContext } from "@proofstack/contracts";
import { decodeOtlpJson, encodeOtlpProtobufRequest } from "@proofstack/otlp";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppDependencies } from "./app.js";
import {
  type Authenticator,
  AuthenticationRequiredError,
  BrowserRequestRejectedError,
} from "./auth.js";
import { loadConfig } from "./config.js";

const PROJECT_ID = "prj_local";
const ENVIRONMENT_ID = "env_local";
const TRACE_ID = "5b8efff798038103d269b633813fc60c";
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

const baseSpan = {
  endTimeUnixNano: "1787930001000000000",
  name: "invoke support agent",
  spanId: "eee19b7ec3c1b174",
  startTimeUnixNano: "1787930000000000000",
  status: { code: 1, message: "complete" },
  traceId: TRACE_ID,
};

function jsonRequest(spans: readonly Record<string, unknown>[] = [baseSpan]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "agent-service" } }],
        },
        scopeSpans: [{ scope: { name: "test-otel", version: "1.0" }, spans }],
      },
    ],
  });
}

function headers(
  contentType = "application/json",
  additions: Record<string, string | readonly string[]> = {},
) {
  return {
    "content-type": contentType,
    "x-proofstack-environment-id": ENVIRONMENT_ID,
    "x-proofstack-project-id": PROJECT_ID,
    ...additions,
  };
}

function principal(
  overrides: Partial<PrincipalContext> = {},
  scope: PrincipalContext["resourceScope"] = { mode: "tenant" },
): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-28T04:00:00.000Z",
      credentialId: "key_otlp_test",
      method: "api_key",
    },
    capabilities: ["evidence:ingest", "evidence:read"],
    principalId: "wrk_otlp_test",
    principalType: "workload",
    requestId: "req_otlp_test",
    resourceScope: scope,
    roles: ["ingest"],
    tenantId: "ten_local",
    ...overrides,
  });
}

function authenticator(value: PrincipalContext): Authenticator {
  return { authenticate: async () => value };
}

async function testApp(dependencies: AppDependencies = {}, environment: NodeJS.ProcessEnv = {}) {
  const app = await createApp(
    loadConfig({ PROOFSTACK_ENV: "test", PROOFSTACK_LOG_LEVEL: "silent", ...environment }),
    {
      clock: { now: () => new Date("2026-08-28T04:00:00.000Z") },
      ...dependencies,
    },
  );
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("OTLP trace route", () => {
  it("ingests OTLP/JSON through the canonical authorization and evidence path", async () => {
    const app = await testApp();
    const ingest = await app.inject({
      body: jsonRequest(),
      headers: headers(),
      method: "POST",
      url: "/v1/traces",
    });

    expect(ingest.statusCode).toBe(200);
    expect(ingest.headers["content-type"]).toContain("application/json");
    expect(ingest.json()).toEqual({});

    const trace = await app.inject({
      method: "GET",
      url: `/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/traces/${TRACE_ID}`,
    });
    expect(trace.statusCode).toBe(200);
    expect(trace.json()).toMatchObject({
      events: [
        {
          evidence: {
            kind: "custom",
            source: { sdkName: "test-otel", serviceName: "agent-service" },
            spanId: baseSpan.spanId,
          },
          receivedAt: "2026-08-28T04:00:00.000Z",
          scope: {
            environmentId: ENVIRONMENT_ID,
            projectId: PROJECT_ID,
            tenantId: "ten_local",
          },
        },
      ],
    });
  });

  it("ingests gzip-compressed binary Protobuf and matches the response representation", async () => {
    const app = await testApp();
    const protobuf = encodeOtlpProtobufRequest(decodeOtlpJson(jsonRequest()));
    const ingest = await app.inject({
      body: gzipSync(protobuf),
      headers: headers("application/x-protobuf", { "content-encoding": "gzip" }),
      method: "POST",
      url: "/v1/traces",
    });

    expect(ingest.statusCode).toBe(200);
    expect(ingest.headers["content-type"]).toContain("application/x-protobuf");
    expect(ingest.rawPayload.byteLength).toBe(0);

    const empty = await app.inject({
      headers: headers("application/x-protobuf"),
      method: "POST",
      url: "/v1/traces",
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.rawPayload.byteLength).toBe(0);

    const trace = await app.inject({
      method: "GET",
      url: `/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/traces/${TRACE_ID}`,
    });
    expect(trace.statusCode).toBe(200);
    expect(trace.json().events).toHaveLength(1);
  });

  it("persists the valid subset and returns a non-retryable partial success", async () => {
    const app = await testApp();
    const invalid = {
      ...baseSpan,
      name: "invalid",
      spanId: "1111111111111111",
      startTimeUnixNano: "0",
    };
    const response = await app.inject({
      body: jsonRequest([baseSpan, invalid]),
      headers: headers(),
      method: "POST",
      url: "/v1/traces",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      partialSuccess: {
        errorMessage: "Rejected spans: invalid span timestamp (1)",
        rejectedSpans: "1",
      },
    });
    const trace = await app.inject({
      method: "GET",
      url: `/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/traces/${TRACE_ID}`,
    });
    expect(trace.json().events).toHaveLength(1);
  });

  it("authenticates before media, body, or routing header validation", async () => {
    const app = await testApp({
      authenticator: {
        authenticate: async () => {
          throw new AuthenticationRequiredError({ cause: new Error("secret key detail") });
        },
      },
    });
    const response = await app.inject({
      body: "invalid",
      headers: { "content-type": "text/plain" },
      method: "POST",
      url: "/v1/traces",
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe('Bearer realm="proofstack"');
    expect(response.body).not.toContain("secret key detail");
    expect(response.json()).toEqual({ code: 16, message: "Authentication is required or invalid" });
  });

  it("rejects browser and non-workload principals at the data-plane boundary", async () => {
    const oidcUser = principal({
      authentication: {
        authenticatedAt: "2026-08-28T04:00:00.000Z",
        credentialId: "ses_otlp_test",
        method: "oidc",
      },
      principalId: "usr_otlp_test",
      principalType: "user",
      roles: ["member"],
    });
    const userApp = await testApp({ authenticator: authenticator(oidcUser) });
    const rejectedUser = await userApp.inject({
      body: jsonRequest(),
      headers: headers(),
      method: "POST",
      url: "/v1/traces",
    });
    const invalidApiKeyUser = principal({ principalType: "user" });
    const apiKeyUserApp = await testApp({ authenticator: authenticator(invalidApiKeyUser) });
    const rejectedApiKeyUser = await apiKeyUserApp.inject({
      body: jsonRequest(),
      headers: headers(),
      method: "POST",
      url: "/v1/traces",
    });

    const csrfApp = await testApp({
      authenticator: {
        authenticate: async () => {
          throw new BrowserRequestRejectedError();
        },
      },
    });
    const rejectedBrowser = await csrfApp.inject({
      body: jsonRequest(),
      headers: headers(),
      method: "POST",
      url: "/v1/traces",
    });

    expect(rejectedUser.statusCode).toBe(403);
    expect(rejectedUser.json()).toEqual({
      code: 7,
      message: "OTLP trace ingestion requires a workload API key",
    });
    expect(rejectedApiKeyUser.statusCode).toBe(403);
    expect(rejectedBrowser.statusCode).toBe(403);
    expect(rejectedBrowser.json()).toMatchObject({ code: 7 });
  });

  it("requires exactly one valid project and environment routing header", async () => {
    const app = await testApp();
    const missing = await app.inject({
      body: jsonRequest(),
      headers: { "content-type": "application/json" },
      method: "POST",
      url: "/v1/traces",
    });
    const invalid = await app.inject({
      body: jsonRequest(),
      headers: headers("application/json", { "x-proofstack-project-id": "INVALID" }),
      method: "POST",
      url: "/v1/traces",
    });
    const duplicate = await app.inject({
      body: jsonRequest(),
      headers: headers("application/json", {
        "x-proofstack-project-id": [PROJECT_ID, "prj_other"],
      }),
      method: "POST",
      url: "/v1/traces",
    });

    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 3 });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 3 });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({ code: 3 });
  });

  it("enforces core capability and restricted environment authorization", async () => {
    const noCapability = principal({ capabilities: ["evidence:read"] });
    const wrongEnvironment = principal(
      {},
      {
        mode: "restricted",
        projects: [{ environmentIds: ["env_other"], projectId: PROJECT_ID }],
      },
    );
    const capabilityApp = await testApp({ authenticator: authenticator(noCapability) });
    const scopeApp = await testApp({ authenticator: authenticator(wrongEnvironment) });

    const capabilityResponse = await capabilityApp.inject({
      body: jsonRequest(),
      headers: headers(),
      method: "POST",
      url: "/v1/traces",
    });
    const scopeResponse = await scopeApp.inject({
      body: jsonRequest(),
      headers: headers(),
      method: "POST",
      url: "/v1/traces",
    });

    expect(capabilityResponse.statusCode).toBe(403);
    expect(capabilityResponse.json()).toMatchObject({ code: 7 });
    expect(scopeResponse.statusCode).toBe(403);
    expect(scopeResponse.json()).toMatchObject({ code: 7 });
  });

  it("maps unsupported and malformed wire requests to stable OTLP failures", async () => {
    const app = await testApp();
    const unsupported = await app.inject({
      body: jsonRequest(),
      headers: headers("text/plain"),
      method: "POST",
      url: "/v1/traces",
    });
    const malformed = await app.inject({
      body: "{",
      headers: headers(),
      method: "POST",
      url: "/v1/traces",
    });
    const unparsed = await app.inject({
      body: "<traces />",
      headers: headers("application/xml"),
      method: "POST",
      url: "/v1/traces",
    });

    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toMatchObject({ code: 3 });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain("JSON");
    expect(malformed.json()).toEqual({ code: 3, message: "OTLP trace request body is invalid" });
    expect(unparsed.statusCode).toBe(415);
    expect(unparsed.json()).toEqual({ code: 3, message: "The OTLP HTTP request was rejected" });
  });

  it("enforces compressed and decompressed route limits", async () => {
    const compressedApp = await testApp({}, { PROOFSTACK_OTLP_COMPRESSED_BODY_LIMIT_BYTES: "16" });
    const compressed = await compressedApp.inject({
      body: "x".repeat(17),
      headers: headers(),
      method: "POST",
      url: "/v1/traces",
    });

    const decompressedApp = await testApp(
      {},
      {
        PROOFSTACK_OTLP_COMPRESSED_BODY_LIMIT_BYTES: "1024",
        PROOFSTACK_OTLP_DECOMPRESSED_BODY_LIMIT_BYTES: "32",
      },
    );
    const decompressed = await decompressedApp.inject({
      body: gzipSync(jsonRequest()),
      headers: headers("application/json", { "content-encoding": "gzip" }),
      method: "POST",
      url: "/v1/traces",
    });

    expect(compressed.statusCode).toBe(413);
    expect(compressed.json()).toMatchObject({ code: 8 });
    expect(decompressed.statusCode).toBe(413);
    expect(decompressed.json()).toMatchObject({ code: 8 });
  });

  it("treats identical replay as success and conflicting identity as a whole-request failure", async () => {
    const app = await testApp();
    const firstRequest = {
      body: jsonRequest(),
      headers: headers(),
      method: "POST" as const,
      url: "/v1/traces",
    };
    const first = await app.inject(firstRequest);
    const duplicate = await app.inject(firstRequest);
    const conflict = await app.inject({
      ...firstRequest,
      body: jsonRequest([{ ...baseSpan, name: "changed meaning" }]),
    });

    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({});
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      code: 6,
      message: "An evidence event identity conflicts with stored evidence",
    });
  });

  it("rejects the whole request as retryable when atomic persistence is unavailable", async () => {
    const app = await testApp({
      repository: {
        append: async () => {
          throw new Error("sensitive database detail");
        },
        listByTrace: async () => ({ cursorFound: true, events: [], hasMore: false }),
      },
    });
    const response = await app.inject({
      body: jsonRequest(),
      headers: headers(),
      method: "POST",
      url: "/v1/traces",
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("sensitive database detail");
    expect(response.json()).toEqual({ code: 14, message: "Evidence persistence is unavailable" });
  });

  it("hides unexpected authentication implementation failures", async () => {
    const app = await testApp({
      authenticator: {
        authenticate: async () => {
          throw new Error("sensitive authenticator detail");
        },
      },
    });
    const response = await app.inject({
      body: jsonRequest(),
      headers: headers(),
      method: "POST",
      url: "/v1/traces",
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("sensitive authenticator detail");
    expect(response.json()).toEqual({
      code: 13,
      message: "An unexpected OTLP ingestion error occurred",
    });

    const malformedErrorApp = await testApp({
      authenticator: {
        authenticate: async () => {
          throw { statusCode: "not-a-number" };
        },
      },
    });
    const malformedError = await malformedErrorApp.inject({
      body: jsonRequest(),
      headers: headers(),
      method: "POST",
      url: "/v1/traces",
    });
    expect(malformedError.statusCode).toBe(500);
    expect(malformedError.json()).toMatchObject({ code: 13 });
  });

  it("rate limits only after authentication and returns a retryable resource error", async () => {
    const app = await testApp();
    const request = {
      body: JSON.stringify({ resourceSpans: [] }),
      headers: headers(),
      method: "POST" as const,
      url: "/v1/traces",
    };
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject(request);

    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toEqual(expect.any(String));
    expect(limited.json()).toEqual({
      code: 8,
      message: "OTLP trace ingestion rate limit exceeded",
    });
  });
});
