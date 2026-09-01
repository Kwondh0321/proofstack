import { randomUUID } from "node:crypto";
import type { EvidenceEnvelope } from "@proofstack/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresEvidenceRepository } from "./postgres-evidence-repository.js";
import { provisionRuntimeRoles, type RuntimeRoleProvisioningOptions } from "./runtime-roles.js";
import { withTenantTransaction } from "./tenant-transaction.js";

function requiredDatabaseUrl(): string {
  const { PROOFSTACK_TEST_DATABASE_URL: value } = process.env;
  if (value === undefined || value.length === 0) {
    throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for tenant isolation tests");
  }
  return value;
}

const databaseUrl = requiredDatabaseUrl();
const runKey = randomUUID().replaceAll("-", "").slice(0, 16);
const alphaTenant = `ten_matrix_alpha_${runKey}`;
const betaTenant = `ten_matrix_beta_${runKey}`;
const projectId = `prj_matrix_${runKey}`;
const environmentId = `env_matrix_${runKey}`;
const alphaTraceId = "1bf92f3577b34da6a3ce929d0e0e4736";
const betaTraceId = "2bf92f3577b34da6a3ce929d0e0e4736";
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const runtimePools: Pool[] = [];

const roles = {
  api: {
    name: `ps_matrix_api_${runKey}`,
    password: `proofstack-matrix-api-${runKey}`,
  },
  artifact: {
    name: `ps_matrix_artifact_${runKey}`,
    password: `proofstack-matrix-artifact-${runKey}`,
  },
  consumer: {
    name: `ps_matrix_consumer_${runKey}`,
    password: `proofstack-matrix-consumer-${runKey}`,
  },
  evaluationWorker: {
    name: `ps_matrix_evaluation_${runKey}`,
    password: `proofstack-matrix-evaluation-${runKey}`,
  },
  humanReviewer: {
    name: `ps_matrix_human_${runKey}`,
    password: `proofstack-matrix-human-${runKey}`,
  },
  identity: {
    name: `ps_matrix_identity_${runKey}`,
    password: `proofstack-matrix-identity-${runKey}`,
  },
  modelEvaluationWorker: {
    name: `ps_matrix_model_${runKey}`,
    password: `proofstack-matrix-model-${runKey}`,
  },
  publisher: {
    name: `ps_matrix_publisher_${runKey}`,
    password: `proofstack-matrix-publisher-${runKey}`,
  },
  replayWorker: {
    name: `ps_matrix_worker_${runKey}`,
    password: `proofstack-matrix-replay-worker-${runKey}`,
  },
} satisfies RuntimeRoleProvisioningOptions;

const TENANT_TABLES = [
  "proofstack_api_key_credentials",
  "proofstack_artifact_catalog",
  "proofstack_artifact_purge_receipts",
  "proofstack_artifact_tombstones",
  "proofstack_browser_sessions",
  "proofstack_consumer_receipts",
  "proofstack_evaluation_aggregates",
  "proofstack_evaluation_aggregation_policies",
  "proofstack_evaluation_assessments",
  "proofstack_evaluation_criterion_set_statuses",
  "proofstack_evaluation_criterion_sets",
  "proofstack_evaluation_discovery_records",
  "proofstack_evaluation_evaluator_specs",
  "proofstack_evaluation_lineage",
  "proofstack_evaluation_oracle_specs",
  "proofstack_evaluation_qualification_fixture_sets",
  "proofstack_evaluation_qualification_reports",
  "proofstack_evaluation_raw_observations",
  "proofstack_evaluation_record_registry",
  "proofstack_evaluation_records",
  "proofstack_evaluation_resource_bindings",
  "proofstack_evaluation_run_rejections",
  "proofstack_evaluation_run_results",
  "proofstack_evaluation_runs",
  "proofstack_evaluation_source_reviews",
  "proofstack_evaluation_source_snapshots",
  "proofstack_evaluation_unique_bindings",
  "proofstack_evidence_events",
  "proofstack_identity_audit_events",
  "proofstack_interaction_fixture_artifact_ownerships",
  "proofstack_interaction_fixture_content_revocations",
  "proofstack_model_assurance_assessments",
  "proofstack_model_assurance_blinded_plans",
  "proofstack_model_assurance_blinded_results",
  "proofstack_model_assurance_calibration_reports",
  "proofstack_model_assurance_human_review_protocols",
  "proofstack_model_assurance_human_review_records",
  "proofstack_model_assurance_human_reviewer_independence",
  "proofstack_model_assurance_independence_declarations",
  "proofstack_model_assurance_independent_critiques",
  "proofstack_model_assurance_model_evaluators",
  "proofstack_model_assurance_model_profiles",
  "proofstack_model_assurance_qualification_reports",
  "proofstack_model_assurance_qualification_suites",
  "proofstack_model_assurance_records",
  "proofstack_oidc_bindings",
  "proofstack_outbox",
  "proofstack_projection_cursors",
  "proofstack_recorded_interaction_fixture_versions",
  "proofstack_regression_dataset_members",
  "proofstack_regression_dataset_versions",
  "proofstack_regression_datasets",
  "proofstack_regression_fixture_events",
  "proofstack_regression_fixture_versions",
  "proofstack_regression_fixtures",
  "proofstack_replay_attempt_events",
  "proofstack_replay_attempts",
  "proofstack_replay_budget_entries",
  "proofstack_replay_budget_entry_dimensions",
  "proofstack_replay_cancellation_acknowledgements",
  "proofstack_replay_cancellation_requests",
  "proofstack_replay_jobs",
  "proofstack_replay_observations",
  "proofstack_replay_plan_boundaries",
  "proofstack_replay_plan_budgets",
  "proofstack_replay_plan_resources",
  "proofstack_replay_plans",
  "proofstack_replay_recovery_events",
  "proofstack_replay_targets",
  "proofstack_replay_usage_measurements",
  "proofstack_target_releases",
] as const;

