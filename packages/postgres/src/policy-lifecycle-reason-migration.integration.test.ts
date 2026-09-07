import { randomUUID } from "node:crypto";
import type { ReleasePolicyLifecycleEvent } from "@proofstack/contracts";
import { createReleasePolicyRepositoryTestHarness } from "@proofstack/core/testing";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { assertMigrationsCurrent, migrateDatabase } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";
import { PostgresReleasePolicyRepository } from "./postgres-release-policy-repository.js";
import { withExactScopeTransaction } from "./tenant-transaction.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl)
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");

const repairId = "0049_align_policy_lifecycle_reason_bounds";

async function retainedState(pool: Pool): Promise<unknown[]> {
  const state: unknown[] = [];
  for (const table of [
    "proofstack_release_policy_registry",
    "proofstack_release_policy_resources",
    "proofstack_release_policy_lineage",
    "proofstack_release_policies",
    "proofstack_release_policy_sources",
    "proofstack_release_policy_rules",
    "proofstack_release_policy_rule_sources",
    "proofstack_release_policy_lifecycle_events",
    "proofstack_outbox",
  ]) {
    const result = await pool.query(
      `SELECT to_jsonb(item) AS record FROM public.${table} AS item ORDER BY to_jsonb(item)::text`,
    );
    state.push(result.rows);
  }
  return state;
}

async function rawLifecyclePublication(
  pool: Pool,
  event: ReleasePolicyLifecycleEvent,
): Promise<void> {
  await withExactScopeTransaction(pool, event.scope, async (client) => {
    await client.query("SELECT public.proofstack_publish_release_policy_lifecycle($1::jsonb)", [
      JSON.stringify({
        actorPrincipalId: event.actorPrincipalId,
        environmentId: event.scope.environmentId,
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        projectId: event.scope.projectId,
        record: event,
        schemaVersion: event.schemaVersion,
        tenantId: event.scope.tenantId,
      }),
    ]);
  });
}

describe("policy lifecycle reason bound migration", () => {
  it.each(["withdrawn", "superseded"] as const)(
    "upgrades %s bounds without changing retained history",
    async (kind) => {
      const databaseName = `proofstack_policy_reason_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const controlPool = new Pool({ connectionString: databaseUrl, max: 1 });
      const upgradeUrl = new URL(databaseUrl);
      upgradeUrl.pathname = `/${databaseName}`;
      let upgradePool: Pool | undefined;
      let created = false;
      try {
        await controlPool.query(`CREATE DATABASE "${databaseName}"`);
        created = true;
        upgradePool = new Pool({ connectionString: upgradeUrl.toString(), max: 1 });
        const migrations = await loadBundledMigrations();
        const index = migrations.findIndex(({ id }) => id === repairId);
        expect(index).toBeGreaterThan(0);
        const previous = migrations.slice(0, index);
        const repaired = migrations.slice(0, index + 1);
        await migrateDatabase(upgradePool, previous);
        const repository = new PostgresReleasePolicyRepository(upgradePool);
        const history = createReleasePolicyRepositoryTestHarness("reason_history");
        const historicalEvent = { ...history.withdrawal, reason: "가".repeat(2048) };
        await repository.publishReleasePolicy(history.policy);
        await repository.publishReleasePolicyLifecycleEvent(historicalEvent);

        const fixture = createReleasePolicyRepositoryTestHarness("reason_upgrade");
        await repository.publishReleasePolicy(fixture.policy);
        await repository.publishReleasePolicy(fixture.successor);
        const event = {
          ...(kind === "withdrawn" ? fixture.withdrawal : fixture.supersession),
          reason: "😀".repeat(2049),
        };
        const before = await retainedState(upgradePool);
        await expect(repository.publishReleasePolicyLifecycleEvent(event)).rejects.toMatchObject({
          code: "release_policy_repository_contract_violation",
          cause: { code: "23514", constraint: "proofstack_release_policy_lifecycle_events_values" },
        });
        expect(await retainedState(upgradePool)).toEqual(before);
        const ledger = await upgradePool.query(
          "SELECT id, checksum FROM public.proofstack_schema_migrations ORDER BY id",
        );

        await expect(migrateDatabase(upgradePool, repaired)).resolves.toMatchObject({
          newlyAppliedIds: [repairId],
        });
        await expect(assertMigrationsCurrent(upgradePool, repaired)).resolves.toBeUndefined();
        expect(await retainedState(upgradePool)).toEqual(before);
        const nextLedger = await upgradePool.query(
          "SELECT id, checksum FROM public.proofstack_schema_migrations ORDER BY id",
        );
        expect(nextLedger.rows.slice(0, -1)).toEqual(ledger.rows);
        expect(nextLedger.rows.at(-1)).toMatchObject({ id: repairId });
        await expect(migrateDatabase(upgradePool, repaired)).resolves.toMatchObject({
          newlyAppliedIds: [],
        });

        // Bypass the application's parser: PostgreSQL itself must still reject both outer bounds.
        for (const length of [0, 4097]) {
          await expect(
            rawLifecyclePublication(upgradePool, { ...event, reason: "😀".repeat(length) }),
          ).rejects.toMatchObject({
            code: "23514",
            constraint: "proofstack_release_policy_lifecycle_events_values",
          });
          expect(await retainedState(upgradePool)).toEqual(before);
        }
        const maximum = { ...event, reason: "😀".repeat(4096) };
        await expect(repository.publishReleasePolicyLifecycleEvent(maximum)).resolves.toEqual({
          created: true,
          event: maximum,
        });
        await expect(repository.publishReleasePolicyLifecycleEvent(maximum)).resolves.toEqual({
          created: false,
          event: maximum,
        });
        await expect(
          repository.findReleasePolicyLifecycleEvent(fixture.scope, maximum.eventId),
        ).resolves.toEqual(maximum);
        await expect(
          repository.findReleasePolicyLifecycleEvent(history.scope, historicalEvent.eventId),
        ).resolves.toEqual(historicalEvent);
        await expect(
          repository.publishReleasePolicyLifecycleEvent(historicalEvent),
        ).resolves.toEqual({ created: false, event: historicalEvent });
      } finally {
        await upgradePool?.end();
        try {
          if (created) await controlPool.query(`DROP DATABASE "${databaseName}"`);
        } finally {
          await controlPool.end();
        }
      }
    },
  );
});
