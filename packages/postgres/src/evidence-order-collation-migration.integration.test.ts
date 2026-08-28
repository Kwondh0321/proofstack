import { EVIDENCE_SCHEMA_VERSION, type EvidenceRecord } from "@proofstack/contracts";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  assertMigrationsCurrent,
  migrateDatabase,
  MigrationIntegrityError,
} from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

async function traceOrderIndexState(pool: Pool): Promise<{
  readonly collationName: string;
  readonly collationSchema: string;
  readonly ready: boolean;
  readonly valid: boolean;
}> {
  const result = await pool.query<{
    readonly collation_name: string;
    readonly collation_schema: string;
    readonly ready: boolean;
    readonly valid: boolean;
  }>(`
    SELECT
      collation.collname AS collation_name,
      collation_namespace.nspname AS collation_schema,
      index_metadata.indisready AS ready,
      index_metadata.indisvalid AS valid
    FROM pg_index AS index_metadata
    CROSS JOIN LATERAL
      unnest(index_metadata.indcollation::oid[]) WITH ORDINALITY
        AS index_key(collation_oid, key_position)
    JOIN pg_collation AS collation
      ON collation.oid = index_key.collation_oid
    JOIN pg_namespace AS collation_namespace
      ON collation_namespace.oid = collation.collnamespace
    WHERE index_metadata.indexrelid =
      'public.proofstack_evidence_trace_order_idx'::regclass
      AND index_key.key_position = 7
  `);
  const row = result.rows[0];
  if (!row) throw new Error("trace order index is missing");
  return {
    collationName: row.collation_name,
    collationSchema: row.collation_schema,
    ready: row.ready,
    valid: row.valid,
  };
}

describe("evidence event order collation migration", () => {
  it("upgrades 0011 data and installs a valid bytewise trace index", async () => {
    const databaseName = `proofstack_collation_${process.pid}_${Date.now()}`;
    const controlPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const upgradeUrl = new URL(databaseUrl);
    upgradeUrl.pathname = `/${databaseName}`;
    let upgradePool: Pool | undefined;

    try {
      await controlPool.query(`CREATE DATABASE ${databaseName}`);
      upgradePool = new Pool({ connectionString: upgradeUrl.toString(), max: 1 });
      const migrations = await loadBundledMigrations();
      const migrationIndex = migrations.findIndex(
        ({ id }) => id === "0012_pin_evidence_event_collation",
      );
      expect(migrationIndex).toBeGreaterThan(0);
      const previousMigrations = migrations.slice(0, migrationIndex);
      const targetMigrations = migrations.slice(0, migrationIndex + 1);
      await migrateDatabase(upgradePool, previousMigrations);

      const record: EvidenceRecord = {
        attributes: {},
        contentReferences: [],
        eventId: "evt_collation_upgrade",
        extensions: {},
        kind: "agent.run",
        name: "collation-upgrade",
        source: {
          sdkName: "@proofstack/testkit",
          sdkVersion: "0.0.0",
          serviceName: "collation-upgrade",
        },
        spanId: "00f067aa0ba902b7",
        startedAt: "2026-08-28T02:59:59.000Z",
        status: "ok",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      };
      await upgradePool.query(
        `
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
          ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, 0, $8, $9, $10::jsonb)
        `,
        [
          "ten_collation_upgrade",
          "prj_collation_upgrade",
          "env_collation_upgrade",
          record.eventId,
          record.traceId,
          record.spanId,
          record.startedAt,
          "2026-08-28T03:00:00.000Z",
          EVIDENCE_SCHEMA_VERSION,
          JSON.stringify(record),
        ],
      );
      expect((await traceOrderIndexState(upgradePool)).valid).toBe(true);

      const upgraded = await migrateDatabase(upgradePool, targetMigrations);
      expect(upgraded.newlyAppliedIds).toEqual(["0012_pin_evidence_event_collation"]);
      expect(await traceOrderIndexState(upgradePool)).toEqual({
        collationName: "C",
        collationSchema: "pg_catalog",
        ready: true,
        valid: true,
      });
      await expect(
        upgradePool.query<{ readonly count: number }>(`
          SELECT count(*)::integer AS count
          FROM public.proofstack_evidence_events
          WHERE event_id = 'evt_collation_upgrade'
        `),
      ).resolves.toMatchObject({ rows: [{ count: 1 }] });
      await expect(migrateDatabase(upgradePool, targetMigrations)).resolves.toMatchObject({
        newlyAppliedIds: [],
      });
      await expect(assertMigrationsCurrent(upgradePool, targetMigrations)).resolves.toBeUndefined();
      await expect(assertMigrationsCurrent(upgradePool, previousMigrations)).rejects.toBeInstanceOf(
        MigrationIntegrityError,
      );
    } finally {
      await upgradePool?.end();
      await controlPool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await controlPool.end();
    }
  });
});
