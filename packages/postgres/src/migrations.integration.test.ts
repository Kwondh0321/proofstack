import { EVIDENCE_SCHEMA_VERSION, type EvidenceRecord } from "@proofstack/contracts";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertMigrationsCurrent, migrateDatabase } from "./migration-runner.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const runtimeRole = "proofstack_test_runtime";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const startedAt = "2026-08-28T02:59:59.000Z";

function evidence(eventId: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    attributes: {},
    contentReferences: [],
    eventId,
    extensions: {},
    kind: "agent.run",
    name: "integration-agent",
    source: {
      sdkName: "@proofstack/sdk",
      sdkVersion: "0.0.0",
      serviceName: "integration-agent",
    },
    spanId: "00f067aa0ba902b7",
    startedAt,
    status: "ok",
    traceId,
    ...overrides,
  };
}

function insertValues(tenantId: string, record: EvidenceRecord): readonly unknown[] {
  return [
    tenantId,
    "prj_local",
    "env_local",
    record.eventId,
    record.traceId,
    record.spanId,
    record.parentSpanId ?? null,
    record.startedAt,
    record.sequence ?? 0,
    "2026-08-28T03:00:00.000Z",
    EVIDENCE_SCHEMA_VERSION,
    JSON.stringify(record),
  ];
}

const INSERT_EVIDENCE_SQL = `
  INSERT INTO public.proofstack_evidence_events (
    tenant_id,
    project_id,
    environment_id,
    event_id,
    trace_id,
    span_id,
    parent_span_id,
    started_at,
    sequence,
    received_at,
    schema_version,
    evidence
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
`;

async function asRuntime<Row extends QueryResultRow = QueryResultRow>(
  tenantId: string | undefined,
  query: (client: PoolClient) => Promise<QueryResult<Row>>,
): Promise<QueryResult<Row>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${runtimeRole}`);
    if (tenantId) {
      await client.query("SELECT set_config('proofstack.tenant_id', $1, true)", [tenantId]);
    }
    const result = await query(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  const database = await pool.query<{ current_database: string }>("SELECT current_database()");
  expect(database.rows[0]?.current_database).toBe("proofstack_test");

  await pool.query(`
    DO $$
    BEGIN
      CREATE ROLE ${runtimeRole} NOLOGIN;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$
  `);
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL evidence schema", () => {
  it("migrates atomically and enforces append-only tenant isolation", async () => {
    const firstMigration = await migrateDatabase(pool);
    expect(firstMigration.newlyAppliedIds).toEqual(["0001_evidence_store"]);
    await expect(assertMigrationsCurrent(pool)).resolves.toBeUndefined();

    await pool.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    await pool.query(`GRANT SELECT, INSERT ON public.proofstack_evidence_events TO ${runtimeRole}`);

    const security = await pool.query<{
      readonly relforcerowsecurity: boolean;
      readonly relrowsecurity: boolean;
    }>(`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE oid = 'public.proofstack_evidence_events'::regclass
    `);
    expect(security.rows[0]).toEqual({ relforcerowsecurity: true, relrowsecurity: true });

    const policies = await pool.query<{ readonly policyname: string }>(`
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'proofstack_evidence_events'
      ORDER BY policyname
    `);
    expect(policies.rows.map(({ policyname }) => policyname)).toEqual([
      "proofstack_evidence_tenant_insert",
      "proofstack_evidence_tenant_select",
    ]);

    const eventId = "evt_integration_001";
    const alphaEvidence = evidence(eventId);

    await expect(
      asRuntime(undefined, (client) =>
        client.query(INSERT_EVIDENCE_SQL, [...insertValues("ten_alpha", alphaEvidence)]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await asRuntime("ten_alpha", (client) =>
      client.query(INSERT_EVIDENCE_SQL, [...insertValues("ten_alpha", alphaEvidence)]),
    );

    const withoutTenant = await asRuntime(undefined, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM proofstack_evidence_events",
      ),
    );
    expect(withoutTenant.rows[0]?.count).toBe("0");

    const alphaRows = await asRuntime("ten_alpha", (client) =>
      client.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM proofstack_evidence_events ORDER BY event_id",
      ),
    );
    expect(alphaRows.rows).toEqual([{ tenant_id: "ten_alpha" }]);

    const betaRows = await asRuntime("ten_beta", (client) =>
      client.query<{ tenant_id: string }>("SELECT tenant_id FROM proofstack_evidence_events"),
    );
    expect(betaRows.rows).toEqual([]);

    await expect(
      asRuntime("ten_beta", (client) =>
        client.query(INSERT_EVIDENCE_SQL, [...insertValues("ten_alpha", alphaEvidence)]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await asRuntime("ten_beta", (client) =>
      client.query(INSERT_EVIDENCE_SQL, [...insertValues("ten_beta", alphaEvidence)]),
    );

    const mismatched = evidence("evt_integration_002");
    const mismatchedValues = [...insertValues("ten_alpha", mismatched)];
    mismatchedValues[4] = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await expect(
      asRuntime("ten_alpha", (client) => client.query(INSERT_EVIDENCE_SQL, mismatchedValues)),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      pool.query(
        "UPDATE proofstack_evidence_events SET received_at = clock_timestamp() WHERE tenant_id = 'ten_alpha'",
      ),
    ).rejects.toMatchObject({ code: "55000" });

    const secondMigration = await migrateDatabase(pool);
    expect(secondMigration.newlyAppliedIds).toEqual([]);
  });
});
