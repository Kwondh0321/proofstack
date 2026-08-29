import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runtimeRole = "proofstack_test_artifact_schema";
const pool = new Pool({ connectionString: databaseUrl, max: 4 });

const INSERT_RESERVED_SQL = `
  INSERT INTO public.proofstack_artifact_catalog (
    tenant_id,
    project_id,
    environment_id,
    artifact_id,
    schema_version,
    state,
    classification,
    media_type,
    content_sha256,
    content_size_bytes,
    redaction,
    retention_mode,
    expires_at,
    created_at,
    created_by_principal_id,
    object_key,
    encryption_version,
    content_nonce,
    wrapped_key_algorithm,
    wrapped_key_id,
    wrapped_key_ciphertext,
    wrapped_key_nonce,
    wrapped_key_tag
  ) VALUES (
    $1,
    'prj_artifact_schema',
    'env_artifact_schema',
    $2,
    '0.1',
    'reserved',
    'confidential',
    'application/json',
    $3,
    18,
    '{"status":"not_required"}'::jsonb,
    'expire',
    '2026-09-28T03:00:00.000Z',
    '2026-08-28T03:00:00.000Z',
    'usr_artifact_schema',
    $4,
    'a256gcm-v1',
    'AQEBAQEBAQEBAQEB',
    'A256GCM',
    'key_artifact_schema',
    'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
    'AgICAgICAgICAgIC',
    'AwMDAwMDAwMDAwMDAwMDAw'
  )
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
  await migrateDatabase(pool);
  await pool.query(`
    DO $$
    BEGIN
      CREATE ROLE ${runtimeRole} LOGIN PASSWORD 'proofstack_test_artifact_schema';
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$
  `);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE ON public.proofstack_artifact_catalog TO ${runtimeRole}`,
  );
  await pool.query(
    `GRANT SELECT, INSERT ON public.proofstack_artifact_tombstones TO ${runtimeRole}`,
  );
  await pool.query(
    `GRANT SELECT, INSERT ON public.proofstack_artifact_purge_receipts TO ${runtimeRole}`,
  );
  await pool.query(
    `GRANT SELECT ON public.proofstack_interaction_fixture_artifact_ownerships, public.proofstack_interaction_fixture_content_revocations TO ${runtimeRole}`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL artifact catalog schema", () => {
  it("forces tenant isolation for the catalog and append-only lifecycle records", async () => {
    const security = await pool.query<{
      readonly relforcerowsecurity: boolean;
      readonly relname: string;
      readonly relrowsecurity: boolean;
    }>(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN (
        'proofstack_artifact_catalog',
        'proofstack_artifact_tombstones',
        'proofstack_artifact_purge_receipts'
      )
      ORDER BY relname
    `);
    expect(security.rows).toEqual([
      {
        relforcerowsecurity: true,
        relname: "proofstack_artifact_catalog",
        relrowsecurity: true,
      },
      {
        relforcerowsecurity: true,
        relname: "proofstack_artifact_purge_receipts",
        relrowsecurity: true,
      },
      {
        relforcerowsecurity: true,
        relname: "proofstack_artifact_tombstones",
        relrowsecurity: true,
      },
    ]);

    await expect(
      asRuntime(undefined, (client) =>
        client.query(INSERT_RESERVED_SQL, [
          "ten_artifact_alpha",
          "art_schema_missing_scope",
          "1".repeat(64),
          "objects/v1/aa/missing-scope",
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await asRuntime("ten_artifact_alpha", (client) =>
      client.query(INSERT_RESERVED_SQL, [
        "ten_artifact_alpha",
        "art_schema_lifecycle",
        "1".repeat(64),
        "objects/v1/aa/schema-lifecycle",
      ]),
    );

    const hidden = await asRuntime("ten_artifact_beta", (client) =>
      client.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM public.proofstack_artifact_catalog",
      ),
    );
    expect(hidden.rows[0]?.count).toBe("0");
  });

  it("allows only receipt-backed forward lifecycle transitions", async () => {
    await expect(
      asRuntime("ten_artifact_alpha", (client) =>
        client.query(`
          UPDATE public.proofstack_artifact_catalog
          SET media_type = 'text/plain'
          WHERE tenant_id = 'ten_artifact_alpha' AND artifact_id = 'art_schema_lifecycle'
        `),
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await asRuntime("ten_artifact_alpha", (client) =>
      client.query(`
        UPDATE public.proofstack_artifact_catalog
        SET state = 'available',
            available_at = '2026-08-28T03:01:00.000Z',
            object_receipt_sha256 = '${"a".repeat(64)}',
            object_receipt_size_bytes = 38
        WHERE tenant_id = 'ten_artifact_alpha' AND artifact_id = 'art_schema_lifecycle'
      `),
    );

    await expect(
      asRuntime("ten_artifact_alpha", (client) =>
        client.query(`
          INSERT INTO public.proofstack_artifact_tombstones (
            tenant_id,
            artifact_id,
            tombstone_id,
            actor_principal_id,
            tombstone_trigger,
            reason,
            occurred_at
          ) VALUES (
            'ten_artifact_alpha',
            'art_schema_lifecycle',
            'del_orphaned_receipt',
            'usr_artifact_schema',
            'manual',
            'Receipt without state transition',
            '2026-08-28T03:02:00.000Z'
          )
        `),
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await asRuntime("ten_artifact_alpha", async (client) => {
      await client.query(`
        INSERT INTO public.proofstack_artifact_tombstones (
          tenant_id,
          artifact_id,
          tombstone_id,
          actor_principal_id,
          tombstone_trigger,
          reason,
          occurred_at
        ) VALUES (
          'ten_artifact_alpha',
          'art_schema_lifecycle',
          'del_schema_lifecycle',
          'usr_artifact_schema',
          'retention',
          'Retention period elapsed',
          '2026-09-28T03:00:00.000Z'
        )
      `);
      return client.query(`
        UPDATE public.proofstack_artifact_catalog
        SET state = 'tombstoned', tombstoned_at = '2026-09-28T03:00:00.000Z'
        WHERE tenant_id = 'ten_artifact_alpha' AND artifact_id = 'art_schema_lifecycle'
      `);
    });

    await asRuntime("ten_artifact_alpha", async (client) => {
      await client.query(`
        INSERT INTO public.proofstack_artifact_purge_receipts (
          tenant_id,
          artifact_id,
          purge_id,
          object_was_present,
          occurred_at
        ) VALUES (
          'ten_artifact_alpha',
          'art_schema_lifecycle',
          'purge_schema_lifecycle',
          true,
          '2026-09-28T03:01:00.000Z'
        )
      `);
      return client.query(`
        UPDATE public.proofstack_artifact_catalog
        SET state = 'purged', purged_at = '2026-09-28T03:01:00.000Z'
        WHERE tenant_id = 'ten_artifact_alpha' AND artifact_id = 'art_schema_lifecycle'
      `);
    });

    await expect(
      pool.query(`
        DELETE FROM public.proofstack_artifact_tombstones
        WHERE tenant_id = 'ten_artifact_alpha' AND artifact_id = 'art_schema_lifecycle'
      `),
    ).rejects.toMatchObject({ code: "55000" });

    const finalState = await pool.query<{
      readonly purged_at: string;
      readonly state: string;
      readonly tombstoned_at: string;
    }>(`
      SELECT state, tombstoned_at, purged_at
      FROM public.proofstack_artifact_catalog
      WHERE tenant_id = 'ten_artifact_alpha' AND artifact_id = 'art_schema_lifecycle'
    `);
    expect(finalState.rows[0]).toMatchObject({ state: "purged" });
  });
});
