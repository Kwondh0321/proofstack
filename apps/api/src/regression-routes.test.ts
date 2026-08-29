import {
  EVIDENCE_SCHEMA_VERSION,
  type PrincipalContext,
  PrincipalContextSchema,
} from "@proofstack/contracts";
import type { RegressionVersionRepository } from "@proofstack/datasets";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { type Authenticator, AuthenticationRequiredError } from "./auth.js";
import { loadConfig } from "./config.js";

const config = loadConfig({ PROOFSTACK_ENV: "test", PROOFSTACK_LOG_LEVEL: "silent" });
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const fixtureVersionsUrl =
  "/v1/projects/prj_local/environments/env_local/regression-fixtures/fix_checkout/versions";
const fixtureVersionUrl = `${fixtureVersionsUrl}/fixv_checkout_001`;
const datasetVersionsUrl =
  "/v1/projects/prj_local/environments/env_local/regression-datasets/dat_checkout/versions";
const datasetVersionUrl = `${datasetVersionsUrl}/datv_checkout_001`;

const evidence = {
  eventId: "evt_regression_a",
  kind: "agent.run",
  name: "checkout-agent",
  source: {
    sdkName: "@proofstack/sdk",
    sdkVersion: "0.0.0",
    serviceName: "checkout-agent",
  },
  spanId: "00f067aa0ba902b7",
  startedAt: "2026-08-28T03:59:59.000Z",
  traceId,
} as const;

const fixtureRequest = {
  fixtureVersionId: "fixv_checkout_001",
  name: "Checkout incident",
  source: { kind: "trace_snapshot", traceId },
} as const;

const datasetRequest = {
  datasetVersionId: "datv_checkout_001",
  fixtureVersions: [
    {
      fixtureId: "fix_checkout",
      fixtureVersionId: fixtureRequest.fixtureVersionId,
    },
  ],
  name: "Checkout regressions",
} as const;

function principal(capabilities: PrincipalContext["capabilities"]): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-28T04:00:00.000Z",
      method: "development",
    },
    capabilities,
    principalId: "usr_regression_test",
    principalType: "user",
    requestId: "req_regression_test",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: "ten_local",
  });
}

function authenticatorWith(capabilities: PrincipalContext["capabilities"]): Authenticator {
  return { authenticate: async () => principal(capabilities) };
}

async function testApp(
  dependencies: Parameters<typeof createApp>[1] = {},
): Promise<Awaited<ReturnType<typeof createApp>>> {
  const app = await createApp(config, {
    clock: { now: () => new Date("2026-08-28T04:00:00.000Z") },
    ...dependencies,
  });
  apps.push(app);
  return app;
}

