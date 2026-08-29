import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { assertMigrationsCurrent, migrateDatabase } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const REGRESSION_TABLES = [
  "proofstack_regression_dataset_members",
  "proofstack_regression_dataset_versions",
  "proofstack_regression_datasets",
  "proofstack_regression_fixture_events",
  "proofstack_regression_fixture_versions",
  "proofstack_regression_fixtures",
] as const;

const INSERT_FIXTURE_RESOURCE_SQL = `
  INSERT INTO public.proofstack_regression_fixtures (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    root_fixture_version_id,
    root_definition_sha256
  ) VALUES ($1, $2, $3, $4, $5, $6)
`;

const INSERT_FIXTURE_VERSION_SQL = `
  INSERT INTO public.proofstack_regression_fixture_versions (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    root_fixture_version_id,
    root_definition_sha256,
    fixture_version_id,
    schema_version,
    name,
    description,
    predecessor_fixture_version_id,
    predecessor_definition_sha256,
    replayability,
    source_kind,
    source_trace_id,
    source_event_count,
    source_completeness,
    source_captured_at,
    source_captured_at_lexical,
    created_at,
    created_at_lexical,
    created_by_principal_id,
    definition_sha256
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
    $18, $19, $20, $21, $22, $23
  )
`;

const INSERT_FIXTURE_EVENT_SQL = `
  INSERT INTO public.proofstack_regression_fixture_events (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    source_trace_id,
    source_event_count,
    event_position,
    event_id
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
`;

const INSERT_DATASET_RESOURCE_SQL = `
  INSERT INTO public.proofstack_regression_datasets (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    root_dataset_version_id,
    root_definition_sha256
  ) VALUES ($1, $2, $3, $4, $5, $6)
`;

const INSERT_DATASET_VERSION_SQL = `
  INSERT INTO public.proofstack_regression_dataset_versions (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    root_dataset_version_id,
    root_definition_sha256,
    dataset_version_id,
    schema_version,
    name,
    description,
    predecessor_dataset_version_id,
    predecessor_definition_sha256,
    fixture_version_count,
    created_at,
    created_at_lexical,
    created_by_principal_id,
    definition_sha256
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
`;

const INSERT_DATASET_MEMBER_SQL = `
  INSERT INTO public.proofstack_regression_dataset_members (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    dataset_version_id,
    fixture_version_count,
    member_position,
    fixture_id,
    fixture_version_id,
    fixture_definition_sha256
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
`;

async function asRuntime<Row extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  runtimeRole: string,
  tenantId: string | undefined,
  query: (client: PoolClient) => Promise<QueryResult<Row>>,
): Promise<QueryResult<Row>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
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

