import { randomUUID } from "node:crypto";
import { ReplayCancellationRequestSchema, ReplayJobSchema } from "@proofstack/contracts";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import {
  provisionRuntimeRoles,
  type RuntimeRoleCredentials,
  type RuntimeRoleProvisioningOptions,
} from "./runtime-roles.js";
import { withTenantTransaction } from "./tenant-transaction.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const tenantId = `ten_control_${runKey}`;
const projectId = `prj_control_${runKey}`;
const environmentId = `env_control_${runKey}`;
const planId = `plan_control_${runKey}`;
const planVersionId = `plv_control_${runKey}`;
const planDefinitionSha256 = "a".repeat(64);
const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });

const credentials = {
  api: {
    name: `ps_ctrl_api_${runKey}`,
    password: `proofstack-control-api-${runKey}`,
  },
  artifact: {
    name: `ps_ctrl_art_${runKey}`,
    password: `proofstack-control-artifact-${runKey}`,
  },
  consumer: {
    name: `ps_ctrl_con_${runKey}`,
    password: `proofstack-control-consumer-${runKey}`,
  },
  identity: {
    name: `ps_ctrl_id_${runKey}`,
    password: `proofstack-control-identity-${runKey}`,
  },
  publisher: {
    name: `ps_ctrl_pub_${runKey}`,
    password: `proofstack-control-publisher-${runKey}`,
  },
  replayWorker: {
    name: `ps_ctrl_worker_${runKey}`,
    password: `proofstack-control-replay-worker-${runKey}`,
  },
} as const satisfies RuntimeRoleProvisioningOptions;

function connectionStringFor(role: RuntimeRoleCredentials): string {
  const url = new URL(databaseUrl as string);
  url.username = role.name;
  url.password = role.password;
  return url.toString();
}

const apiPool = new Pool({ connectionString: connectionStringFor(credentials.api), max: 4 });

function testPlan() {
  const createdAt = "2026-08-29T10:00:00.000Z";
  return {
    boundaries: [{}],
    createdAt,
    createdByPrincipalId: "usr_control_seed",
    dataset: {
      datasetId: `dat_control_${runKey}`,
      datasetVersionId: `dsv_control_${runKey}`,
      definitionSha256: "b".repeat(64),
    },
    definitionSha256: planDefinitionSha256,
    isolationProfile: {
      definitionSha256: "c".repeat(64),
      id: "iso_control",
      version: "1.0.0",
    },
    planId,
    planVersionId,
    retryPolicy: {
      automatic: false,
      backoff: { kind: "none" },
      idempotencyRequirement: "no_external_effect",
      maxAttempts: 1,
      perAttemptTimeoutMilliseconds: 2_000,
      retryableErrors: [],
      totalDeadlineMilliseconds: 10_000,
    },
    runtimeProfile: {
      definitionSha256: "d".repeat(64),
      family: "node",
      id: "run_control",
      version: "1.0.0",
    },
    schemaVersion: "0.1",
    scope: { environmentId, projectId, tenantId },
    targetRelease: {
      definitionSha256: "e".repeat(64),
      targetAdapter: {
        name: "proofstack.control_test",
        protocolVersion: "1.0.0",
        version: "1.0.0",
      },
      targetId: `target_control_${runKey}`,
      targetReleaseId: `trg_control_${runKey}`,
      workerProtocol: { name: "proofstack.replay-worker", version: "1.0.0" },
    },
    workerProtocol: { name: "proofstack.replay-worker", version: "1.0.0" },
  } as const;
}

