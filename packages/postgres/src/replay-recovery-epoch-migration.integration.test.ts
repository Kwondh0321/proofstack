import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { assertMigrationsCurrent, migrateDatabase } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

describe("replay recovery epoch migration", () => {
  it("preserves wrapper grants while removing every pre-epoch authority", async () => {
    const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
    const databaseName = `proofstack_recovery_epoch_${runKey}`;
    const apiRole = `ps_epoch_api_${runKey}`;
    const workerRole = `ps_epoch_worker_${runKey}`;
    const controlPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const upgradeUrl = new URL(databaseUrl);
    upgradeUrl.pathname = `/${databaseName}`;
    let upgradePool: Pool | undefined;

    try {
      await controlPool.query(`CREATE ROLE "${apiRole}"`);
      await controlPool.query(`CREATE ROLE "${workerRole}"`);
      await controlPool.query(`CREATE DATABASE "${databaseName}"`);
      upgradePool = new Pool({ connectionString: upgradeUrl.toString(), max: 1 });
      const migrations = await loadBundledMigrations();
      const recoveryIndex = migrations.findIndex(
        ({ id }) => id === "0035_invalidate_restored_replay_leases",
      );
      expect(recoveryIndex).toBeGreaterThan(0);
      const previousMigrations = migrations.slice(0, recoveryIndex);
      const targetMigrations = migrations.slice(0, recoveryIndex + 1);
      await migrateDatabase(upgradePool, previousMigrations);
      await upgradePool.query(`
        GRANT EXECUTE ON FUNCTION public.proofstack_create_replay_job(
          text, text, text, text, text, text, text
        ) TO "${apiRole}";
        GRANT EXECUTE ON FUNCTION public.proofstack_claim_replay_job(
          text, text, text, text, text, text, text, text, text, bigint
        ) TO "${workerRole}";
      `);

      await expect(migrateDatabase(upgradePool, targetMigrations)).resolves.toMatchObject({
        newlyAppliedIds: ["0035_invalidate_restored_replay_leases"],
      });
      await expect(assertMigrationsCurrent(upgradePool, targetMigrations)).resolves.toBeUndefined();

      const privileges = await upgradePool.query<{
        readonly api_legacy_create: boolean;
        readonly api_wrapper_create: boolean;
        readonly worker_begin_recovery: boolean;
        readonly worker_legacy_claim: boolean;
        readonly worker_recovery_events_select: boolean;
        readonly worker_recovery_state_select: boolean;
        readonly worker_wrapper_claim: boolean;
      }>(
        `SELECT
          has_function_privilege(
            $1,
            'proofstack_create_replay_job(text,text,text,text,text,text,text)',
            'EXECUTE'
          ) AS api_wrapper_create,
          has_function_privilege(
            $1,
            'proofstack_create_replay_job_before_recovery_epoch(text,text,text,text,text,text,text)',
            'EXECUTE'
          ) AS api_legacy_create,
          has_function_privilege(
            $2,
            'proofstack_claim_replay_job(text,text,text,text,text,text,text,text,text,bigint)',
            'EXECUTE'
          ) AS worker_wrapper_claim,
          has_function_privilege(
            $2,
            'proofstack_claim_replay_job_before_recovery_epoch(text,text,text,text,text,text,text,text,text,bigint)',
            'EXECUTE'
          ) AS worker_legacy_claim,
          has_function_privilege(
            $2,
            'proofstack_begin_replay_recovery()',
            'EXECUTE'
          ) AS worker_begin_recovery,
          has_table_privilege($2, 'proofstack_recovery_state', 'SELECT')
            AS worker_recovery_state_select,
          has_table_privilege($2, 'proofstack_replay_recovery_events', 'SELECT')
            AS worker_recovery_events_select`,
        [apiRole, workerRole],
      );
      expect(privileges.rows).toEqual([
        {
          api_legacy_create: false,
          api_wrapper_create: true,
          worker_begin_recovery: false,
          worker_legacy_claim: false,
          worker_recovery_events_select: false,
          worker_recovery_state_select: false,
          worker_wrapper_claim: true,
        },
      ]);

      await expect(
        upgradePool.query("SELECT * FROM public.proofstack_begin_replay_recovery()"),
      ).resolves.toMatchObject({
        rows: [
          {
            next_recovery_epoch: "1",
            queued_job_count: "0",
            running_job_count: "0",
            source_recovery_epoch: "0",
          },
        ],
      });
    } finally {
      if (upgradePool) {
        await upgradePool.query(`DROP OWNED BY "${apiRole}"`);
        await upgradePool.query(`DROP OWNED BY "${workerRole}"`);
        await upgradePool.end();
      }
      await controlPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await controlPool.query(`DROP ROLE IF EXISTS "${apiRole}"`);
      await controlPool.query(`DROP ROLE IF EXISTS "${workerRole}"`);
      await controlPool.end();
    }
  });
});
