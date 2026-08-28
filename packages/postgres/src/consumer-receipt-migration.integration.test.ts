import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { assertMigrationsCurrent, migrateDatabase } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

describe("leased consumer receipt migration", () => {
  it("preserves receipts completed before lease state existed", async () => {
    const databaseName = `proofstack_upgrade_${Date.now()}`;
    const controlPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const upgradeUrl = new URL(databaseUrl);
    upgradeUrl.pathname = `/${databaseName}`;
    let upgradePool: Pool | undefined;

    try {
      await controlPool.query(`CREATE DATABASE ${databaseName}`);
      upgradePool = new Pool({ connectionString: upgradeUrl.toString(), max: 1 });
      const migrations = await loadBundledMigrations();
      await migrateDatabase(upgradePool, migrations.slice(0, 2));
      await upgradePool.query(`
        INSERT INTO public.proofstack_consumer_receipts (
          tenant_id,
          consumer_name,
          message_id,
          payload_sha256
        ) VALUES (
          'ten_upgrade',
          'trace.projector',
          'message-before-leases',
          '${"b".repeat(64)}'
        )
      `);

      await migrateDatabase(upgradePool, migrations);
      await expect(assertMigrationsCurrent(upgradePool, migrations)).resolves.toBeUndefined();
      const result = await upgradePool.query<{
        readonly attempt_count: number;
        readonly available_matches_completion: boolean;
        readonly completed_at: Date | null;
        readonly created_matches_completion: boolean;
        readonly lease_token: string | null;
        readonly state: string;
      }>(`
        SELECT
          state,
          attempt_count,
          lease_token::text,
          completed_at,
          created_at = completed_at AS created_matches_completion,
          available_at = completed_at AS available_matches_completion
        FROM public.proofstack_consumer_receipts
        WHERE tenant_id = 'ten_upgrade'
      `);
      expect(result.rows).toEqual([
        {
          attempt_count: 1,
          available_matches_completion: true,
          completed_at: expect.any(Date),
          created_matches_completion: true,
          lease_token: null,
          state: "completed",
        },
      ]);
    } finally {
      await upgradePool?.end();
      await controlPool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await controlPool.end();
    }
  });
});