async function seedExactPlan(): Promise<void> {
  const plan = testPlan();
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    // This test-only fixture bypasses definition lineage triggers so this suite isolates the
    // control-plane functions. Published-definition conformance is covered independently.
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      `INSERT INTO public.proofstack_replay_plans (
        tenant_id, project_id, environment_id, plan_id, plan_version_id,
        schema_version, definition_sha256, target_id, target_release_id,
        target_definition_sha256, target_adapter_name, target_adapter_version,
        target_adapter_protocol_version, worker_protocol_name, worker_protocol_version,
        dataset_id, dataset_version_id, dataset_definition_sha256, runtime_profile_id,
        runtime_profile_version, runtime_profile_definition_sha256, isolation_profile_id,
        isolation_profile_version, isolation_profile_definition_sha256, boundary_count,
        retry_automatic, retry_max_attempts, retry_per_attempt_timeout_milliseconds,
        retry_total_deadline_milliseconds, created_at, created_at_lexical,
        created_by_principal_id, plan
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
        $29, $30::timestamptz, $31, $32, $33::jsonb
      )`,
      [
        tenantId,
        projectId,
        environmentId,
        planId,
        planVersionId,
        plan.schemaVersion,
        plan.definitionSha256,
        plan.targetRelease.targetId,
        plan.targetRelease.targetReleaseId,
        plan.targetRelease.definitionSha256,
        plan.targetRelease.targetAdapter.name,
        plan.targetRelease.targetAdapter.version,
        plan.targetRelease.targetAdapter.protocolVersion,
        plan.workerProtocol.name,
        plan.workerProtocol.version,
        plan.dataset.datasetId,
        plan.dataset.datasetVersionId,
        plan.dataset.definitionSha256,
        plan.runtimeProfile.id,
        plan.runtimeProfile.version,
        plan.runtimeProfile.definitionSha256,
        plan.isolationProfile.id,
        plan.isolationProfile.version,
        plan.isolationProfile.definitionSha256,
        plan.boundaries.length,
        plan.retryPolicy.automatic,
        plan.retryPolicy.maxAttempts,
        plan.retryPolicy.perAttemptTimeoutMilliseconds,
        plan.retryPolicy.totalDeadlineMilliseconds,
        plan.createdAt,
        plan.createdAt,
        plan.createdByPrincipalId,
        JSON.stringify(plan),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createJob(
  client: PoolClient,
  jobId: string,
  exactPlanVersionId = planVersionId,
  exactPlanDefinitionSha256 = planDefinitionSha256,
) {
  return client.query<{ readonly created: boolean; readonly job: unknown }>(
    `SELECT * FROM public.proofstack_create_replay_job($1, $2, $3, $4, $5, $6, $7)`,
    [
      projectId,
      environmentId,
      jobId,
      planId,
      exactPlanVersionId,
      exactPlanDefinitionSha256,
      "usr_control_operator",
    ],
  );
}

async function requestCancellation(client: PoolClient, jobId: string, reason: string) {
  return client.query<{
    readonly created: boolean;
    readonly job: unknown;
    readonly request: unknown;
  }>(
    `SELECT * FROM public.proofstack_request_replay_cancellation(
      $1, $2, $3, $4, $5, $6, $7
    )`,
    [
      projectId,
      environmentId,
      jobId,
      `can_${jobId}`,
      "operator_request",
      reason,
      "usr_control_operator",
    ],
  );
}

async function insertConflictingIntent(eventType: string, jobId: string): Promise<void> {
  await adminPool.query(
    `INSERT INTO public.proofstack_outbox (
      tenant_id, event_type, aggregate_type, aggregate_id, schema_version, payload, created_at
    ) VALUES ($1, $2, 'replay.job', $3, '0.1', '{"conflict":true}'::jsonb, clock_timestamp())`,
    [tenantId, eventType, jobId],
  );
}

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, credentials);
  await seedExactPlan();
});

afterAll(async () => {
  await apiPool.end();
  await adminPool.query(`TRUNCATE TABLE
    public.proofstack_replay_jobs,
    public.proofstack_replay_plans,
    public.proofstack_outbox
    RESTART IDENTITY CASCADE`);
  for (const role of Object.values(credentials)) {
    const exists = await adminPool.query<{ readonly present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present",
      [role.name],
    );
    if (exists.rows[0]?.present) {
      await adminPool.query(`DROP OWNED BY "${role.name}"`);
      await adminPool.query(`DROP ROLE "${role.name}"`);
    }
  }
  await adminPool.end();
});