async function ingestTrace(app: Awaited<ReturnType<typeof createApp>>): Promise<void> {
  const response = await app.inject({
    body: { events: [evidence], schemaVersion: EVIDENCE_SCHEMA_VERSION },
    method: "POST",
    url: "/v1/projects/prj_local/environments/env_local/evidence",
  });
  expect(response.statusCode).toBe(202);
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("regression version routes", () => {
  it("publishes, retries, and reads exact immutable fixture and dataset versions", async () => {
    const app = await testApp();
    await ingestTrace(app);

    const fixturePublication = await app.inject({
      body: fixtureRequest,
      method: "POST",
      url: fixtureVersionsUrl,
    });
    const publishedFixture = fixturePublication.json();

    expect(fixturePublication.statusCode).toBe(201);
    expect(publishedFixture).toMatchObject({
      created: true,
      requestId: expect.any(String),
      version: {
        fixtureId: "fix_checkout",
        fixtureVersionId: fixtureRequest.fixtureVersionId,
        replayability: "evidence_only",
        source: {
          eventIds: [evidence.eventId],
          observedEventCount: 1,
          sourceCompleteness: "observed_snapshot",
          traceId,
        },
      },
    });

    const fixtureRetry = await app.inject({
      body: fixtureRequest,
      method: "POST",
      url: fixtureVersionsUrl,
    });
    expect(fixtureRetry.statusCode).toBe(200);
    expect(fixtureRetry.json()).toMatchObject({
      created: false,
      version: publishedFixture.version,
    });

    const laterEvidence = {
      ...evidence,
      eventId: "evt_regression_b",
      spanId: "10f067aa0ba902b7",
    };
    const laterIngest = await app.inject({
      body: { events: [laterEvidence], schemaVersion: EVIDENCE_SCHEMA_VERSION },
      method: "POST",
      url: "/v1/projects/prj_local/environments/env_local/evidence",
    });
    const fixtureRead = await app.inject({ method: "GET", url: fixtureVersionUrl });
    expect(laterIngest.statusCode).toBe(202);
    expect(fixtureRead.statusCode).toBe(200);
    expect(fixtureRead.json()).toMatchObject({
      version: {
        definitionSha256: publishedFixture.version.definitionSha256,
        source: { eventIds: [evidence.eventId], observedEventCount: 1 },
      },
    });

    const datasetPublication = await app.inject({
      body: datasetRequest,
      method: "POST",
      url: datasetVersionsUrl,
    });
    const publishedDataset = datasetPublication.json();
    expect(datasetPublication.statusCode).toBe(201);
    expect(publishedDataset).toMatchObject({
      created: true,
      version: {
        datasetId: "dat_checkout",
        datasetVersionId: datasetRequest.datasetVersionId,
        fixtureVersions: [
          {
            definitionSha256: publishedFixture.version.definitionSha256,
            fixtureId: "fix_checkout",
            fixtureVersionId: fixtureRequest.fixtureVersionId,
          },
        ],
      },
    });

    const datasetRetry = await app.inject({
      body: datasetRequest,
      method: "POST",
      url: datasetVersionsUrl,
    });
    const datasetRead = await app.inject({ method: "GET", url: datasetVersionUrl });
    expect(datasetRetry.statusCode).toBe(200);
    expect(datasetRetry.json()).toMatchObject({
      created: false,
      version: publishedDataset.version,
    });
    expect(datasetRead.statusCode).toBe(200);
    expect(datasetRead.json()).toMatchObject({ version: publishedDataset.version });
  });

  it("returns stable conflicts, lineage failures, and scope-safe not-found problems", async () => {
    const app = await testApp();
    await ingestTrace(app);
    await app.inject({ body: fixtureRequest, method: "POST", url: fixtureVersionsUrl });

    const conflict = await app.inject({
      body: { ...fixtureRequest, name: "Changed meaning" },
      method: "POST",
      url: fixtureVersionsUrl,
    });
    const lineage = await app.inject({
      body: { ...fixtureRequest, fixtureVersionId: "fixv_checkout_002" },
      method: "POST",
      url: fixtureVersionsUrl,
    });
    const crossResource = await app.inject({
      method: "GET",
      url: `${fixtureVersionsUrl.replace("fix_checkout", "fix_other")}/${fixtureRequest.fixtureVersionId}`,
    });
    const missingDataset = await app.inject({ method: "GET", url: datasetVersionUrl });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "regression_version_conflict", status: 409 });
    expect(lineage.statusCode).toBe(409);
    expect(lineage.json()).toMatchObject({
      code: "regression_version_lineage_invalid",
      status: 409,
    });
    expect(crossResource.statusCode).toBe(404);
    expect(crossResource.json()).toMatchObject({
      code: "regression_version_not_found",
      status: 404,
    });
    expect(missingDataset.statusCode).toBe(404);
    expect(missingDataset.json()).toMatchObject({
      code: "regression_version_not_found",
      status: 404,
    });
  });

  it("authenticates before parsing and enforces distinct manage and read capabilities", async () => {
    const missingAuthentication: Authenticator = {
      authenticate: async () => {
        throw new AuthenticationRequiredError();
      },
    };
    const unauthenticated = await testApp({ authenticator: missingAuthentication });
    const invalidProtectedRoute = await unauthenticated.inject({
      body: {},
      method: "POST",
      url: "/v1/projects/INVALID/environments/INVALID/regression-fixtures/INVALID/versions",
    });

    const reader = await testApp({ authenticator: authenticatorWith(["dataset:read"]) });
    const forbiddenPublish = await reader.inject({
      body: fixtureRequest,
      method: "POST",
      url: fixtureVersionsUrl,
    });
    const manager = await testApp({ authenticator: authenticatorWith(["dataset:manage"]) });
    const forbiddenRead = await manager.inject({ method: "GET", url: fixtureVersionUrl });

    expect(invalidProtectedRoute.statusCode).toBe(401);
    expect(invalidProtectedRoute.json()).toMatchObject({ code: "unauthenticated", status: 401 });
    expect(forbiddenPublish.statusCode).toBe(403);
    expect(forbiddenPublish.json()).toMatchObject({ code: "forbidden", status: 403 });
    expect(forbiddenRead.statusCode).toBe(403);
    expect(forbiddenRead.json()).toMatchObject({ code: "forbidden", status: 403 });
  });

  it("rejects malformed publications and missing source traces without partial versions", async () => {
    const app = await testApp();
    const malformed = await app.inject({
      body: { ...fixtureRequest, unexpected: true },
      method: "POST",
      url: fixtureVersionsUrl,
    });
    const missingTrace = await app.inject({
      body: fixtureRequest,
      method: "POST",
      url: fixtureVersionsUrl,
    });
    const absentAfterFailure = await app.inject({ method: "GET", url: fixtureVersionUrl });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "invalid_request", status: 400 });
    expect(missingTrace.statusCode).toBe(404);
    expect(missingTrace.json()).toMatchObject({ code: "trace_not_found", status: 404 });
    expect(absentAfterFailure.statusCode).toBe(404);
    expect(absentAfterFailure.json()).toMatchObject({
      code: "regression_version_not_found",
      status: 404,
    });
  });

  it("bounds domain-level invalid input without exposing validation internals", async () => {
    const invalidPrincipal: Authenticator = {
      authenticate: async () =>
        ({
          ...principal(["dataset:manage", "evidence:read"]),
          principalId: "INVALID",
        }) as PrincipalContext,
    };
    const app = await testApp({ authenticator: invalidPrincipal });

    const response = await app.inject({
      body: fixtureRequest,
      method: "POST",
      url: fixtureVersionsUrl,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "regression_version_input_invalid",
      detail: "The regression version request does not match the required contract",
      status: 400,
    });
  });

  it("does not expose regression repository contract failures", async () => {
    const unexpected = vi.fn(async () => {
      throw new Error("Unexpected repository call");
    });
    const regressionVersionRepository: RegressionVersionRepository = {
      datasetResourceExists: unexpected,
      findDatasetVersion: unexpected,
      findFixtureVersion: vi.fn(async () => ({ secret: "corrupt-row" }) as never),
      fixtureResourceExists: unexpected,
      publishDatasetVersion: unexpected,
      publishFixtureVersion: unexpected,
      resolveFixtureVersionReferences: unexpected,
    };
    const app = await testApp({ regressionVersionRepository });

    const response = await app.inject({ method: "GET", url: fixtureVersionUrl });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "internal_error",
      detail: "An unexpected error occurred",
      status: 500,
    });
    expect(JSON.stringify(response.json())).not.toContain("corrupt-row");
  });
});
