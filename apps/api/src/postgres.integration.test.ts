import { EVIDENCE_SCHEMA_VERSION } from "@proofstack/contracts";
import {
  bootstrapApiKey,
  createPostgresPool,
  inspectIdentityCredentials,
  migrateDatabase,
  PostgresApiKeyCredentialRepository,
  provisionRuntimeRoles,
} from "@proofstack/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runtimeRoles = {
  api: { name: "proofstack_test_api_runtime", password: "proofstack-test-api-runtime" },
  artifact: {
    name: "proofstack_test_artifact_runtime",
    password: "proofstack-test-artifact-runtime",
  },
  consumer: {
    name: "proofstack_test_consumer_runtime",
    password: "proofstack-test-consumer-runtime",
  },
  identity: {
    name: "proofstack_test_identity_runtime",
    password: "proofstack-test-identity-runtime",
  },
  publisher: {
    name: "proofstack_test_publisher_runtime",
    password: "proofstack-test-publisher-runtime",
  },
} as const;
const adminPool = createPostgresPool({
  applicationName: "proofstack-api-integration-setup",
  connectionString: databaseUrl,
  maxConnections: 1,
  onIdleError: (error) => {
    throw error;
  },
});
const runtimeDatabaseUrl = new URL(databaseUrl);
runtimeDatabaseUrl.username = runtimeRoles.api.name;
runtimeDatabaseUrl.password = runtimeRoles.api.password;
const identityDatabaseUrl = new URL(databaseUrl);
identityDatabaseUrl.username = runtimeRoles.identity.name;
identityDatabaseUrl.password = runtimeRoles.identity.password;
let issuedApiKey: Awaited<ReturnType<typeof bootstrapApiKey>>;

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, runtimeRoles);
  issuedApiKey = await bootstrapApiKey(adminPool, {
    actorPrincipalId: "usr_integration_operator",
    capabilities: ["evidence:ingest", "evidence:read"],
    name: "api-integration",
    resourceScope: { mode: "tenant" },
    tenantId: "ten_local",
  });
});

afterAll(async () => {
  await adminPool.end();
});

function postgresConfig() {
  return loadConfig({
    PROOFSTACK_AUTH_MODE: "development",
    PROOFSTACK_DATABASE_URL: runtimeDatabaseUrl.toString(),
    PROOFSTACK_ENV: "test",
    PROOFSTACK_LOG_LEVEL: "silent",
    PROOFSTACK_STORAGE_MODE: "postgres",
  });
}

function apiKeyConfig() {
  return loadConfig({
    PROOFSTACK_AUTH_MODE: "api_key",
    PROOFSTACK_DATABASE_URL: runtimeDatabaseUrl.toString(),
    PROOFSTACK_ENV: "test",
    PROOFSTACK_IDENTITY_DATABASE_URL: identityDatabaseUrl.toString(),
    PROOFSTACK_LOG_LEVEL: "silent",
    PROOFSTACK_STORAGE_MODE: "postgres",
  });
}

describe("PostgreSQL-backed API", () => {
  it("retains an ingested trace after the API and its pool are restarted", async () => {
    const traceId = "6bf92f3577b34da6a3ce929d0e0e4736";
    const evidence = {
      eventId: "evt_api_restart_001",
      kind: "agent.run",
      name: "api-restart-test",
      source: {
        sdkName: "@proofstack/sdk",
        sdkVersion: "0.0.0",
        serviceName: "api-restart-test",
      },
      spanId: "50f067aa0ba902b7",
      startedAt: "2026-08-28T03:59:59.000Z",
      traceId,
    };

    const firstApp = await createApp(postgresConfig());
    try {
      const ingest = await firstApp.inject({
        body: { events: [evidence], schemaVersion: EVIDENCE_SCHEMA_VERSION },
        method: "POST",
        url: "/v1/projects/prj_local/environments/env_local/evidence",
      });
      expect(ingest.statusCode).toBe(202);
    } finally {
      await firstApp.close();
    }

    const restartedApp = await createApp(postgresConfig());
    try {
      const readiness = await restartedApp.inject({ method: "GET", url: "/health/ready" });
      const trace = await restartedApp.inject({
        method: "GET",
        url: `/v1/projects/prj_local/environments/env_local/traces/${traceId}`,
      });

      expect(readiness.statusCode).toBe(200);
      expect(trace.statusCode).toBe(200);
      expect(trace.json()).toMatchObject({
        events: [{ evidence: { eventId: evidence.eventId }, scope: { tenantId: "ten_local" } }],
        traceId,
      });
    } finally {
      await restartedApp.close();
    }
  });

  it("authenticates a bootstrapped key and observes authoritative revocation", async () => {
    const traceId = "7bf92f3577b34da6a3ce929d0e0e4736";
    const authorization = `Bearer ${issuedApiKey.value}`;
    const app = await createApp(apiKeyConfig());
    try {
      const ingest = await app.inject({
        body: {
          events: [
            {
              eventId: "evt_api_key_integration_001",
              kind: "agent.run",
              name: "api-key-integration",
              source: {
                sdkName: "@proofstack/sdk",
                sdkVersion: "0.0.0",
                serviceName: "api-key-integration",
              },
              spanId: "60f067aa0ba902b7",
              startedAt: "2026-08-28T03:59:59.000Z",
              traceId,
            },
          ],
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
        },
        headers: { authorization },
        method: "POST",
        url: "/v1/projects/prj_local/environments/env_local/evidence",
      });
      const trace = await app.inject({
        headers: { authorization },
        method: "GET",
        url: `/v1/projects/prj_local/environments/env_local/traces/${traceId}`,
      });
      const wrongLastCharacter = issuedApiKey.value.endsWith("A") ? "B" : "A";
      const wrongKey = `${issuedApiKey.value.slice(0, -1)}${wrongLastCharacter}`;
      const rejected = await app.inject({
        headers: { authorization: `Bearer ${wrongKey}` },
        method: "GET",
        url: `/v1/projects/prj_local/environments/env_local/traces/${traceId}`,
      });

      expect(ingest.statusCode).toBe(202);
      expect(trace.statusCode).toBe(200);
      expect(rejected.statusCode).toBe(401);
      expect(rejected.body).not.toContain(issuedApiKey.credential.prefix);

      const beforeRevocation = await inspectIdentityCredentials(adminPool, "ten_local");
      expect(beforeRevocation.active).toBeGreaterThanOrEqual(1);
      const administrator = new PostgresApiKeyCredentialRepository(adminPool);
      await expect(
        administrator.revoke(
          "ten_local",
          issuedApiKey.credential.credentialId,
          "usr_integration_operator",
          "integration verification complete",
        ),
      ).resolves.toBe(true);

      const revoked = await app.inject({
        headers: { authorization },
        method: "GET",
        url: `/v1/projects/prj_local/environments/env_local/traces/${traceId}`,
      });
      expect(revoked.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
