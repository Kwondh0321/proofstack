import { randomUUID } from "node:crypto";
import { releasePolicySelectionRepositoryFixture } from "@proofstack/core/testing";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { migrateDatabase, assertMigrationsCurrent } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";
import { PostgresReleasePolicySelectionRepository } from "./postgres-release-policy-selection-repository.js";

const databaseUrl = process.env["PROOFSTACK_TEST_DATABASE_URL"];
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
it("upgrades retained selections and terminal histories without fabricating authenticated origins", async () => {
  const name = `proofstack_installer_upgrade_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const control = new Pool({ connectionString: databaseUrl, max: 1 });
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  let pool: Pool | undefined,
    created = false;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    pool = new Pool({ connectionString: url.toString(), max: 2 });
    const migrations = await loadBundledMigrations();
    const index = migrations.findIndex(
      (item) => item.id === "0071_authenticated_release_selection_publication",
    );
    expect(index).toBe(70);
    await migrateDatabase(pool, migrations.slice(0, index));
    const fixture = releasePolicySelectionRepositoryFixture("legacy_installer_upgrade"),
      repository = new PostgresReleasePolicySelectionRepository(pool);
    await repository.publishReleasePolicySelection(fixture.original);
    await repository.publishReleasePolicySelection(fixture.successor);
    await repository.publishReleasePolicySelectionLifecycleEvent(fixture.supersession);
    const upgradedPool = pool;
    const read = async () =>
      (
        await upgradedPool.query(
          "SELECT record,canonical_utf8 FROM public.proofstack_release_policy_selections ORDER BY version_id",
        )
      ).rows;
    const records = await read(),
      history = (
        await pool.query(
          "SELECT to_jsonb(e) AS record FROM public.proofstack_release_selection_lifecycle e ORDER BY event_id",
        )
      ).rows;
    const ledger = (
      await pool.query("SELECT id,checksum FROM public.proofstack_schema_migrations ORDER BY id")
    ).rows;
    await expect(migrateDatabase(pool)).resolves.toMatchObject({
      newlyAppliedIds: migrations.slice(index).map((item) => item.id),
    });
    await assertMigrationsCurrent(pool);
    expect(await read()).toEqual(records);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(e) AS record FROM public.proofstack_release_selection_lifecycle e ORDER BY event_id",
        )
      ).rows,
    ).toEqual(history);
    expect(
      (
        await pool.query("SELECT id,checksum FROM public.proofstack_schema_migrations ORDER BY id")
      ).rows.slice(0, ledger.length),
    ).toEqual(ledger);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM public.proofstack_release_selection_publications",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      await repository.findReleasePolicySelection(
        fixture.scope,
        fixture.original.selectionVersionId,
      ),
    ).toEqual(fixture.original);
    expect(
      await repository.findReleasePolicySelectionLifecycleEvent(
        fixture.scope,
        fixture.supersession.eventId,
      ),
    ).toEqual(fixture.supersession);
    await expect(migrateDatabase(pool)).resolves.toMatchObject({ newlyAppliedIds: [] });
  } finally {
    await pool?.end();
    if (created) await control.query(`DROP DATABASE "${name}"`);
    await control.end();
  }
});
