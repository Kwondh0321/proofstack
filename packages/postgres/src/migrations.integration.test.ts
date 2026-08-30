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
      CREATE ROLE ${runtimeRole} LOGIN PASSWORD 'proofstack_test_runtime';
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
    const expectedMigrations = [
      "0001_evidence_store",
      "0002_outbox_delivery",
      "0003_leased_consumer_receipts",
      "0004_workload_identity",
      "0005_oidc_browser_identity",
      "0006_repair_oidc_transaction_format",
      "0007_saturate_api_key_use_count",
      "0008_artifact_capabilities",
      "0009_artifact_catalog",
      "0010_force_identity_tenant_rls",
      "0011_dataset_capabilities",
      "0012_pin_evidence_event_collation",
      "0013_regression_catalog",
      "0014_recorded_interaction_fixtures",
      "0015_expand_artifact_tombstone_trigger",
      "0016_durable_replay_definitions",
      "0017_durable_replay_job_ledger",
      "0018_replay_job_control_authority",
      "0019_replay_worker_lease_authority",
      "0020_audited_replay_attempt_transitions",
      "0021_replay_worker_completion_authority",
      "0022_replay_worker_cancellation_acknowledgement",
      "0023_replay_estimated_budget_measurement",
      "0024_replay_budget_work_boundary_kinds",
      "0025_replay_worker_budget_reservation_authority",
    ];
    expect(firstMigration.appliedIds).toEqual(expectedMigrations);
    expect(firstMigration.newlyAppliedIds).toEqual(
      firstMigration.newlyAppliedIds.length === 0
        ? []
        : expectedMigrations.slice(-firstMigration.newlyAppliedIds.length),
    );
    await expect(assertMigrationsCurrent(pool)).resolves.toBeUndefined();

    const traceOrderIndex = await pool.query<{
      readonly collation_name: string;
      readonly collation_schema: string;
      readonly ready: boolean;
      readonly valid: boolean;
    }>(`
      SELECT
        selected_collation.collname AS collation_name,
        selected_collation_namespace.nspname AS collation_schema,
        index_metadata.indisready AS ready,
        index_metadata.indisvalid AS valid
      FROM pg_index AS index_metadata
      CROSS JOIN LATERAL
        unnest(index_metadata.indcollation::oid[]) WITH ORDINALITY
          AS index_key(collation_oid, key_position)
      JOIN pg_collation AS selected_collation
        ON selected_collation.oid = index_key.collation_oid
      JOIN pg_namespace AS selected_collation_namespace
        ON selected_collation_namespace.oid = selected_collation.collnamespace
      WHERE index_metadata.indexrelid =
        'public.proofstack_evidence_trace_order_idx'::regclass
        AND index_key.key_position = 7
    `);
    expect(traceOrderIndex.rows).toEqual([
      {
        collation_name: "C",
        collation_schema: "pg_catalog",
        ready: true,
        valid: true,
      },
    ]);

    const platformCapabilities = await pool.query<{
      readonly datasetManagementWorkload: boolean;
      readonly datasetReadWorkload: boolean;
      readonly datasetUser: boolean;
      readonly restrictedWorkload: boolean;
      readonly userLifecycle: boolean;
      readonly workloadTransfer: boolean;
    }>(`
      SELECT
        public.proofstack_valid_workload_capabilities(
          ARRAY['artifact:write', 'artifact:read']::text[]
        ) AS "workloadTransfer",
        public.proofstack_valid_workload_capabilities(
          ARRAY['artifact:read:restricted']::text[]
        ) AS "restrictedWorkload",
        public.proofstack_valid_workload_capabilities(
          ARRAY['dataset:read']::text[]
        ) AS "datasetReadWorkload",
        public.proofstack_valid_workload_capabilities(
          ARRAY['dataset:manage']::text[]
        ) AS "datasetManagementWorkload",
        public.proofstack_valid_user_capabilities(
          ARRAY[
            'artifact:write',
            'artifact:read',
            'artifact:read:restricted',
            'artifact:delete'
          ]::text[]
        ) AS "userLifecycle",
        public.proofstack_valid_user_capabilities(
          ARRAY['dataset:read', 'dataset:manage']::text[]
        ) AS "datasetUser"
    `);
    expect(platformCapabilities.rows[0]).toEqual({
      datasetManagementWorkload: false,
      datasetReadWorkload: true,
      datasetUser: true,
      restrictedWorkload: false,
      userLifecycle: true,
      workloadTransfer: true,
    });

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

    const tenantTables = await pool.query<{
      readonly relforcerowsecurity: boolean;
      readonly relname: string;
      readonly relrowsecurity: boolean;
    }>(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN (
        'proofstack_outbox',
        'proofstack_projection_cursors',
        'proofstack_consumer_receipts'
      )
      ORDER BY relname
    `);
    expect(tenantTables.rows).toEqual([
      {
        relforcerowsecurity: true,
        relname: "proofstack_consumer_receipts",
        relrowsecurity: true,
      },
      {
        relforcerowsecurity: true,
        relname: "proofstack_outbox",
        relrowsecurity: true,
      },
      {
        relforcerowsecurity: true,
        relname: "proofstack_projection_cursors",
        relrowsecurity: true,
      },
    ]);

    const outbox = await pool.query<{ readonly outbox_id: string }>(`
      INSERT INTO proofstack_outbox (
        tenant_id,
        event_type,
        aggregate_type,
        aggregate_id,
        schema_version,
        payload,
        created_at
      ) VALUES (
        'ten_migration',
        'evidence.appended',
        'evidence',
        'evt_migration_outbox',
        '0.1',
        '{"eventId":"evt_migration_outbox"}'::jsonb,
        clock_timestamp()
      )
      RETURNING outbox_id::text
    `);
    await expect(
      pool.query("UPDATE proofstack_outbox SET payload = '{}' WHERE outbox_id = $1", [
        outbox.rows[0]?.outbox_id,
      ]),
    ).rejects.toMatchObject({ code: "55000" });

    await pool.query(`
      INSERT INTO proofstack_projection_cursors (
        tenant_id,
        consumer_name,
        last_outbox_id
      ) VALUES ('ten_migration', 'trace.projector', 10)
    `);
    await pool.query(`
      UPDATE proofstack_projection_cursors
      SET last_outbox_id = 11
      WHERE tenant_id = 'ten_migration' AND consumer_name = 'trace.projector'
    `);
    await expect(
      pool.query(`
        UPDATE proofstack_projection_cursors
        SET last_outbox_id = 9
        WHERE tenant_id = 'ten_migration' AND consumer_name = 'trace.projector'
      `),
    ).rejects.toMatchObject({ code: "55000" });

    await pool.query(`
      INSERT INTO proofstack_consumer_receipts (
        tenant_id,
        consumer_name,
        message_id,
        payload_sha256,
        state,
        created_at,
        available_at,
        attempt_count,
        completed_at
      ) VALUES (
        'ten_migration',
        'trace.projector',
        'message-001',
        '${"a".repeat(64)}',
        'completed',
        '2026-08-28T03:00:00.000Z',
        '2026-08-28T03:00:00.000Z',
        1,
        '2026-08-28T03:00:00.000Z'
      )
    `);
    await expect(
      pool.query(`
        UPDATE proofstack_consumer_receipts
        SET state = 'processing',
            completed_at = NULL,
            lease_token = '10000000-0000-4000-8000-000000000001',
            lease_owner = 'wrk_illegal',
            lease_expires_at = clock_timestamp() + interval '1 minute',
            attempt_count = 2
        WHERE tenant_id = 'ten_migration' AND consumer_name = 'trace.projector'
      `),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(`
        DELETE FROM proofstack_consumer_receipts
        WHERE tenant_id = 'ten_migration' AND consumer_name = 'trace.projector'
      `),
    ).rejects.toMatchObject({ code: "55000" });

    const secondMigration = await migrateDatabase(pool);
    expect(secondMigration.newlyAppliedIds).toEqual([]);
  });
});
