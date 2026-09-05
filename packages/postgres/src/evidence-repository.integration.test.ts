import type { EvidenceEnvelope } from "@proofstack/contracts";
import { evidenceRepositoryConformanceCases } from "@proofstack/core/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresEvidenceRepository } from "./postgres-evidence-repository.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runtimeRole = "proofstack_test_runtime";
const runtimePassword = "proofstack_test_runtime";
const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
const runtimeDatabaseUrl = new URL(databaseUrl);
runtimeDatabaseUrl.username = runtimeRole;
runtimeDatabaseUrl.password = runtimePassword;
const runtimeConnectionString = runtimeDatabaseUrl.toString();
const runtimePool = new Pool({ connectionString: runtimeConnectionString, max: 4 });

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
  await adminPool.query(
    `GRANT SELECT, INSERT ON public.proofstack_evidence_events TO ${runtimeRole}`,
  );
  await adminPool.query(`GRANT INSERT ON public.proofstack_outbox TO ${runtimeRole}`);
});

afterAll(async () => {
  await Promise.all([runtimePool.end(), adminPool.end()]);
});

describe("PostgresEvidenceRepository contract", () => {
  for (const testCase of evidenceRepositoryConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(() => ({ repository: new PostgresEvidenceRepository(runtimePool) }));
    });
  }

  it("retains authoritative evidence across connection pool restarts", async () => {
    const persisted: EvidenceEnvelope = {
      evidence: {
        attributes: {},
        contentReferences: [],
        eventId: "evt_restart_001",
        extensions: {},
        kind: "agent.run",
        name: "restart-contract",
        source: {
          sdkName: "@proofstack/testkit",
          sdkVersion: "0.0.0",
          serviceName: "restart-contract",
        },
        spanId: "40f067aa0ba902b7",
        startedAt: "2026-08-28T02:59:59.000Z",
        status: "ok",
        traceId: "5bf92f3577b34da6a3ce929d0e0e4736",
      },
      receivedAt: "2026-08-28T03:00:00.000Z",
      schemaVersion: "0.1",
      scope: {
        environmentId: "env_restart",
        projectId: "prj_restart",
        tenantId: "ten_restart",
      },
    };
    const firstPool = new Pool({ connectionString: runtimeConnectionString, max: 1 });
    await new PostgresEvidenceRepository(firstPool).append([persisted]);
    await firstPool.end();

    const restartedPool = new Pool({ connectionString: runtimeConnectionString, max: 1 });
    try {
      const page = await new PostgresEvidenceRepository(restartedPool).listByTrace(
        persisted.scope,
        persisted.evidence.traceId,
        { limit: 10 },
      );
      expect(page.events).toEqual([persisted]);
      await expect(
        new PostgresEvidenceRepository(restartedPool).resolveExactEvents(
          persisted.scope,
          persisted.evidence.traceId,
          [persisted.evidence.eventId],
        ),
      ).resolves.toEqual([persisted]);
      await expect(
        new PostgresEvidenceRepository(restartedPool).resolveExactEvents(
          { ...persisted.scope, tenantId: "ten_restart_hidden" },
          persisted.evidence.traceId,
          [persisted.evidence.eventId],
        ),
      ).resolves.toBeNull();
    } finally {
      await restartedPool.end();
    }
  });

  it("records one publication intent for accepted evidence and none for a retry", async () => {
    const repository = new PostgresEvidenceRepository(runtimePool);
    const accepted: EvidenceEnvelope = {
      evidence: {
        attributes: {},
        contentReferences: [],
        eventId: "evt_outbox_contract_001",
        extensions: {},
        kind: "agent.run",
        name: "outbox-contract",
        source: {
          sdkName: "@proofstack/testkit",
          sdkVersion: "0.0.0",
          serviceName: "outbox-contract",
        },
        spanId: "60f067aa0ba902b7",
        startedAt: "2026-08-28T02:59:59.000Z",
        status: "ok",
        traceId: "7bf92f3577b34da6a3ce929d0e0e4736",
      },
      receivedAt: "2026-08-28T03:00:00.000Z",
      schemaVersion: "0.1",
      scope: {
        environmentId: "env_outbox",
        projectId: "prj_outbox",
        tenantId: "ten_outbox",
      },
    };

    await repository.append([accepted]);
    await repository.append([{ ...accepted, receivedAt: "2026-08-28T03:01:00.000Z" }]);

    const intents = await adminPool.query<{
      readonly aggregate_id: string;
      readonly payload: EvidenceEnvelope;
    }>(`
      SELECT aggregate_id, payload
      FROM proofstack_outbox
      WHERE tenant_id = 'ten_outbox' AND aggregate_id = 'evt_outbox_contract_001'
    `);
    expect(intents.rows).toEqual([
      {
        aggregate_id: accepted.evidence.eventId,
        payload: accepted,
      },
    ]);
  });
});
