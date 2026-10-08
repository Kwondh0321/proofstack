import { randomUUID } from "node:crypto";
import {
  CreateModelAssuranceAssessment,
  ModelAssuranceRepositoryContractError,
  modelAssuranceRecordId,
} from "@proofstack/core";
import {
  createModelAssuranceRepositoryTestHarness,
  FixedClock,
  publishEvaluationFixture,
} from "@proofstack/core/testing";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { assertMigrationsCurrent, migrateDatabase } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";
import { PostgresEvaluationRepository } from "./postgres-evaluation-repository.js";
import { PostgresModelAssuranceRepository } from "./postgres-model-assurance-repository.js";
import { withExactScopeTransaction } from "./tenant-transaction.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const migrationId = "0053_model_assurance_scalar_integrity";

async function isolatedDatabase(run: (pool: Pool) => Promise<void>) {
  const name = `proofstack_model_scalar_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const control = new Pool({ connectionString: databaseUrl, max: 1 });
  const url = new URL(databaseUrl as string);
  url.pathname = `/${name}`;
  let pool: Pool | undefined;
  let created = false;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    pool = new Pool({ connectionString: url.toString(), max: 2 });
    await run(pool);
  } finally {
    await pool?.end();
    try {
      if (created) await control.query(`DROP DATABASE "${name}"`);
    } finally {
      await control.end();
    }
  }
}

async function retainedState(pool: Pool) {
  const state: unknown[] = [];
  for (const table of [
    "proofstack_evaluation_record_registry",
    "proofstack_evaluation_lineage",
    "proofstack_model_assurance_records",
    "proofstack_outbox",
    "proofstack_schema_migrations",
  ]) {
    state.push(
      (
        await pool.query(
          `SELECT to_jsonb(item) AS record FROM public.${table} AS item ORDER BY to_jsonb(item)::text`,
        )
      ).rows,
    );
  }
  return state;
}

async function publicationPrivileges(pool: Pool) {
  return (
    await pool.query(
      `SELECT proname, proacl::text, prosecdef, proconfig FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'proofstack_%'
     ORDER BY proname, oid`,
    )
  ).rows;
}

describe("model-assurance scalar integrity migration", () => {
  it("preserves all 13 valid legacy kinds, original receipts, graph, outbox and privileges", async () => {
    await isolatedDatabase(async (pool) => {
      const migrations = await loadBundledMigrations();
      const index = migrations.findIndex(({ id }) => id === migrationId);
      expect(index).toBeGreaterThan(0);
      const repaired = migrations.slice(0, index + 1);
      await migrateDatabase(pool, migrations.slice(0, index));
      const h = await createModelAssuranceRepositoryTestHarness("model_scalar_upgrade");
      const evaluations = new PostgresEvaluationRepository(pool);
      const models = new PostgresModelAssuranceRepository(pool);
      for (const f of h.evaluation.records) await publishEvaluationFixture(evaluations, f);
      for (const f of h.records) await models.publish(f.kind, f.record);
      const assessment = await new CreateModelAssuranceAssessment({
        clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
        evaluationRepository: evaluations,
        modelAssuranceRepository: models,
      }).execute(h.command);
      const records = [
        ...h.records,
        { kind: "model_assurance_assessment" as const, record: assessment.record },
      ];
      expect(new Set(records.map(({ kind }) => kind)).size).toBe(13);
      const before = await retainedState(pool);
      const privileges = await publicationPrivileges(pool);
      await expect(migrateDatabase(pool, repaired)).resolves.toMatchObject({
        newlyAppliedIds: [migrationId],
      });
      const after = await retainedState(pool);
      expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
      const ledger = after.at(-1) as unknown[];
      expect(ledger.slice(0, -1)).toEqual(before.at(-1));
      expect(await publicationPrivileges(pool)).toEqual(privileges);
      await assertMigrationsCurrent(pool, repaired);
      await expect(migrateDatabase(pool, repaired)).resolves.toMatchObject({ newlyAppliedIds: [] });
      for (const { kind, record } of records) {
        await expect(
          models.find(record.scope, kind, modelAssuranceRecordId(kind, record)),
        ).resolves.toEqual(record);
      }
      const constraints = await pool.query(
        `SELECT count(*)::int AS count, bool_and(convalidated) AS all_validated
         FROM pg_constraint WHERE conname = 'proofstack_model_assurance_records_scalar_integrity'`,
      );
      expect(constraints.rows).toEqual([{ count: 14, all_validated: true }]);
    });
  });

  it("rejects inconsistent legacy actor data without rewriting it or advancing the ledger", async () => {
    await isolatedDatabase(async (pool) => {
      const migrations = await loadBundledMigrations();
      const index = migrations.findIndex(({ id }) => id === migrationId);
      expect(index).toBeGreaterThan(0);
      const previous = migrations.slice(0, index);
      await migrateDatabase(pool, previous);
      const h = await createModelAssuranceRepositoryTestHarness("model_scalar_invalid");
      const f = h.records.find(({ kind }) => kind === "model_evaluator_profile");
      if (f?.kind !== "model_evaluator_profile") throw new Error("Missing legacy profile");
      const id = modelAssuranceRecordId(f.kind, f.record);
      await withExactScopeTransaction(pool, f.record.scope, async (client) => {
        // Legacy owning publication function; no admin UPDATE or disabled trigger/constraint.
        await client.query(
          "SELECT public.proofstack_publish_model_assurance_control_record($1::jsonb)",
          [
            JSON.stringify({
              actorPrincipalId: null,
              definitionSha256: f.record.definitionSha256,
              environmentId: f.record.scope.environmentId,
              lifecycleState: null,
              projectId: f.record.scope.projectId,
              record: f.record,
              recordedAt: f.record.publishedAt,
              recordId: id,
              recordKind: f.kind,
              schemaVersion: f.record.schemaVersion,
              tenantId: f.record.scope.tenantId,
            }),
          ],
        );
      });
      const models = new PostgresModelAssuranceRepository(pool);
      await expect(models.find(f.record.scope, f.kind, id)).rejects.toBeInstanceOf(
        ModelAssuranceRepositoryContractError,
      );
      for (const outside of [
        { ...f.record.scope, projectId: "prj_other" },
        { ...f.record.scope, environmentId: "env_other" },
      ])
        await expect(models.find(outside, f.kind, id)).resolves.toBeNull();
      const before = await retainedState(pool);
      const privileges = await publicationPrivileges(pool);
      await expect(migrateDatabase(pool, migrations.slice(0, index + 1))).rejects.toMatchObject({
        code: "23514",
        constraint: "proofstack_model_assurance_records_scalar_integrity",
      });
      expect(await retainedState(pool)).toEqual(before);
      expect(await publicationPrivileges(pool)).toEqual(privileges);
      await assertMigrationsCurrent(pool, previous);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM pg_constraint WHERE conname = 'proofstack_model_assurance_records_scalar_integrity'",
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    });
  });
});