function runtimePool(credentials: { readonly name: string; readonly password: string }): Pool {
  const url = new URL(databaseUrl);
  url.username = credentials.name;
  url.password = credentials.password;
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  runtimePools.push(pool);
  return pool;
}

function evidence(tenantId: string, eventId: string, traceId: string): EvidenceEnvelope {
  return {
    evidence: {
      attributes: { isolationMatrix: true },
      contentReferences: [],
      eventId,
      extensions: {},
      kind: "agent.run",
      name: "tenant isolation matrix",
      source: {
        sdkName: "@proofstack/postgres",
        sdkVersion: "0.0.0",
        serviceName: "tenant-isolation-integration",
      },
      spanId: "30f067aa0ba902b7",
      startedAt: "2026-08-28T06:00:00.000Z",
      status: "ok",
      traceId,
    },
    receivedAt: "2026-08-28T06:00:01.000Z",
    schemaVersion: "0.1",
    scope: { environmentId, projectId, tenantId },
  };
}

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, roles);
});

afterAll(async () => {
  await Promise.all(runtimePools.map((pool) => pool.end()));
  for (const { name } of Object.values(roles)) {
    const exists = await adminPool.query<{ readonly present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present",
      [name],
    );
    if (exists.rows[0]?.present) {
      await adminPool.query(`DROP OWNED BY "${name}"`);
      await adminPool.query(`DROP ROLE "${name}"`);
    }
  }
  await adminPool.end();
});

describe("tenant isolation acceptance matrix", () => {
  it("forces row-level security on every tenant-bearing authoritative table", async () => {
    const tables = await adminPool.query<{
      readonly policy_count: number;
      readonly public_dml_grant: boolean;
      readonly relforcerowsecurity: boolean;
      readonly relname: string;
      readonly relrowsecurity: boolean;
    }>(`
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
        AND relation.relkind IN ('p', 'r')
        AND EXISTS (
          SELECT 1
          FROM pg_attribute AS attribute
          WHERE attribute.attrelid = relation.oid
            AND attribute.attname = 'tenant_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
      ORDER BY relation.relname
    `);

    expect(tables.rows.map(({ relname }) => relname)).toEqual(TENANT_TABLES);
    const violations = tables.rows.filter(
      ({ policy_count, public_dml_grant, relforcerowsecurity, relrowsecurity }) =>
        policy_count === 0 || public_dml_grant || !relforcerowsecurity || !relrowsecurity,
    );
    expect(violations).toEqual([]);
  });

  it("denies forged and guessed access without leaking pooled tenant context", async () => {
    const apiPool = runtimePool(roles.api);
    const repository = new PostgresEvidenceRepository(apiPool);
    const alpha = evidence(alphaTenant, `evt_matrix_alpha_${runKey}`, alphaTraceId);
    const beta = evidence(betaTenant, `evt_matrix_beta_${runKey}`, betaTraceId);

    await repository.append([alpha]);
    await repository.append([beta]);
    await expect(
      repository.listByTrace(alpha.scope, alphaTraceId, { limit: 10 }),
    ).resolves.toMatchObject({ events: [{ evidence: { eventId: alpha.evidence.eventId } }] });
    await expect(
      repository.listByTrace({ ...alpha.scope, tenantId: betaTenant }, alphaTraceId, { limit: 10 }),
    ).resolves.toEqual({ cursorFound: true, events: [], hasMore: false });

    const unscoped = await apiPool.query<{
      readonly evidence_count: number;
      readonly tenant_context: string | null;
    }>(`
      SELECT
        NULLIF(current_setting('proofstack.tenant_id', true), '') AS tenant_context,
        count(*)::integer AS evidence_count
      FROM public.proofstack_evidence_events
    `);
    expect(unscoped.rows).toEqual([{ evidence_count: 0, tenant_context: null }]);

    const forged = evidence(alphaTenant, `evt_matrix_forged_${runKey}`, alphaTraceId);
    await expect(
      withTenantTransaction(apiPool, betaTenant, (client) =>
        client.query(
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
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
          `,
          [
            alphaTenant,
            projectId,
            environmentId,
            forged.evidence.eventId,
            forged.evidence.traceId,
            forged.evidence.spanId,
            null,
            forged.evidence.startedAt,
            0,
            forged.receivedAt,
            forged.schemaVersion,
            JSON.stringify(forged.evidence),
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      repository.listByTrace(alpha.scope, alphaTraceId, { limit: 10 }),
    ).resolves.toMatchObject({ events: [{ evidence: { eventId: alpha.evidence.eventId } }] });
    const afterRejectedForgery = await apiPool.query<{ readonly count: number }>(
      "SELECT count(*)::integer AS count FROM public.proofstack_evidence_events",
    );
    expect(afterRejectedForgery.rows).toEqual([{ count: 0 }]);
  });
});