describe("replay job control-plane authority", () => {
  it("creates and cancels an exact-plan job with server-owned state and intents", async () => {
    const jobId = `job_control_happy_${runKey}`;
    const recoveryEpoch = await adminPool.query<{ readonly recovery_epoch: string }>(
      "SELECT recovery_epoch::text FROM public.proofstack_recovery_state WHERE singleton = true",
    );
    const first = await withTenantTransaction(apiPool, tenantId, (client) =>
      createJob(client, jobId),
    );
    expect(first.rows[0]?.created).toBe(true);
    const createdJob = ReplayJobSchema.parse(first.rows[0]?.job);
    expect(createdJob).toMatchObject({
      jobId,
      lastFencingToken: 0,
      recoveryEpoch: Number(recoveryEpoch.rows[0]?.recovery_epoch),
      stateVersion: 1,
      status: "queued",
    });
    expect(Math.abs(Date.now() - Date.parse(createdJob.createdAt))).toBeLessThan(30_000);

    const retry = await withTenantTransaction(apiPool, tenantId, (client) =>
      createJob(client, jobId),
    );
    expect(retry.rows[0]).toEqual({ created: false, job: first.rows[0]?.job });

    const reason = "Stop this queued replay before any target execution.";
    const cancelled = await withTenantTransaction(apiPool, tenantId, (client) =>
      requestCancellation(client, jobId, reason),
    );
    expect(cancelled.rows[0]?.created).toBe(true);
    expect(ReplayJobSchema.parse(cancelled.rows[0]?.job)).toMatchObject({
      stateVersion: 2,
      status: "cancelled",
      terminal: { code: "cancellation_committed", status: "cancelled" },
    });
    expect(ReplayCancellationRequestSchema.parse(cancelled.rows[0]?.request)).toMatchObject({
      jobId,
      reason,
      reasonCode: "operator_request",
    });

    const cancellationRetry = await withTenantTransaction(apiPool, tenantId, (client) =>
      requestCancellation(client, jobId, reason),
    );
    expect(cancellationRetry.rows[0]?.created).toBe(false);
    await expect(
      withTenantTransaction(apiPool, tenantId, (client) =>
        requestCancellation(client, jobId, "A conflicting immutable reason."),
      ),
    ).rejects.toMatchObject({ code: "23505" });

    const intents = await adminPool.query<{ readonly event_type: string }>(
      `SELECT event_type
       FROM public.proofstack_outbox
       WHERE tenant_id = $1 AND aggregate_id = $2
       ORDER BY event_type COLLATE "C"`,
      [tenantId, jobId],
    );
    expect(intents.rows.map(({ event_type }) => event_type)).toEqual([
      "replay.job.cancellation-requested",
      "replay.job.created",
      "replay.job.terminal",
    ]);
  });

  it("rolls back job and cancellation rows when an outbox intent conflicts", async () => {
    const createFailureJobId = `job_control_create_fail_${runKey}`;
    await insertConflictingIntent("replay.job.created", createFailureJobId);
    await expect(
      withTenantTransaction(apiPool, tenantId, (client) => createJob(client, createFailureJobId)),
    ).rejects.toMatchObject({ code: "23505" });
    const absentJob = await adminPool.query<{ readonly count: number }>(
      `SELECT count(*)::integer AS count
       FROM public.proofstack_replay_jobs
       WHERE tenant_id = $1 AND job_id = $2`,
      [tenantId, createFailureJobId],
    );
    expect(absentJob.rows).toEqual([{ count: 0 }]);

    const cancelFailureJobId = `job_control_cancel_fail_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) =>
      createJob(client, cancelFailureJobId),
    );
    await insertConflictingIntent("replay.job.cancellation-requested", cancelFailureJobId);
    await expect(
      withTenantTransaction(apiPool, tenantId, (client) =>
        requestCancellation(client, cancelFailureJobId, "Exercise cancellation rollback."),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const rolledBack = await adminPool.query<{
      readonly request_count: number;
      readonly status: string;
    }>(
      `SELECT job.status, count(request.cancellation_id)::integer AS request_count
       FROM public.proofstack_replay_jobs AS job
       LEFT JOIN public.proofstack_replay_cancellation_requests AS request
         ON request.tenant_id = job.tenant_id AND request.job_id = job.job_id
       WHERE job.tenant_id = $1 AND job.job_id = $2
       GROUP BY job.status`,
      [tenantId, cancelFailureJobId],
    );
    expect(rolledBack.rows).toEqual([{ request_count: 0, status: "queued" }]);
  });

  it("denies direct ledger writes and missing or cross-scope control requests", async () => {
    await expect(
      withTenantTransaction(apiPool, tenantId, async (client) => {
        await client.query(
          "SELECT set_config('proofstack.replay_job_writer', 'stored-function-v1', true)",
        );
        return client.query("INSERT INTO public.proofstack_replay_jobs (tenant_id) VALUES ($1)", [
          tenantId,
        ]);
      }),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      withTenantTransaction(apiPool, tenantId, (client) =>
        client.query(
          `INSERT INTO public.proofstack_outbox (
            tenant_id, event_type, aggregate_type, aggregate_id,
            schema_version, payload, created_at
          ) VALUES (
            $1, 'replay.job.terminal', 'replay.job', $2,
            '0.1', '{"forged":true}'::jsonb, clock_timestamp()
          )`,
          [tenantId, `job_control_forged_${runKey}`],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      withTenantTransaction(apiPool, tenantId, (client) =>
        createJob(client, `job_control_missing_plan_${runKey}`, `plv_control_missing_${runKey}`),
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      withTenantTransaction(apiPool, tenantId, (client) =>
        client.query(
          `SELECT * FROM public.proofstack_create_replay_job(
            NULL, $1, $2, $3, $4, $5, $6
          )`,
          [
            environmentId,
            `job_control_null_${runKey}`,
            planId,
            planVersionId,
            planDefinitionSha256,
            "usr_control_operator",
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });

    await expect(
      withTenantTransaction(apiPool, tenantId, (client) =>
        requestCancellation(client, `job_control_missing_${runKey}`, "No job should be disclosed."),
      ),
    ).rejects.toMatchObject({ code: "P0002" });

    const noTenantClient = await apiPool.connect();
    try {
      await expect(
        createJob(noTenantClient, `job_control_unscoped_${runKey}`),
      ).rejects.toMatchObject({ code: "22023" });
    } finally {
      noTenantClient.release();
    }
  });
});
