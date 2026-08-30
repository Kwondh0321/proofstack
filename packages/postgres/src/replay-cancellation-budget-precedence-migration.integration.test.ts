import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { assertMigrationsCurrent, migrateDatabase } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const functionSignature =
  "public.proofstack_complete_replay_job(text,text,text,text,text,text,bigint,bigint,text,text,jsonb,jsonb)";

async function completionDefinition(pool: Pool): Promise<string> {
  const result = await pool.query<{ readonly definition: string }>(
    "SELECT pg_get_functiondef($1::regprocedure::oid) AS definition",
    [functionSignature],
  );
  const definition = result.rows[0]?.definition;
  if (!definition) throw new Error("Replay completion function is missing");
  return definition;
}

describe("replay cancellation budget precedence migration", () => {
  it("upgrades the completion guard without rewriting prior migration history", async () => {
    const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
    const databaseName = `proofstack_cancel_budget_${runKey}`;
    const controlPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const upgradeUrl = new URL(databaseUrl);
    upgradeUrl.pathname = `/${databaseName}`;
    let upgradePool: Pool | undefined;

    try {
      await controlPool.query(`CREATE DATABASE "${databaseName}"`);
      upgradePool = new Pool({ connectionString: upgradeUrl.toString(), max: 1 });
      const migrations = await loadBundledMigrations();
      const repairIndex = migrations.findIndex(
        ({ id }) => id === "0033_prioritize_replay_cancellation_over_budget",
      );
      expect(repairIndex).toBeGreaterThan(0);
      const previousMigrations = migrations.slice(0, repairIndex);
      const targetMigrations = migrations.slice(0, repairIndex + 1);
      await migrateDatabase(upgradePool, previousMigrations);

      await expect(completionDefinition(upgradePool)).resolves.toContain(
        "IF expected_status <> 'budget_exhausted' AND EXISTS (",
      );
      await expect(migrateDatabase(upgradePool, targetMigrations)).resolves.toMatchObject({
        newlyAppliedIds: ["0033_prioritize_replay_cancellation_over_budget"],
      });
      await expect(assertMigrationsCurrent(upgradePool, targetMigrations)).resolves.toBeUndefined();

      const repaired = await completionDefinition(upgradePool);
      expect(repaired).toContain(
        "IF NOT cancellation_requested\n    AND expected_status <> 'budget_exhausted'\n    AND EXISTS (",
      );
      expect(repaired).not.toContain("IF expected_status <> 'budget_exhausted' AND EXISTS (");
    } finally {
      await upgradePool?.end();
      await controlPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await controlPool.end();
    }
  });
});
