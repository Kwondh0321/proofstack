import type { EvidenceEnvelope } from "@proofstack/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresConsumerReceiptRepository } from "./postgres-consumer-receipt-repository.js";
import { PostgresEvidenceRepository } from "./postgres-evidence-repository.js";
import { PostgresOutboxRepository } from "./postgres-outbox-repository.js";
import { PostgresProjectionCursorRepository } from "./postgres-projection-cursor-repository.js";
import { provisionRuntimeRoles, type RuntimeRoleProvisioningOptions } from "./runtime-roles.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runKey = Date.now().toString();
const roleNames = {
  api: `proofstack_it_api_${runKey}`,
  artifact: `proofstack_it_artifact_${runKey}`,
  consumer: `proofstack_it_consumer_${runKey}`,
  identity: `proofstack_it_identity_role_${runKey}`,
  publisher: `proofstack_it_publisher_${runKey}`,
  replayWorker: `proofstack_it_replay_worker_${runKey}`,
};
const sequenceName = `proofstack_it_sequence_${runKey}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const runtimePools: Pool[] = [];

function provisioningOptions(suffix: string): RuntimeRoleProvisioningOptions {
  return {
    api: { name: roleNames.api, password: `proofstack-api-${suffix}-password` },
    artifact: { name: roleNames.artifact, password: `proofstack-artifact-${suffix}-password` },
    consumer: { name: roleNames.consumer, password: `proofstack-consumer-${suffix}-password` },
    identity: { name: roleNames.identity, password: `proofstack-identity-${suffix}-password` },
    publisher: { name: roleNames.publisher, password: `proofstack-publisher-${suffix}-password` },
    replayWorker: {
      name: roleNames.replayWorker,
      password: `proofstack-replay-worker-${suffix}-password`,
    },
  };
}

function poolFor(credentials: { readonly name: string; readonly password: string }): Pool {
  const url = new URL(databaseUrl as string);
  url.username = credentials.name;
  url.password = credentials.password;
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  runtimePools.push(pool);
  return pool;
}

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await adminPool.query(`CREATE SEQUENCE public."${sequenceName}"`);
});

afterAll(async () => {
  await Promise.all(runtimePools.map((pool) => pool.end()));
  for (const roleName of Object.values(roleNames)) {
    const exists = await adminPool.query<{ readonly present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present",
      [roleName],
    );
    if (exists.rows[0]?.present) {
      await adminPool.query(`DROP OWNED BY "${roleName}"`);
      await adminPool.query(`DROP ROLE "${roleName}"`);
    }
  }
  await adminPool.query(`DROP SEQUENCE IF EXISTS public."${sequenceName}"`);
  await adminPool.end();
});

describe("runtime role provisioning", () => {
  it("creates isolated least-privilege roles and rotates their credentials", async () => {
    const initial = provisioningOptions("initial");
    await adminPool.query(`
      GRANT EXECUTE ON FUNCTION public.proofstack_regression_publication_intent_status(
        text, text, text, text, text, jsonb, timestamptz
      ) TO PUBLIC
    `);
    await adminPool.query(
      "GRANT EXECUTE ON FUNCTION public.proofstack_find_active_api_key(text) TO PUBLIC",
    );
    await expect(provisionRuntimeRoles(adminPool, initial)).resolves.toEqual({
      createdRoles: [
        roleNames.api,
        roleNames.identity,
        roleNames.replayWorker,
        roleNames.artifact,
        roleNames.publisher,
        roleNames.consumer,
      ],
      updatedRoles: [],
    });

    const publicFunctionPrivileges = await adminPool.query<{ readonly count: number }>(`
      SELECT count(*)::integer AS count
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname LIKE 'proofstack_%'
        AND EXISTS (
          SELECT 1
          FROM aclexplode(
            COALESCE(
              procedure.proacl,
              acldefault('f', procedure.proowner)
            )
          ) AS privilege
          WHERE privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
        )
    `);
    expect(publicFunctionPrivileges.rows).toEqual([{ count: 0 }]);

    const roleState = await adminPool.query<{
      readonly has_memberships: boolean;
      readonly marker: string | null;
      readonly rolbypassrls: boolean;
      readonly rolcreatedb: boolean;
      readonly rolcreaterole: boolean;
      readonly rolinherit: boolean;
      readonly rolreplication: boolean;
      readonly rolname: string;
      readonly rolsuper: boolean;
    }>(
      `
        SELECT
          rolname,
          rolsuper,
          rolcreatedb,
          rolcreaterole,
          rolinherit,
          rolreplication,
          rolbypassrls,
          shobj_description(oid, 'pg_authid') AS marker,
          EXISTS (
            SELECT 1
            FROM pg_auth_members
            WHERE roleid = pg_roles.oid OR member = pg_roles.oid
          ) AS has_memberships
        FROM pg_roles
        WHERE rolname = ANY($1::text[])
        ORDER BY rolname
      `,
      [Object.values(roleNames)],
    );
    expect(roleState.rows).toHaveLength(6);
    expect(
      roleState.rows.every(
        ({
          has_memberships,
          rolbypassrls,
          rolcreatedb,
          rolcreaterole,
          rolinherit,
          rolreplication,
          rolsuper,
        }) =>
          !has_memberships &&
          !rolbypassrls &&
          !rolcreatedb &&
          !rolcreaterole &&
          !rolinherit &&
          !rolreplication &&
          !rolsuper,
      ),
    ).toBe(true);
    expect(roleState.rows.map(({ marker }) => marker).sort()).toEqual([
      "proofstack-managed-runtime-role:v1:api",
      "proofstack-managed-runtime-role:v1:artifact",
      "proofstack-managed-runtime-role:v1:consumer",
      "proofstack-managed-runtime-role:v1:identity",
      "proofstack-managed-runtime-role:v1:publisher",
      "proofstack-managed-runtime-role:v1:replayWorker",
    ]);

    const replayWorkerPool = poolFor(initial.replayWorker);
    const replayWorkerPrivileges = await replayWorkerPool.query<{
      readonly acknowledgeExecute: boolean;
      readonly appendExecutionExecute: boolean;
      readonly appendUsageExecute: boolean;
      readonly attemptsSelect: boolean;
      readonly attemptEventsSelect: boolean;
      readonly claimExecute: boolean;
      readonly completeExecute: boolean;
      readonly heartbeatExecute: boolean;
      readonly jobsInsert: boolean;
      readonly jobsSelect: boolean;
      readonly jobsUpdate: boolean;
      readonly migrationsSelect: boolean;
      readonly outboxInsert: boolean;
      readonly plansInsert: boolean;
      readonly plansSelect: boolean;
      readonly reconcileExecute: boolean;
      readonly replaySnapshotExecute: boolean;
      readonly reserveExecute: boolean;
      readonly targetReleasesInsert: boolean;
      readonly targetReleasesSelect: boolean;
    }>(`
      SELECT
        has_table_privilege(current_user, 'proofstack_schema_migrations', 'SELECT')
          AS "migrationsSelect",
        has_table_privilege(current_user, 'proofstack_replay_jobs', 'SELECT')
          AS "jobsSelect",
        has_table_privilege(current_user, 'proofstack_replay_jobs', 'INSERT')
          AS "jobsInsert",
        has_table_privilege(current_user, 'proofstack_replay_jobs', 'UPDATE')
          AS "jobsUpdate",
        has_table_privilege(current_user, 'proofstack_replay_attempts', 'SELECT')
          AS "attemptsSelect",
        has_table_privilege(current_user, 'proofstack_replay_attempt_events', 'SELECT')
          AS "attemptEventsSelect",
        has_table_privilege(current_user, 'proofstack_outbox', 'INSERT')
          AS "outboxInsert",
        has_table_privilege(current_user, 'proofstack_replay_plans', 'SELECT')
          AS "plansSelect",
        has_table_privilege(current_user, 'proofstack_replay_plans', 'INSERT')
          AS "plansInsert",
        has_table_privilege(current_user, 'proofstack_target_releases', 'SELECT')
          AS "targetReleasesSelect",
        has_table_privilege(current_user, 'proofstack_target_releases', 'INSERT')
          AS "targetReleasesInsert",
        has_function_privilege(
          current_user,
          'proofstack_acknowledge_replay_cancellation(text,text,text,text,text,text,bigint,bigint,text,text)',
          'EXECUTE'
        ) AS "acknowledgeExecute",
        has_function_privilege(
          current_user,
          'proofstack_append_replay_execution_observation(text,text,text,text,text,text,bigint,bigint,text,jsonb)',
          'EXECUTE'
        ) AS "appendExecutionExecute",
        has_function_privilege(
          current_user,
          'proofstack_append_replay_usage_observation(text,text,text,text,text,text,bigint,bigint,text,text,text,jsonb)',
          'EXECUTE'
        ) AS "appendUsageExecute",
        has_function_privilege(
          current_user,
          'proofstack_claim_replay_job(text,text,text,text,text,text,text,text,text,bigint)',
          'EXECUTE'
        ) AS "claimExecute",
        has_function_privilege(
          current_user,
          'proofstack_complete_replay_job(text,text,text,text,text,text,bigint,bigint,text,text,jsonb,jsonb)',
          'EXECUTE'
        ) AS "completeExecute",
        has_function_privilege(
          current_user,
          'proofstack_heartbeat_replay_job(text,text,text,text,text,text,bigint,bigint,bigint)',
          'EXECUTE'
        ) AS "heartbeatExecute",
        has_function_privilege(
          current_user,
          'proofstack_reconcile_replay_budget(text,text,text,text,text,text,bigint,bigint,text,text,jsonb)',
          'EXECUTE'
        ) AS "reconcileExecute",
        has_function_privilege(
          current_user,
          'proofstack_read_replay_job_snapshot(text,text,text)',
          'EXECUTE'
        ) AS "replaySnapshotExecute",
        has_function_privilege(
          current_user,
          'proofstack_reserve_replay_budget(text,text,text,text,text,text,bigint,bigint,text,jsonb,jsonb)',
          'EXECUTE'
        ) AS "reserveExecute"
    `);
    expect(replayWorkerPrivileges.rows).toEqual([
      {
        acknowledgeExecute: true,
        appendExecutionExecute: true,
        appendUsageExecute: true,
        attemptsSelect: false,
        attemptEventsSelect: false,
        claimExecute: true,
        completeExecute: true,
        heartbeatExecute: true,
        jobsInsert: false,
        jobsSelect: false,
        jobsUpdate: false,
        migrationsSelect: true,
        outboxInsert: false,
        plansInsert: false,
        plansSelect: true,
        reconcileExecute: true,
        replaySnapshotExecute: true,
        reserveExecute: true,
        targetReleasesInsert: false,
        targetReleasesSelect: true,
      },
    ]);

    const apiPool = poolFor(initial.api);
    const apiPrivileges = await apiPool.query<{
      readonly artifactCatalogInsert: boolean;
      readonly artifactCatalogSelect: boolean;
      readonly artifactCatalogUpdate: boolean;
      readonly artifactPurgeDelete: boolean;
      readonly artifactPurgeInsert: boolean;
      readonly artifactPurgeSelect: boolean;
      readonly artifactTombstoneDelete: boolean;
      readonly artifactTombstoneInsert: boolean;
      readonly artifactTombstoneSelect: boolean;
      readonly can_create_public: boolean;
      readonly evidence_insert: boolean;
      readonly evidence_select: boolean;
      readonly evidence_update: boolean;
      readonly identity_lookup_execute: boolean;
      readonly identity_select: boolean;
      readonly ledger_select: boolean;
      readonly oidc_lookup_execute: boolean;
      readonly outbox_insert: boolean;
      readonly outbox_select: boolean;
      readonly regressionDelete: boolean;
      readonly regressionHelperExecute: boolean;
      readonly regressionIntentStatusExecute: boolean;
      readonly regressionInsert: boolean;
      readonly regressionSelect: boolean;
      readonly regressionUpdate: boolean;
      readonly replayDelete: boolean;
      readonly replayInsert: boolean;
      readonly replayIntentStatusExecute: boolean;
      readonly replayJobCancelExecute: boolean;
      readonly replayJobCreateExecute: boolean;
      readonly replayJobDelete: boolean;
      readonly replayJobInsert: boolean;
      readonly replayJobIntentStatusExecute: boolean;
      readonly replayJobSnapshotExecute: boolean;
      readonly replayJobSelect: boolean;
      readonly replayJobUpdate: boolean;
      readonly replaySelect: boolean;
      readonly replayUpdate: boolean;
      readonly sequence_usage: boolean;
    }>(
      `
      SELECT
        has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public,
        has_table_privilege(current_user, 'proofstack_schema_migrations', 'SELECT') AS ledger_select,
        has_table_privilege(current_user, 'proofstack_evidence_events', 'SELECT') AS evidence_select,
        has_table_privilege(current_user, 'proofstack_evidence_events', 'INSERT') AS evidence_insert,
        has_table_privilege(current_user, 'proofstack_evidence_events', 'UPDATE') AS evidence_update,
        has_table_privilege(
          current_user,
          'proofstack_api_key_credentials',
          'SELECT'
        ) AS identity_select,
        has_function_privilege(
          current_user,
          'proofstack_find_active_api_key(text)',
          'EXECUTE'
        ) AS identity_lookup_execute,
        has_function_privilege(
          current_user,
          'proofstack_find_active_oidc_binding(text, text, text)',
          'EXECUTE'
        ) AS oidc_lookup_execute,
        has_table_privilege(current_user, 'proofstack_outbox', 'INSERT') AS outbox_insert,
        has_table_privilege(current_user, 'proofstack_outbox', 'SELECT') AS outbox_select,
        has_table_privilege(
          current_user,
          'proofstack_artifact_catalog',
          'SELECT'
        ) AS "artifactCatalogSelect",
        has_table_privilege(
          current_user,
          'proofstack_artifact_catalog',
          'INSERT'
        ) AS "artifactCatalogInsert",
        has_table_privilege(
          current_user,
          'proofstack_artifact_catalog',
          'UPDATE'
        ) AS "artifactCatalogUpdate",
        has_table_privilege(
          current_user,
          'proofstack_artifact_tombstones',
          'SELECT'
        ) AS "artifactTombstoneSelect",
        has_table_privilege(
          current_user,
          'proofstack_artifact_tombstones',
          'INSERT'
        ) AS "artifactTombstoneInsert",
        has_table_privilege(
          current_user,
          'proofstack_artifact_tombstones',
          'DELETE'
        ) AS "artifactTombstoneDelete",
        has_table_privilege(
          current_user,
          'proofstack_artifact_purge_receipts',
          'SELECT'
        ) AS "artifactPurgeSelect",
        has_table_privilege(
          current_user,
          'proofstack_artifact_purge_receipts',
          'INSERT'
        ) AS "artifactPurgeInsert",
        has_table_privilege(
          current_user,
          'proofstack_artifact_purge_receipts',
          'DELETE'
        ) AS "artifactPurgeDelete",
        (
          SELECT bool_and(has_table_privilege(current_user, relation_name, 'SELECT'))
          FROM unnest(ARRAY[
            'proofstack_recorded_interaction_fixture_versions',
            'proofstack_interaction_fixture_artifact_ownerships',
            'proofstack_interaction_fixture_content_revocations',
            'proofstack_regression_fixtures',
            'proofstack_regression_fixture_versions',
            'proofstack_regression_fixture_events',
            'proofstack_regression_datasets',
            'proofstack_regression_dataset_versions',
            'proofstack_regression_dataset_members'
          ]) AS regression_relation(relation_name)
        ) AS "regressionSelect",
        (
          SELECT bool_and(has_table_privilege(current_user, relation_name, 'INSERT'))
          FROM unnest(ARRAY[
            'proofstack_recorded_interaction_fixture_versions',
            'proofstack_interaction_fixture_artifact_ownerships',
            'proofstack_interaction_fixture_content_revocations',
            'proofstack_regression_fixtures',
            'proofstack_regression_fixture_versions',
            'proofstack_regression_fixture_events',
            'proofstack_regression_datasets',
            'proofstack_regression_dataset_versions',
            'proofstack_regression_dataset_members'
          ]) AS regression_relation(relation_name)
        ) AS "regressionInsert",
        (
          SELECT bool_or(has_table_privilege(current_user, relation_name, 'UPDATE'))
          FROM unnest(ARRAY[
            'proofstack_recorded_interaction_fixture_versions',
            'proofstack_interaction_fixture_artifact_ownerships',
            'proofstack_interaction_fixture_content_revocations',
            'proofstack_regression_fixtures',
            'proofstack_regression_fixture_versions',
            'proofstack_regression_fixture_events',
            'proofstack_regression_datasets',
            'proofstack_regression_dataset_versions',
            'proofstack_regression_dataset_members'
          ]) AS regression_relation(relation_name)
        ) AS "regressionUpdate",
        (
          SELECT bool_or(has_table_privilege(current_user, relation_name, 'DELETE'))
          FROM unnest(ARRAY[
            'proofstack_recorded_interaction_fixture_versions',
            'proofstack_interaction_fixture_artifact_ownerships',
            'proofstack_interaction_fixture_content_revocations',
            'proofstack_regression_fixtures',
            'proofstack_regression_fixture_versions',
            'proofstack_regression_fixture_events',
            'proofstack_regression_datasets',
            'proofstack_regression_dataset_versions',
            'proofstack_regression_dataset_members'
          ]) AS regression_relation(relation_name)
        ) AS "regressionDelete",
        has_function_privilege(
          current_user,
          'proofstack_valid_regression_text(text, integer)',
          'EXECUTE'
        ) AS "regressionHelperExecute",
        has_function_privilege(
          current_user,
          'proofstack_regression_publication_intent_status(text, text, text, text, text, jsonb, timestamp with time zone)',
          'EXECUTE'
        ) AS "regressionIntentStatusExecute",
        (
          SELECT bool_and(has_table_privilege(current_user, relation_name, 'SELECT'))
          FROM unnest(ARRAY[
            'proofstack_replay_targets',
            'proofstack_target_releases',
            'proofstack_replay_plan_resources',
            'proofstack_replay_plans',
            'proofstack_replay_plan_budgets',
            'proofstack_replay_plan_boundaries'
          ]) AS replay_relation(relation_name)
        ) AS "replaySelect",
        (
          SELECT bool_and(has_table_privilege(current_user, relation_name, 'INSERT'))
          FROM unnest(ARRAY[
            'proofstack_replay_targets',
            'proofstack_target_releases',
            'proofstack_replay_plan_resources',
            'proofstack_replay_plans',
            'proofstack_replay_plan_budgets',
            'proofstack_replay_plan_boundaries'
          ]) AS replay_relation(relation_name)
        ) AS "replayInsert",
        (
          SELECT bool_or(has_table_privilege(current_user, relation_name, 'UPDATE'))
          FROM unnest(ARRAY[
            'proofstack_replay_targets',
            'proofstack_target_releases',
            'proofstack_replay_plan_resources',
            'proofstack_replay_plans',
            'proofstack_replay_plan_budgets',
            'proofstack_replay_plan_boundaries'
          ]) AS replay_relation(relation_name)
        ) AS "replayUpdate",
        (
          SELECT bool_or(has_table_privilege(current_user, relation_name, 'DELETE'))
          FROM unnest(ARRAY[
            'proofstack_replay_targets',
            'proofstack_target_releases',
            'proofstack_replay_plan_resources',
            'proofstack_replay_plans',
            'proofstack_replay_plan_budgets',
            'proofstack_replay_plan_boundaries'
          ]) AS replay_relation(relation_name)
        ) AS "replayDelete",
        has_function_privilege(
          current_user,
          'proofstack_replay_publication_intent_status(text, text, text, text, text, jsonb, timestamp with time zone)',
          'EXECUTE'
        ) AS "replayIntentStatusExecute",
        (
          SELECT bool_and(has_table_privilege(current_user, relation_name, 'SELECT'))
          FROM unnest(ARRAY[
            'proofstack_replay_jobs',
            'proofstack_replay_attempts',
            'proofstack_replay_cancellation_requests',
            'proofstack_replay_cancellation_acknowledgements',
            'proofstack_replay_budget_entries',
            'proofstack_replay_budget_entry_dimensions',
            'proofstack_replay_observations',
            'proofstack_replay_usage_measurements'
          ]) AS replay_job_relation(relation_name)
        ) AS "replayJobSelect",
        (
          SELECT bool_or(has_table_privilege(current_user, relation_name, 'INSERT'))
          FROM unnest(ARRAY[
            'proofstack_replay_jobs',
            'proofstack_replay_attempts',
            'proofstack_replay_cancellation_requests',
            'proofstack_replay_cancellation_acknowledgements',
            'proofstack_replay_budget_entries',
            'proofstack_replay_budget_entry_dimensions',
            'proofstack_replay_observations',
            'proofstack_replay_usage_measurements'
          ]) AS replay_job_relation(relation_name)
        ) AS "replayJobInsert",
        (
          SELECT bool_or(has_table_privilege(current_user, relation_name, 'UPDATE'))
          FROM unnest(ARRAY[
            'proofstack_replay_jobs',
            'proofstack_replay_attempts',
            'proofstack_replay_cancellation_requests',
            'proofstack_replay_cancellation_acknowledgements',
            'proofstack_replay_budget_entries',
            'proofstack_replay_budget_entry_dimensions',
            'proofstack_replay_observations',
            'proofstack_replay_usage_measurements'
          ]) AS replay_job_relation(relation_name)
        ) AS "replayJobUpdate",
        (
          SELECT bool_or(has_table_privilege(current_user, relation_name, 'DELETE'))
          FROM unnest(ARRAY[
            'proofstack_replay_jobs',
            'proofstack_replay_attempts',
            'proofstack_replay_cancellation_requests',
            'proofstack_replay_cancellation_acknowledgements',
            'proofstack_replay_budget_entries',
            'proofstack_replay_budget_entry_dimensions',
            'proofstack_replay_observations',
            'proofstack_replay_usage_measurements'
          ]) AS replay_job_relation(relation_name)
        ) AS "replayJobDelete",
        has_function_privilege(
          current_user,
          'proofstack_create_replay_job(text, text, text, text, text, text, text)',
          'EXECUTE'
        ) AS "replayJobCreateExecute",
        has_function_privilege(
          current_user,
          'proofstack_request_replay_cancellation(text, text, text, text, text, text, text)',
          'EXECUTE'
        ) AS "replayJobCancelExecute",
        has_function_privilege(
          current_user,
          'proofstack_replay_job_intent_status(text, text, text, jsonb, timestamp with time zone)',
          'EXECUTE'
        ) AS "replayJobIntentStatusExecute",
        has_function_privilege(
          current_user,
          'proofstack_read_replay_job_snapshot(text, text, text)',
          'EXECUTE'
        ) AS "replayJobSnapshotExecute",
        has_sequence_privilege(
          current_user,
          $1,
          'USAGE'
        ) AS sequence_usage
    `,
      [`public.${sequenceName}`],
    );
    expect(apiPrivileges.rows[0]).toEqual({
      artifactCatalogInsert: true,
      artifactCatalogSelect: true,
      artifactCatalogUpdate: true,
      artifactPurgeDelete: false,
      artifactPurgeInsert: true,
      artifactPurgeSelect: true,
      artifactTombstoneDelete: false,
      artifactTombstoneInsert: true,
      artifactTombstoneSelect: true,
      can_create_public: false,
      evidence_insert: true,
      evidence_select: true,
      evidence_update: false,
      identity_lookup_execute: false,
      identity_select: false,
      ledger_select: true,
      oidc_lookup_execute: false,
      outbox_insert: true,
      outbox_select: false,
      regressionDelete: false,
      regressionHelperExecute: true,
      regressionIntentStatusExecute: true,
      regressionInsert: true,
      regressionSelect: true,
      regressionUpdate: false,
      replayDelete: false,
      replayInsert: true,
      replayIntentStatusExecute: true,
      replayJobCancelExecute: true,
      replayJobCreateExecute: true,
      replayJobDelete: false,
      replayJobInsert: false,
      replayJobIntentStatusExecute: true,
      replayJobSnapshotExecute: true,
      replayJobSelect: true,
      replayJobUpdate: false,
      replaySelect: true,
      replayUpdate: false,
      sequence_usage: false,
    });

    const artifactPool = poolFor(initial.artifact);
    const artifactPrivileges = await artifactPool.query<{
      readonly catalogDelete: boolean;
      readonly catalogInsert: boolean;
      readonly catalogSelect: boolean;
      readonly catalogUpdate: boolean;
      readonly evidenceSelect: boolean;
      readonly fixtureMetadataDelete: boolean;
      readonly fixtureMetadataInsert: boolean;
      readonly fixtureMetadataSelect: boolean;
      readonly fixtureMetadataUpdate: boolean;
      readonly ledgerSelect: boolean;
      readonly outboxSelect: boolean;
      readonly purgeDelete: boolean;
      readonly purgeInsert: boolean;
      readonly purgeSelect: boolean;
      readonly purgeUpdate: boolean;
      readonly regressionHelperExecute: boolean;
      readonly regressionIntentStatusExecute: boolean;
      readonly regressionSelect: boolean;
      readonly sequenceUsage: boolean;
      readonly tombstoneDelete: boolean;
      readonly tombstoneInsert: boolean;
      readonly tombstoneSelect: boolean;
      readonly tombstoneUpdate: boolean;
    }>(
      `
        SELECT
          has_table_privilege(current_user, 'proofstack_schema_migrations', 'SELECT')
            AS "ledgerSelect",
          has_table_privilege(current_user, 'proofstack_artifact_catalog', 'SELECT')
            AS "catalogSelect",
          has_table_privilege(current_user, 'proofstack_artifact_catalog', 'INSERT')
            AS "catalogInsert",
          has_table_privilege(current_user, 'proofstack_artifact_catalog', 'UPDATE')
            AS "catalogUpdate",
          has_table_privilege(current_user, 'proofstack_artifact_catalog', 'DELETE')
            AS "catalogDelete",
          has_table_privilege(current_user, 'proofstack_artifact_tombstones', 'SELECT')
            AS "tombstoneSelect",
          has_table_privilege(current_user, 'proofstack_artifact_tombstones', 'INSERT')
            AS "tombstoneInsert",
          has_table_privilege(current_user, 'proofstack_artifact_tombstones', 'UPDATE')
            AS "tombstoneUpdate",
          has_table_privilege(current_user, 'proofstack_artifact_tombstones', 'DELETE')
            AS "tombstoneDelete",
          has_table_privilege(current_user, 'proofstack_artifact_purge_receipts', 'SELECT')
            AS "purgeSelect",
          has_table_privilege(current_user, 'proofstack_artifact_purge_receipts', 'INSERT')
            AS "purgeInsert",
          has_table_privilege(current_user, 'proofstack_artifact_purge_receipts', 'UPDATE')
            AS "purgeUpdate",
          has_table_privilege(current_user, 'proofstack_artifact_purge_receipts', 'DELETE')
            AS "purgeDelete",
          has_table_privilege(current_user, 'proofstack_evidence_events', 'SELECT')
            AS "evidenceSelect",
          (
            SELECT bool_and(has_table_privilege(current_user, relation_name, 'SELECT'))
            FROM unnest(ARRAY[
              'proofstack_interaction_fixture_artifact_ownerships',
              'proofstack_interaction_fixture_content_revocations'
            ]) AS fixture_metadata(relation_name)
          ) AS "fixtureMetadataSelect",
          (
            SELECT bool_or(has_table_privilege(current_user, relation_name, 'INSERT'))
            FROM unnest(ARRAY[
              'proofstack_interaction_fixture_artifact_ownerships',
              'proofstack_interaction_fixture_content_revocations'
            ]) AS fixture_metadata(relation_name)
          ) AS "fixtureMetadataInsert",
          (
            SELECT bool_or(has_table_privilege(current_user, relation_name, 'UPDATE'))
            FROM unnest(ARRAY[
              'proofstack_interaction_fixture_artifact_ownerships',
              'proofstack_interaction_fixture_content_revocations'
            ]) AS fixture_metadata(relation_name)
          ) AS "fixtureMetadataUpdate",
          (
            SELECT bool_or(has_table_privilege(current_user, relation_name, 'DELETE'))
            FROM unnest(ARRAY[
              'proofstack_interaction_fixture_artifact_ownerships',
              'proofstack_interaction_fixture_content_revocations'
            ]) AS fixture_metadata(relation_name)
          ) AS "fixtureMetadataDelete",
          has_table_privilege(current_user, 'proofstack_outbox', 'SELECT') AS "outboxSelect",
          has_table_privilege(
            current_user,
            'proofstack_regression_fixture_versions',
            'SELECT'
          ) AS "regressionSelect",
          has_function_privilege(
            current_user,
            'proofstack_valid_regression_text(text, integer)',
            'EXECUTE'
          ) AS "regressionHelperExecute",
          has_function_privilege(
            current_user,
            'proofstack_regression_publication_intent_status(text, text, text, text, text, jsonb, timestamp with time zone)',
            'EXECUTE'
          ) AS "regressionIntentStatusExecute",
          has_sequence_privilege(current_user, $1, 'USAGE') AS "sequenceUsage"
      `,
      [`public.${sequenceName}`],
    );
    expect(artifactPrivileges.rows[0]).toEqual({
      catalogDelete: false,
      catalogInsert: false,
      catalogSelect: true,
      catalogUpdate: true,
      evidenceSelect: false,
      fixtureMetadataDelete: false,
      fixtureMetadataInsert: false,
      fixtureMetadataSelect: true,
      fixtureMetadataUpdate: false,
      ledgerSelect: true,
      outboxSelect: false,
      purgeDelete: false,
      purgeInsert: true,
      purgeSelect: true,
      purgeUpdate: false,
      regressionHelperExecute: false,
      regressionIntentStatusExecute: false,
      regressionSelect: false,
      sequenceUsage: false,
      tombstoneDelete: false,
      tombstoneInsert: true,
      tombstoneSelect: true,
      tombstoneUpdate: false,
    });

    const publisherPool = poolFor(initial.publisher);
    const publisherPrivileges = await publisherPool.query<{
      readonly evidence_select: boolean;
      readonly identity_lookup_execute: boolean;
      readonly identity_select: boolean;
      readonly outbox_insert: boolean;
      readonly outbox_select: boolean;
      readonly outbox_update: boolean;
      readonly regression_intent_status_execute: boolean;
    }>(`
      SELECT
        has_table_privilege(current_user, 'proofstack_evidence_events', 'SELECT') AS evidence_select,
        has_table_privilege(current_user, 'proofstack_api_key_credentials', 'SELECT')
          AS identity_select,
        has_function_privilege(
          current_user,
          'proofstack_find_active_api_key(text)',
          'EXECUTE'
        ) AS identity_lookup_execute,
        has_table_privilege(current_user, 'proofstack_outbox', 'SELECT') AS outbox_select,
        has_table_privilege(current_user, 'proofstack_outbox', 'UPDATE') AS outbox_update,
        has_table_privilege(current_user, 'proofstack_outbox', 'INSERT') AS outbox_insert,
        has_function_privilege(
          current_user,
          'proofstack_regression_publication_intent_status(text, text, text, text, text, jsonb, timestamp with time zone)',
          'EXECUTE'
        ) AS regression_intent_status_execute
    `);
    expect(publisherPrivileges.rows[0]).toEqual({
      evidence_select: false,
      identity_lookup_execute: false,
      identity_select: false,
      outbox_insert: false,
      outbox_select: true,
      outbox_update: true,
      regression_intent_status_execute: false,
    });

    const identityPool = poolFor(initial.identity);
    const identityPrivileges = await identityPool.query<{
      readonly audit_select: boolean;
      readonly create_execute: boolean;
      readonly evidence_select: boolean;
      readonly helper_execute: boolean;
      readonly identity_select: boolean;
      readonly ledger_select: boolean;
      readonly lookup_execute: boolean;
      readonly oidc_binding_select: boolean;
      readonly oidc_lookup_execute: boolean;
      readonly regression_intent_status_execute: boolean;
      readonly session_lookup_execute: boolean;
      readonly session_select: boolean;
    }>(`
      SELECT
        has_table_privilege(current_user, 'proofstack_schema_migrations', 'SELECT')
          AS ledger_select,
        has_table_privilege(current_user, 'proofstack_api_key_credentials', 'SELECT')
          AS identity_select,
        has_table_privilege(current_user, 'proofstack_identity_audit_events', 'SELECT')
          AS audit_select,
        has_table_privilege(current_user, 'proofstack_oidc_bindings', 'SELECT')
          AS oidc_binding_select,
        has_table_privilege(current_user, 'proofstack_browser_sessions', 'SELECT')
          AS session_select,
        has_table_privilege(current_user, 'proofstack_evidence_events', 'SELECT')
          AS evidence_select,
        has_function_privilege(
          current_user,
          'proofstack_find_active_api_key(text)',
          'EXECUTE'
        ) AS lookup_execute,
        has_function_privilege(
          current_user,
          'proofstack_create_api_key(text, text, text, text, text, text[], jsonb, text, integer, integer, integer, integer, text, text, timestamptz, text)',
          'EXECUTE'
        ) AS create_execute,
        has_function_privilege(
          current_user,
          'proofstack_find_active_oidc_binding(text, text, text)',
          'EXECUTE'
        ) AS oidc_lookup_execute,
        has_function_privilege(
          current_user,
          'proofstack_find_and_touch_active_browser_session(text)',
          'EXECUTE'
        ) AS session_lookup_execute,
        has_function_privilege(
          current_user,
          'proofstack_write_identity_audit(text, text, text, text, text, text, text, timestamptz)',
          'EXECUTE'
        ) AS helper_execute,
        has_function_privilege(
          current_user,
          'proofstack_regression_publication_intent_status(text, text, text, text, text, jsonb, timestamp with time zone)',
          'EXECUTE'
        ) AS regression_intent_status_execute
    `);
    expect(identityPrivileges.rows[0]).toEqual({
      audit_select: false,
      create_execute: true,
      evidence_select: false,
      helper_execute: false,
      identity_select: false,
      ledger_select: true,
      lookup_execute: true,
      oidc_binding_select: false,
      oidc_lookup_execute: true,
      regression_intent_status_execute: false,
      session_lookup_execute: true,
      session_select: false,
    });

    const consumerPool = poolFor(initial.consumer);
    const consumerPrivileges = await consumerPool.query<{
      readonly cursor_insert: boolean;
      readonly cursor_select: boolean;
      readonly cursor_update: boolean;
      readonly evidence_select: boolean;
      readonly identity_lookup_execute: boolean;
      readonly identity_select: boolean;
      readonly outbox_select: boolean;
      readonly regression_intent_status_execute: boolean;
      readonly receipt_insert: boolean;
      readonly receipt_select: boolean;
      readonly receipt_update: boolean;
    }>(`
      SELECT
        has_table_privilege(current_user, 'proofstack_consumer_receipts', 'SELECT') AS receipt_select,
        has_table_privilege(current_user, 'proofstack_consumer_receipts', 'INSERT') AS receipt_insert,
        has_table_privilege(current_user, 'proofstack_consumer_receipts', 'UPDATE') AS receipt_update,
        has_table_privilege(current_user, 'proofstack_projection_cursors', 'SELECT') AS cursor_select,
        has_table_privilege(current_user, 'proofstack_projection_cursors', 'INSERT') AS cursor_insert,
        has_table_privilege(current_user, 'proofstack_projection_cursors', 'UPDATE') AS cursor_update,
        has_table_privilege(current_user, 'proofstack_evidence_events', 'SELECT') AS evidence_select,
        has_table_privilege(current_user, 'proofstack_api_key_credentials', 'SELECT')
          AS identity_select,
        has_function_privilege(
          current_user,
          'proofstack_find_active_api_key(text)',
          'EXECUTE'
        ) AS identity_lookup_execute,
        has_table_privilege(current_user, 'proofstack_outbox', 'SELECT') AS outbox_select,
        has_function_privilege(
          current_user,
          'proofstack_regression_publication_intent_status(text, text, text, text, text, jsonb, timestamp with time zone)',
          'EXECUTE'
        ) AS regression_intent_status_execute
    `);
    expect(consumerPrivileges.rows[0]).toEqual({
      cursor_insert: true,
      cursor_select: true,
      cursor_update: true,
      evidence_select: false,
      identity_lookup_execute: false,
      identity_select: false,
      outbox_select: false,
      regression_intent_status_execute: false,
      receipt_insert: true,
      receipt_select: true,
      receipt_update: true,
    });

    const tenantId = `ten_roles_${runKey}`;
    const evidence: EvidenceEnvelope = {
      evidence: {
        attributes: {},
        contentReferences: [],
        eventId: `evt_roles_${runKey}`,
        extensions: {},
        kind: "agent.run",
        name: "runtime-role-contract",
        source: {
          sdkName: "@proofstack/testkit",
          sdkVersion: "0.0.0",
          serviceName: "runtime-role-contract",
        },
        spanId: "70f067aa0ba902b7",
        startedAt: "2026-08-28T04:59:59.000Z",
        status: "ok",
        traceId: "8bf92f3577b34da6a3ce929d0e0e4736",
      },
      receivedAt: "2026-08-28T05:00:00.000Z",
      schemaVersion: "0.1",
      scope: {
        environmentId: "env_roles",
        projectId: "prj_roles",
        tenantId,
      },
    };
    await expect(new PostgresEvidenceRepository(apiPool).append([evidence])).resolves.toEqual({
      acceptedEventIds: [evidence.evidence.eventId],
      duplicateEventIds: [],
    });

    const outbox = new PostgresOutboxRepository(
      publisherPool,
      () => "11111111-1111-4111-8111-111111111111",
    );
    const claimed = await outbox.claim(tenantId, {
      leaseDurationMs: 60_000,
      limit: 1,
      workerId: "worker_roles",
    });
    const message = claimed[0];
    expect(message).toMatchObject({ aggregateId: evidence.evidence.eventId, tenantId });
    if (!message) throw new Error("Provisioned publisher did not receive the evidence outbox row");

    const receipts = new PostgresConsumerReceiptRepository(
      consumerPool,
      () => "22222222-2222-4222-8222-222222222222",
    );
    const receipt = await receipts.claim(tenantId, {
      consumerName: "projection.roles",
      leaseDurationMs: 60_000,
      messageId: `outbox:${message.outboxId}`,
      payloadSha256: "a".repeat(64),
      workerId: "worker_roles",
    });
    expect(receipt.status).toBe("acquired");
    if (receipt.status !== "acquired" || !receipt.receipt.lease) {
      throw new Error("Provisioned consumer did not acquire a consumer receipt lease");
    }
    await expect(
      receipts.complete(tenantId, {
        consumerName: "projection.roles",
        leaseToken: receipt.receipt.lease.token,
        messageId: `outbox:${message.outboxId}`,
      }),
    ).resolves.toBe(true);
    await expect(
      new PostgresProjectionCursorRepository(consumerPool).advance(tenantId, {
        consumerName: "projection.roles",
        generation: 1,
        lastOutboxId: message.outboxId,
      }),
    ).resolves.toMatchObject({ advanced: true });
    await expect(
      outbox.acknowledge(tenantId, {
        leaseToken: message.lease.token,
        outboxId: message.outboxId,
      }),
    ).resolves.toBe(true);

    const rotated = provisioningOptions("rotated");
    await adminPool.query(`GRANT USAGE ON SEQUENCE public."${sequenceName}" TO "${roleNames.api}"`);
    await adminPool.query(`
      GRANT EXECUTE ON FUNCTION public.proofstack_write_identity_audit(
        text, text, text, text, text, text, text, timestamptz
      ) TO "${roleNames.identity}"
    `);
    await expect(provisionRuntimeRoles(adminPool, rotated)).resolves.toEqual({
      createdRoles: [],
      updatedRoles: [
        roleNames.api,
        roleNames.identity,
        roleNames.replayWorker,
        roleNames.artifact,
        roleNames.publisher,
        roleNames.consumer,
      ],
    });
    const rotatedApiPool = poolFor(rotated.api);
    await expect(rotatedApiPool.query("SELECT current_user AS role")).resolves.toMatchObject({
      rows: [{ role: roleNames.api }],
    });
    await expect(
      rotatedApiPool.query<{ readonly sequence_usage: boolean }>(
        "SELECT has_sequence_privilege(current_user, $1, 'USAGE') AS sequence_usage",
        [`public.${sequenceName}`],
      ),
    ).resolves.toMatchObject({ rows: [{ sequence_usage: false }] });
    const rotatedIdentityPool = poolFor(rotated.identity);
    await expect(
      rotatedIdentityPool.query<{
        readonly helper_execute: boolean;
        readonly lookup_execute: boolean;
      }>(`
        SELECT
          has_function_privilege(
            current_user,
            'proofstack_find_active_api_key(text)',
            'EXECUTE'
          ) AS lookup_execute,
          has_function_privilege(
            current_user,
            'proofstack_write_identity_audit(text, text, text, text, text, text, text, timestamptz)',
            'EXECUTE'
          ) AS helper_execute
      `),
    ).resolves.toMatchObject({
      rows: [{ helper_execute: false, lookup_execute: true }],
    });
  });
});
