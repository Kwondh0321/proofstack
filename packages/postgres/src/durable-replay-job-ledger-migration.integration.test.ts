import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });

const replayJobTables = [
  "proofstack_replay_attempt_events",
  "proofstack_replay_attempts",
  "proofstack_replay_budget_entries",
  "proofstack_replay_budget_entry_dimensions",
  "proofstack_replay_cancellation_acknowledgements",
  "proofstack_replay_cancellation_requests",
  "proofstack_replay_jobs",
  "proofstack_replay_observations",
  "proofstack_replay_usage_measurements",
] as const;

beforeAll(async () => {
  await migrateDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("durable replay job ledger migration", () => {
  it("forces tenant RLS and leaves no public table privileges", async () => {
    const security = await pool.query<{
      readonly relforcerowsecurity: boolean;
      readonly relname: string;
      readonly relrowsecurity: boolean;
    }>(
      `SELECT relation.relname, relation.relrowsecurity, relation.relforcerowsecurity
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = ANY($1::text[])
       ORDER BY relation.relname`,
      [replayJobTables],
    );
    expect(security.rows).toEqual(
      replayJobTables.map((relname) => ({
        relforcerowsecurity: true,
        relname,
        relrowsecurity: true,
      })),
    );

    const publicPrivileges = await pool.query<{ readonly count: number }>(
      `SELECT count(*)::integer AS count
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL aclexplode(
         COALESCE(relation.relacl, acldefault('r', relation.relowner))
       ) AS privilege
       WHERE namespace.nspname = 'public'
         AND relation.relname = ANY($1::text[])
         AND privilege.grantee = 0`,
      [replayJobTables],
    );
    expect(publicPrivileges.rows).toEqual([{ count: 0 }]);

    const policies = await pool.query<{ readonly count: number }>(
      `SELECT count(*)::integer AS count
       FROM pg_policy AS policy
       JOIN pg_class AS relation ON relation.oid = policy.polrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = ANY($1::text[])`,
      [replayJobTables],
    );
    expect(policies.rows).toEqual([{ count: 19 }]);
  });

  it("guards mutable roots, audits attempt closure, and keeps histories append-only", async () => {
    await expect(
      pool.query("INSERT INTO public.proofstack_replay_jobs (tenant_id) VALUES ('ten_guard')"),
    ).rejects.toMatchObject({ code: "42501" });

    const triggers = await pool.query<{ readonly tgname: string }>(
      `SELECT trigger.tgname
       FROM pg_trigger AS trigger
       JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = ANY($1::text[])
         AND NOT trigger.tgisinternal
       ORDER BY trigger.tgname`,
      [replayJobTables],
    );
    expect(triggers.rows.map(({ tgname }) => tgname)).toEqual([
      "proofstack_replay_attempt_events_append_only",
      "proofstack_replay_attempts_history",
      "proofstack_replay_attempts_transition_guard",
      "proofstack_replay_budget_entries_append_only",
      "proofstack_replay_budget_entries_dimensions_complete",
      "proofstack_replay_budget_entry_dimensions_append_only",
      "proofstack_replay_cancellation_acknowledgements_append_only",
      "proofstack_replay_cancellation_requests_append_only",
      "proofstack_replay_jobs_root_guard",
      "proofstack_replay_observations_append_only",
      "proofstack_replay_observations_measurements_complete",
      "proofstack_replay_usage_measurements_append_only",
    ]);
  });

  it("keeps internal guards and control-plane functions private", async () => {
    const publicFunctionPrivileges = await pool.query<{ readonly count: number }>(`
      SELECT count(*)::integer AS count
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
      ) AS privilege
      WHERE namespace.nspname = 'public'
        AND procedure.proname IN (
          'proofstack_acknowledge_replay_cancellation',
          'proofstack_append_replay_execution_observation',
          'proofstack_append_replay_usage_observation',
          'proofstack_create_replay_job',
          'proofstack_complete_replay_job',
          'proofstack_guard_replay_attempt_transition',
          'proofstack_guard_replay_job_root_mutation',
          'proofstack_record_replay_attempt_event',
          'proofstack_reconcile_replay_budget',
          'proofstack_replay_job_intent_status',
          'proofstack_request_replay_cancellation',
          'proofstack_reserve_replay_budget',
          'proofstack_verify_replay_budget_entry_dimensions',
          'proofstack_verify_replay_usage_measurements'
        )
        AND privilege.grantee = 0
    `);
    expect(publicFunctionPrivileges.rows).toEqual([{ count: 0 }]);

    const functionSecurity = await pool.query<{
      readonly proconfig: string[];
      readonly proname: string;
      readonly prosecdef: boolean;
    }>(`
      SELECT procedure.proname, procedure.prosecdef, procedure.proconfig
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname IN (
          'proofstack_create_replay_job',
          'proofstack_replay_job_intent_status',
          'proofstack_request_replay_cancellation'
        )
      ORDER BY procedure.proname
    `);
    expect(functionSecurity.rows).toEqual([
      {
        proconfig: ["search_path=pg_catalog"],
        proname: "proofstack_create_replay_job",
        prosecdef: true,
      },
      {
        proconfig: ["search_path=pg_catalog"],
        proname: "proofstack_replay_job_intent_status",
        prosecdef: true,
      },
      {
        proconfig: ["search_path=pg_catalog"],
        proname: "proofstack_request_replay_cancellation",
        prosecdef: true,
      },
    ]);

    const completeness = await pool.query<{
      readonly condeferrable: boolean;
      readonly condeferred: boolean;
      readonly conname: string;
    }>(`
      SELECT conname, condeferrable, condeferred
      FROM pg_constraint
      WHERE conname IN (
        'proofstack_replay_budget_entries_dimensions_complete',
        'proofstack_replay_observations_measurements_complete'
      )
      ORDER BY conname
    `);
    expect(completeness.rows).toEqual([
      {
        condeferrable: true,
        condeferred: true,
        conname: "proofstack_replay_budget_entries_dimensions_complete",
      },
      {
        condeferrable: true,
        condeferred: true,
        conname: "proofstack_replay_observations_measurements_complete",
      },
    ]);
  });

  it("accepts every measurement declared by the public replay budget contract", async () => {
    const constraint = await pool.query<{ readonly definition: string }>(`
      SELECT pg_get_constraintdef(constraint_metadata.oid) AS definition
      FROM pg_constraint AS constraint_metadata
      JOIN pg_class AS relation ON relation.oid = constraint_metadata.conrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'proofstack_replay_budget_entry_dimensions'
        AND constraint_metadata.conname = 'proofstack_replay_budget_entry_dimensions_shape'
    `);

    expect(constraint.rows).toHaveLength(1);
    for (const measurement of ["estimated", "measured", "provider_reported", "unavailable"]) {
      expect(constraint.rows[0]?.definition).toContain(`'${measurement}'::character varying`);
    }
  });

  it("accepts every boundary kind declared by the public budget work contract", async () => {
    const constraint = await pool.query<{ readonly definition: string }>(`
      SELECT pg_get_constraintdef(constraint_metadata.oid) AS definition
      FROM pg_constraint AS constraint_metadata
      JOIN pg_class AS relation ON relation.oid = constraint_metadata.conrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'proofstack_replay_budget_entries'
        AND constraint_metadata.conname = 'proofstack_replay_budget_entries_work'
    `);

    expect(constraint.rows).toHaveLength(1);
    for (const boundaryKind of ["data", "model", "retrieval", "tool"]) {
      expect(constraint.rows[0]?.definition).toContain(`'${boundaryKind}'::character varying`);
    }
  });
});
