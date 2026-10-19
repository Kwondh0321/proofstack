import { randomUUID } from "node:crypto";
import { PolicyEvaluationRequestSchema } from "@proofstack/contracts";
import {
  digestPolicyEvaluationRequestDefinition,
  ReleaseDecisionVerificationBudget,
} from "@proofstack/core";
import { releaseDecisionInputRepositoryFixture } from "@proofstack/core/testing";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { assertMigrationsCurrent, migrateDatabase } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";
import { PostgresPolicyEvaluationJobControlRepository } from "./postgres-policy-evaluation-job-control-repository.js";
import { PostgresReleaseDecisionInputRepository } from "./postgres-release-decision-input-repository.js";
import { readPostgresReleaseDecisionReservationsOnClient } from "./postgres-release-decision-reservations.js";

const databaseUrl = process.env["PROOFSTACK_TEST_DATABASE_URL"];
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");

it("preserves original legacy plans and ledger without inventing pre-outcome reservations", async () => {
  const name = `proofstack_reservation_upgrade_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const control = new Pool({ connectionString: databaseUrl, max: 1 });
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  let pool: Pool | undefined;
  let created = false;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    pool = new Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 500 });
    const migrations = await loadBundledMigrations();
    const index = migrations.findIndex(
      (m) => m.id === "0070_release_decision_request_reservations",
    );
    expect(index).toBe(69);
    await migrateDatabase(pool, migrations.slice(0, index));
    const graph = releaseDecisionInputRepositoryFixture("reservation_legacy");
    const inputs = new PostgresReleaseDecisionInputRepository(pool);
    await inputs.publishReleaseDecisionInput(graph);
    const before = (
      await pool.query(
        "SELECT to_jsonb(p) AS plan FROM public.proofstack_release_decision_input_plans p ORDER BY ordinal",
      )
    ).rows;
    const ledger = (
      await pool.query("SELECT id,checksum FROM public.proofstack_schema_migrations ORDER BY id")
    ).rows;
    await expect(migrateDatabase(pool)).resolves.toMatchObject({
      newlyAppliedIds: ["0070_release_decision_request_reservations"],
    });
    await assertMigrationsCurrent(pool);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(p)-ARRAY['reservation_profile','reserved_at_lexical','reserved_at_key'] AS plan FROM public.proofstack_release_decision_input_plans p ORDER BY ordinal",
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await pool.query("SELECT id,checksum FROM public.proofstack_schema_migrations ORDER BY id")
      ).rows.slice(0, -1),
    ).toEqual(ledger);
    expect(
      (
        await pool.query(
          "SELECT reservation_profile,reserved_at_lexical,reserved_at_key FROM public.proofstack_release_decision_input_plans",
        )
      ).rows,
    ).toEqual(
      graph.request.evaluations.map(() => ({
        reservation_profile: null,
        reserved_at_lexical: null,
        reserved_at_key: null,
      })),
    );
    expect(
      await inputs.findReleaseDecisionInput(
        graph.request.scope,
        graph.request.decisionInputRequestId,
      ),
    ).toEqual(graph);
    expect(await inputs.publishReleaseDecisionInput(graph)).toEqual({ created: false, graph });
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(
        "SELECT set_config('proofstack.tenant_id',$1,true),set_config('proofstack.project_id',$2,true),set_config('proofstack.environment_id',$3,true)",
        [
          graph.request.scope.tenantId,
          graph.request.scope.projectId,
          graph.request.scope.environmentId,
        ],
      );
      const observed = await readPostgresReleaseDecisionReservationsOnClient(
        client,
        graph.request.scope,
        {
          decisionInputRequestId: graph.request.decisionInputRequestId,
          definitionSha256: graph.request.definitionSha256,
        },
        new ReleaseDecisionVerificationBudget(graph.request.verificationLimits),
      );
      expect(observed?.state).toBe("legacy_unreserved");
      expect(observed?.graph).toEqual(graph);
      expect(observed?.reservations.map((r) => [r.reservedAt, r.reservedAtKey])).toEqual([
        [null, null],
        [null, null],
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    const planned = graph.request.evaluations[0];
    if (!planned) throw new Error("Missing legacy plan");
    const definition = { ...planned.request, evaluationTime: "2026-10-15T12:00:01.000001Z" };
    const request = PolicyEvaluationRequestSchema.parse({
      ...definition,
      schemaVersion: "0.1",
      scope: graph.request.scope,
      definitionSha256: digestPolicyEvaluationRequestDefinition(graph.request.scope, definition),
      createdAt: new Date().toISOString(),
      createdByPrincipalId: "workload_legacy",
    });
    expect(
      (
        await new PostgresPolicyEvaluationJobControlRepository(pool).createJob({
          request,
          jobId: "job_legacy_unreserved",
        })
      ).created,
    ).toBe(true);
    await expect(migrateDatabase(pool)).resolves.toMatchObject({ newlyAppliedIds: [] });
  } finally {
    await pool?.end();
    try {
      if (created) await control.query(`DROP DATABASE "${name}"`);
    } finally {
      await control.end();
    }
  }
});
