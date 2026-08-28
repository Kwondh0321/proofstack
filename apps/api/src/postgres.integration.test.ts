import { EVIDENCE_SCHEMA_VERSION } from "@proofstack/contracts";
import { createPostgresPool, migrateDatabase } from "@proofstack/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runtimeRole = "proofstack_test_runtime";
const runtimePassword = "proofstack_test_runtime";
const adminPool = createPostgresPool({
  applicationName: "proofstack-api-integration-setup",
  connectionString: databaseUrl,
  maxConnections: 1,
  onIdleError: (error) => {
    throw error;
  },
});
const runtimeDatabaseUrl = new URL(databaseUrl);
runtimeDatabaseUrl.username = runtimeRole;
runtimeDatabaseUrl.password = runtimePassword;

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await adminPool.query(`
    DO $$
    BEGIN
      CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}';
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$
  `);
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
  await adminPool.query(`GRANT SELECT ON public.proofstack_schema_migrations TO ${runtimeRole}`);
  await adminPool.query(
    `GRANT SELECT, INSERT ON public.proofstack_evidence_events TO ${runtimeRole}`,
  );
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
});