describe("regression catalog migration", () => {
  it("installs an immutable, tenant-isolated catalog with complete ordered membership", async () => {
    const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
    const databaseName = `proofstack_regression_${process.pid}_${runKey}`;
    const runtimeRole = `ps_regression_${runKey}`;
    const controlPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const upgradeUrl = new URL(databaseUrl);
    upgradeUrl.pathname = `/${databaseName}`;
    let roleCreated = false;
    let upgradePool: Pool | undefined;

    const tenantId = `ten_regression_${runKey}`;
    const otherTenantId = `ten_regression_other_${runKey}`;
    const projectId = `prj_regression_${runKey}`;
    const environmentId = `env_regression_${runKey}`;
    const fixtureId = `fix_regression_${runKey}`;
    const fixtureVersionId = `fiv_regression_${runKey}`;
    const fixtureDigest = "a".repeat(64);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const eventId = `evt_regression_${runKey}`;
    const datasetId = `dts_regression_${runKey}`;
    const datasetVersionId = `dsv_regression_${runKey}`;
    const datasetDigest = "b".repeat(64);
    const fixtureCapturedAt = "2026-08-29T09:00:00.123456789012345678901234567890+15:59";
    const fixtureCreatedAt = "2026-08-29T09:00:00.123Z";
    const datasetCreatedAt = "2026-08-29T09:00:00.987Z";

    try {
      await controlPool.query(`CREATE DATABASE "${databaseName}"`);
      upgradePool = new Pool({ connectionString: upgradeUrl.toString(), max: 2 });

      const migrations = await loadBundledMigrations();
      const migrationIndex = migrations.findIndex(({ id }) => id === "0013_regression_catalog");
      expect(migrationIndex).toBeGreaterThan(0);
      const previousMigrations = migrations.slice(0, migrationIndex);
      const targetMigrations = migrations.slice(0, migrationIndex + 1);
      await migrateDatabase(upgradePool, previousMigrations);
      await expect(migrateDatabase(upgradePool, targetMigrations)).resolves.toMatchObject({
        newlyAppliedIds: ["0013_regression_catalog"],
      });
      await expect(assertMigrationsCurrent(upgradePool, targetMigrations)).resolves.toBeUndefined();

      const security = await upgradePool.query<{
        readonly policy_count: number;
        readonly public_dml_grant: boolean;
        readonly relforcerowsecurity: boolean;
        readonly relname: string;
        readonly relrowsecurity: boolean;
      }>(
        `
        SELECT
          relation.relname,
          relation.relrowsecurity,
          relation.relforcerowsecurity,
          (
            SELECT count(*)::integer
            FROM pg_policies AS policy
            WHERE policy.schemaname = namespace.nspname
              AND policy.tablename = relation.relname
          ) AS policy_count,
          EXISTS (
            SELECT 1
            FROM information_schema.table_privileges AS privilege
            WHERE privilege.table_schema = namespace.nspname
              AND privilege.table_name = relation.relname
              AND privilege.grantee = 'PUBLIC'
              AND privilege.privilege_type = ANY (ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
          ) AS public_dml_grant
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = ANY($1::text[])
        ORDER BY relation.relname
      `,
        [REGRESSION_TABLES],
      );
      expect(security.rows.map(({ relname }) => relname)).toEqual(REGRESSION_TABLES);
      expect(
        security.rows.every(
          ({ policy_count, public_dml_grant, relforcerowsecurity, relrowsecurity }) =>
            policy_count === 2 && !public_dml_grant && relforcerowsecurity && relrowsecurity,
        ),
      ).toBe(true);

      const publicationHelperSecurity = await upgradePool.query<{
        readonly proconfig: readonly string[];
        readonly prosecdef: boolean;
        readonly public_execute: boolean;
      }>(`
        SELECT
          procedure.prosecdef,
          procedure.proconfig,
          EXISTS (
            SELECT 1
            FROM aclexplode(
              COALESCE(
                procedure.proacl,
                acldefault('f', procedure.proowner)
              )
            ) AS privilege
            WHERE privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
          ) AS public_execute
        FROM pg_proc AS procedure
        JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public'
          AND procedure.proname = 'proofstack_regression_publication_intent_status'
          AND procedure.pronargs = 7
      `);
      expect(publicationHelperSecurity.rows).toEqual([
        { proconfig: ["search_path=pg_catalog"], prosecdef: true, public_execute: false },
      ]);

      const evidenceDependencies = await upgradePool.query<{ readonly count: number }>(`
        SELECT count(*)::integer AS count
        FROM pg_constraint
        WHERE conrelid = 'public.proofstack_regression_fixture_events'::regclass
          AND confrelid = 'public.proofstack_evidence_events'::regclass
      `);
      expect(evidenceDependencies.rows).toEqual([{ count: 0 }]);

      await controlPool.query(`CREATE ROLE "${runtimeRole}" NOLOGIN`);
      roleCreated = true;
      await upgradePool.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
      await upgradePool.query(
        `GRANT SELECT, INSERT ON TABLE ${REGRESSION_TABLES.map((table) => `public.${table}`).join(", ")} TO "${runtimeRole}"`,
      );
      await upgradePool.query(
        `GRANT EXECUTE ON FUNCTION public.proofstack_valid_regression_text(text, integer) TO "${runtimeRole}"`,
      );

      const textValidation = await asRuntime(upgradePool, runtimeRole, undefined, (client) =>
        client.query<{
          readonly bidi: boolean;
          readonly canonical: boolean;
          readonly decomposed: boolean;
          readonly padded: boolean;
        }>(`
          SELECT
            public.proofstack_valid_regression_text('Checkout 🧪', 128) AS canonical,
            public.proofstack_valid_regression_text(U&'Cafe\\0301', 128) AS decomposed,
            public.proofstack_valid_regression_text(U&'\\00A0padded', 128) AS padded,
            public.proofstack_valid_regression_text(U&'unsafe\\202Edisplay', 128) AS bidi
        `),
      );
      expect(textValidation.rows).toEqual([
        { bidi: false, canonical: true, decomposed: false, padded: false },
      ]);

      await asRuntime(upgradePool, runtimeRole, tenantId, async (client) => {
        await client.query(INSERT_FIXTURE_RESOURCE_SQL, [
          tenantId,
          projectId,
          environmentId,
          fixtureId,
          fixtureVersionId,
          fixtureDigest,
        ]);
        await client.query(INSERT_FIXTURE_VERSION_SQL, [
          tenantId,
          projectId,
          environmentId,
          fixtureId,
          fixtureVersionId,
          fixtureDigest,
          fixtureVersionId,
          "0.1",
          "Checkout 🧪",
          null,
          null,
          null,
          "evidence_only",
          "trace_snapshot",
          traceId,
          1,
          "observed_snapshot",
          fixtureCapturedAt,
          fixtureCapturedAt,
          fixtureCreatedAt,
          fixtureCreatedAt,
          `usr_regression_${runKey}`,
          fixtureDigest,
        ]);
        return client.query(INSERT_FIXTURE_EVENT_SQL, [
          tenantId,
          projectId,
          environmentId,
          fixtureId,
          fixtureVersionId,
          traceId,
          1,
          0,
          eventId,
        ]);
      });

      const fixtureState = await upgradePool.query<{
        readonly created_at_lexical: string;
        readonly evidence_count: number;
        readonly event_count: number;
        readonly source_captured_at_lexical: string;
      }>(
        `
        SELECT
          version.source_captured_at_lexical,
          version.created_at_lexical,
          (
            SELECT count(*)::integer
            FROM public.proofstack_regression_fixture_events AS event
            WHERE event.tenant_id = version.tenant_id
              AND event.fixture_version_id = version.fixture_version_id
          ) AS event_count,
          (
            SELECT count(*)::integer
            FROM public.proofstack_evidence_events
            WHERE tenant_id = version.tenant_id AND event_id = $2
          ) AS evidence_count
        FROM public.proofstack_regression_fixture_versions AS version
        WHERE version.tenant_id = $1 AND version.fixture_version_id = $3
      `,
        [tenantId, eventId, fixtureVersionId],
      );
      expect(fixtureState.rows).toEqual([
        {
          created_at_lexical: fixtureCreatedAt,
          evidence_count: 0,
          event_count: 1,
          source_captured_at_lexical: fixtureCapturedAt,
        },
      ]);

      await asRuntime(upgradePool, runtimeRole, tenantId, async (client) => {
        await client.query(INSERT_DATASET_RESOURCE_SQL, [
          tenantId,
          projectId,
          environmentId,
          datasetId,
          datasetVersionId,
          datasetDigest,
        ]);
        await client.query(INSERT_DATASET_VERSION_SQL, [
          tenantId,
          projectId,
          environmentId,
          datasetId,
          datasetVersionId,
          datasetDigest,
          datasetVersionId,
          "0.1",
          "Checkout regression set",
          null,
          null,
          null,
          1,
          datasetCreatedAt,
          datasetCreatedAt,
          `usr_regression_${runKey}`,
          datasetDigest,
        ]);
        return client.query(INSERT_DATASET_MEMBER_SQL, [
          tenantId,
          projectId,
          environmentId,
          datasetId,
          datasetVersionId,
          1,
          0,
          fixtureId,
          fixtureVersionId,
          fixtureDigest,
        ]);
      });

      const datasetState = await upgradePool.query<{ readonly created_at_lexical: string }>(
        `
          SELECT created_at_lexical
          FROM public.proofstack_regression_dataset_versions
          WHERE tenant_id = $1 AND dataset_version_id = $2
        `,
        [tenantId, datasetVersionId],
      );
      expect(datasetState.rows).toEqual([{ created_at_lexical: datasetCreatedAt }]);

      const rejectedTimestamps = [
        {
          label: "year_zero",
          lexicalTimestamp: "0000-08-29T00:00:00Z",
          typedTimestamp: "2026-08-29T00:00:00Z",
        },
        {
          label: "offset_plus_16",
          lexicalTimestamp: "2026-08-29T16:00:00+16:00",
          typedTimestamp: "2026-08-29T00:00:00Z",
        },
        {
          label: "offset_minus_16",
          lexicalTimestamp: "2026-08-28T08:00:00-16:00",
          typedTimestamp: "2026-08-29T00:00:00Z",
        },
        {
          label: "noncanonical",
          lexicalTimestamp: "2026-08-29 00:00:00Z",
          typedTimestamp: "2026-08-29T00:00:00Z",
        },
        {
          label: "no_offset",
          lexicalTimestamp: "2026-08-29T00:00:00",
          typedTimestamp: "2026-08-29T00:00:00Z",
        },
        {
          label: "infinity",
          lexicalTimestamp: "infinity",
          typedTimestamp: "infinity",
        },
        {
          label: "fraction_too_long",
          lexicalTimestamp: `2026-08-29T00:00:00.${"1".repeat(31)}Z`,
          typedTimestamp: "2026-08-29T00:00:00Z",
        },
        {
          label: "created_offset",
          lexicalTimestamp: "2026-08-29T09:01:00.123+15:59",
          typedTimestamp: "2026-08-29T09:01:00.123+15:59",
        },
        {
          label: "created_fraction",
          lexicalTimestamp: "2026-08-29T09:01:00.123456789012345678901234567890Z",
          typedTimestamp: "2026-08-29T09:01:00.123456789012345678901234567890Z",
        },
      ] as const;

      for (const { label, lexicalTimestamp, typedTimestamp } of rejectedTimestamps) {
        const sourceTypedTimestamp = label.startsWith("created_")
          ? fixtureCapturedAt
          : typedTimestamp;
        const sourceLexicalTimestamp = label.startsWith("created_")
          ? fixtureCapturedAt
          : lexicalTimestamp;
        const rejectedFixtureId = `fix_timestamp_${label}_${runKey}`;
        const rejectedFixtureVersionId = `fiv_timestamp_${label}_${runKey}`;
        const rejectedFixtureDigest = "c".repeat(64);
        await expect(
          asRuntime(upgradePool, runtimeRole, tenantId, async (client) => {
            await client.query(INSERT_FIXTURE_RESOURCE_SQL, [
              tenantId,
              projectId,
              environmentId,
              rejectedFixtureId,
              rejectedFixtureVersionId,
              rejectedFixtureDigest,
            ]);
            await client.query(INSERT_FIXTURE_VERSION_SQL, [
              tenantId,
              projectId,
              environmentId,
              rejectedFixtureId,
              rejectedFixtureVersionId,
              rejectedFixtureDigest,
              rejectedFixtureVersionId,
              "0.1",
              "Rejected fixture timestamp",
              null,
              null,
              null,
              "evidence_only",
              "trace_snapshot",
              traceId,
              1,
              "observed_snapshot",
              sourceTypedTimestamp,
              sourceLexicalTimestamp,
              typedTimestamp,
              lexicalTimestamp,
              `usr_regression_${runKey}`,
              rejectedFixtureDigest,
            ]);
            return client.query(INSERT_FIXTURE_EVENT_SQL, [
              tenantId,
              projectId,
              environmentId,
              rejectedFixtureId,
              rejectedFixtureVersionId,
              traceId,
              1,
              0,
              `evt_timestamp_${label}_${runKey}`,
            ]);
          }),
        ).rejects.toMatchObject({ code: expect.any(String) });

        const rejectedDatasetId = `dts_timestamp_${label}_${runKey}`;
        const rejectedDatasetVersionId = `dsv_timestamp_${label}_${runKey}`;
        const rejectedDatasetDigest = "d".repeat(64);
        await expect(
          asRuntime(upgradePool, runtimeRole, tenantId, async (client) => {
            await client.query(INSERT_DATASET_RESOURCE_SQL, [
              tenantId,
              projectId,
              environmentId,
              rejectedDatasetId,
              rejectedDatasetVersionId,
              rejectedDatasetDigest,
            ]);
            await client.query(INSERT_DATASET_VERSION_SQL, [
              tenantId,
              projectId,
              environmentId,
              rejectedDatasetId,
              rejectedDatasetVersionId,
              rejectedDatasetDigest,
              rejectedDatasetVersionId,
              "0.1",
              "Rejected dataset timestamp",
              null,
              null,
              null,
              1,
              typedTimestamp,
              lexicalTimestamp,
              `usr_regression_${runKey}`,
              rejectedDatasetDigest,
            ]);
            return client.query(INSERT_DATASET_MEMBER_SQL, [
              tenantId,
              projectId,
              environmentId,
              rejectedDatasetId,
              rejectedDatasetVersionId,
              1,
              0,
              fixtureId,
              fixtureVersionId,
              fixtureDigest,
            ]);
          }),
        ).rejects.toMatchObject({ code: expect.any(String) });
      }

      const hiddenFixture = await asRuntime(upgradePool, runtimeRole, otherTenantId, (client) =>
        client.query<{ readonly count: number }>(`
            SELECT count(*)::integer AS count
            FROM public.proofstack_regression_fixture_versions
          `),
      );
      expect(hiddenFixture.rows).toEqual([{ count: 0 }]);

      await expect(
        asRuntime(upgradePool, runtimeRole, otherTenantId, (client) =>
          client.query(INSERT_FIXTURE_RESOURCE_SQL, [
            tenantId,
            projectId,
            environmentId,
            `fix_forged_${runKey}`,
            `fiv_forged_${runKey}`,
            "c".repeat(64),
          ]),
        ),
      ).rejects.toMatchObject({ code: "42501" });

      const incompleteFixtureId = `fix_incomplete_${runKey}`;
      const incompleteFixtureVersionId = `fiv_incomplete_${runKey}`;
      const incompleteFixtureDigest = "c".repeat(64);
      await expect(
        asRuntime(upgradePool, runtimeRole, tenantId, async (client) => {
          await client.query(INSERT_FIXTURE_RESOURCE_SQL, [
            tenantId,
            projectId,
            environmentId,
            incompleteFixtureId,
            incompleteFixtureVersionId,
            incompleteFixtureDigest,
          ]);
          return client.query(INSERT_FIXTURE_VERSION_SQL, [
            tenantId,
            projectId,
            environmentId,
            incompleteFixtureId,
            incompleteFixtureVersionId,
            incompleteFixtureDigest,
            incompleteFixtureVersionId,
            "0.1",
            "Incomplete fixture",
            null,
            null,
            null,
            "evidence_only",
            "trace_snapshot",
            traceId,
            1,
            "observed_snapshot",
            fixtureCapturedAt,
            fixtureCapturedAt,
            fixtureCreatedAt,
            fixtureCreatedAt,
            `usr_regression_${runKey}`,
            incompleteFixtureDigest,
          ]);
        }),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        upgradePool.query<{ readonly count: number }>(
          `SELECT count(*)::integer AS count FROM public.proofstack_regression_fixtures WHERE tenant_id = $1 AND fixture_id = $2`,
          [tenantId, incompleteFixtureId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });

      const incompleteDatasetId = `dts_incomplete_${runKey}`;
      const incompleteDatasetVersionId = `dsv_incomplete_${runKey}`;
      const incompleteDatasetDigest = "d".repeat(64);
      await expect(
        asRuntime(upgradePool, runtimeRole, tenantId, async (client) => {
          await client.query(INSERT_DATASET_RESOURCE_SQL, [
            tenantId,
            projectId,
            environmentId,
            incompleteDatasetId,
            incompleteDatasetVersionId,
            incompleteDatasetDigest,
          ]);
          return client.query(INSERT_DATASET_VERSION_SQL, [
            tenantId,
            projectId,
            environmentId,
            incompleteDatasetId,
            incompleteDatasetVersionId,
            incompleteDatasetDigest,
            incompleteDatasetVersionId,
            "0.1",
            "Incomplete dataset",
            null,
            null,
            null,
            1,
            datasetCreatedAt,
            datasetCreatedAt,
            `usr_regression_${runKey}`,
            incompleteDatasetDigest,
          ]);
        }),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        upgradePool.query<{ readonly count: number }>(
          `SELECT count(*)::integer AS count FROM public.proofstack_regression_datasets WHERE tenant_id = $1 AND dataset_id = $2`,
          [tenantId, incompleteDatasetId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });

      await upgradePool.query(
        `GRANT UPDATE, DELETE ON TABLE ${REGRESSION_TABLES.map((table) => `public.${table}`).join(", ")} TO "${runtimeRole}"`,
      );
      for (const table of REGRESSION_TABLES) {
        const stored = await upgradePool.query<{ readonly count: number }>(
          `SELECT count(*)::integer AS count FROM public.${table} WHERE tenant_id = $1`,
          [tenantId],
        );
        expect(stored.rows[0]?.count).toBeGreaterThan(0);

        const runtimeUpdate = await asRuntime(upgradePool, runtimeRole, tenantId, (client) =>
          client.query(`UPDATE public.${table} SET tenant_id = tenant_id WHERE tenant_id = $1`, [
            tenantId,
          ]),
        );
        expect(runtimeUpdate.rowCount).toBe(0);
        const runtimeDelete = await asRuntime(upgradePool, runtimeRole, tenantId, (client) =>
          client.query(`DELETE FROM public.${table} WHERE tenant_id = $1`, [tenantId]),
        );
        expect(runtimeDelete.rowCount).toBe(0);

        await expect(
          upgradePool.query(
            `UPDATE public.${table} SET tenant_id = tenant_id WHERE tenant_id = $1`,
            [tenantId],
          ),
        ).rejects.toMatchObject({ code: "55000" });
        await expect(
          upgradePool.query(`DELETE FROM public.${table} WHERE tenant_id = $1`, [tenantId]),
        ).rejects.toMatchObject({ code: "55000" });
      }

      await expect(migrateDatabase(upgradePool, targetMigrations)).resolves.toMatchObject({
        newlyAppliedIds: [],
      });
    } finally {
      await upgradePool?.end();
      await controlPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      if (roleCreated) await controlPool.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await controlPool.end();
    }
  });
});
