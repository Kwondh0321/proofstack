import {
  REPLAY_BUDGET_DIMENSIONS,
  ReplayAttemptSchema,
  ReplayBudgetReservationSchema,
  ReplayCancellationAcknowledgementSchema,
  ReplayCancellationRequestSchema,
  ReplayJobSchema,
  ReplayWorkerMutationFenceSchema,
  type WorkerProtocolReference,
} from "@proofstack/contracts";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
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
const tenantId = `ten_worker_${runKey}`;
const projectId = `prj_worker_${runKey}`;
const environmentId = `env_worker_${runKey}`;
const planId = `plan_worker_${runKey}`;
const planVersionId = `plv_worker_${runKey}`;
const planDefinitionSha256 = "1".repeat(64);
const workerProtocol = { name: "proofstack.replay-worker", version: "1.0.0" } as const;
const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });

function resultArtifact() {
  return {
    artifactId: `art_worker_result_${runKey}`,
    classification: "confidential",
    mediaType: "application/json",
    sha256: "7".repeat(64),
    sizeBytes: 18,
  } as const;
}

const credentials = {
  api: {
    name: `ps_worker_api_${runKey}`,
    password: `proofstack-worker-api-${runKey}`,
  },
  artifact: {
    name: `ps_worker_art_${runKey}`,
    password: `proofstack-worker-artifact-${runKey}`,
  },
  consumer: {
    name: `ps_worker_con_${runKey}`,
    password: `proofstack-worker-consumer-${runKey}`,
  },
  identity: {
    name: `ps_worker_id_${runKey}`,
    password: `proofstack-worker-identity-${runKey}`,
  },
  publisher: {
    name: `ps_worker_pub_${runKey}`,
    password: `proofstack-worker-publisher-${runKey}`,
  },
  replayWorker: {
    name: `ps_worker_run_${runKey}`,
    password: `proofstack-worker-runtime-${runKey}`,
  },
} as const satisfies RuntimeRoleProvisioningOptions;

function connectionStringFor(role: RuntimeRoleCredentials): string {
  const url = new URL(databaseUrl as string);
  url.username = role.name;
  url.password = role.password;
  return url.toString();
}

const apiPool = new Pool({ connectionString: connectionStringFor(credentials.api), max: 4 });
const workerPool = new Pool({
  connectionString: connectionStringFor(credentials.replayWorker),
  max: 4,
});

function testPlan() {
  const createdAt = "2026-08-29T10:00:00.000Z";
  return {
    boundaries: [{}],
    budget: {
      concurrentInteractions: { limit: 4, measurement: "measured" },
      elapsedMilliseconds: { limit: 20_000, measurement: "measured" },
      emittedArtifactBytes: { limit: 1_000_000, measurement: "measured" },
      inputTokens: { limit: 4_096, measurement: "estimated" },
      jobAttempts: { limit: 1, measurement: "measured" },
      modelRequests: { limit: 4, measurement: "measured" },
      outputTokens: { limit: 4_096, measurement: "provider_reported" },
      providerCostMicrounits: { limit: 1_000_000, measurement: "unavailable" },
      retrievedBytes: { limit: 1_000_000, measurement: "measured" },
      toolCalls: { limit: 4, measurement: "measured" },
    },
    createdAt,
    createdByPrincipalId: "usr_worker_seed",
    dataset: {
      datasetId: `dat_worker_${runKey}`,
      datasetVersionId: `dsv_worker_${runKey}`,
      definitionSha256: "2".repeat(64),
    },
    definitionSha256: planDefinitionSha256,
    isolationProfile: {
      definitionSha256: "3".repeat(64),
      id: "iso_worker",
      kind: "local_child_process",
      version: "1.0.0",
    },
    planId,
    planVersionId,
    retryPolicy: {
      automatic: false,
      maxAttempts: 1,
      perAttemptTimeoutMilliseconds: 2_000,
      totalDeadlineMilliseconds: 10_000,
    },
    runtimeProfile: {
      definitionSha256: "4".repeat(64),
      family: "node",
      id: "run_worker",
      version: "1.0.0",
    },
    schemaVersion: "0.1",
    scope: { environmentId, projectId, tenantId },
    targetRelease: {
      definitionSha256: "5".repeat(64),
      targetAdapter: {
        name: "proofstack.worker_test",
        protocolVersion: "1.0.0",
        version: "1.0.0",
      },
      targetId: `target_worker_${runKey}`,
      targetReleaseId: `trg_worker_${runKey}`,
      workerProtocol,
    },
    workerProtocol,
  } as const;
}

async function seedExactPlan(): Promise<void> {
  const plan = testPlan();
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    // This test fixture bypasses definition lineage triggers only to isolate worker authority.
    // Published-definition conformance is covered by the definition repository integration suite.
    await client.query("SET LOCAL session_replication_role = 'replica'");
    const release = {
      build: { provenance: { artifactId: `art_worker_${runKey}` } },
      createdAt: plan.createdAt,
      createdByPrincipalId: plan.createdByPrincipalId,
      definitionSha256: plan.targetRelease.definitionSha256,
      execution: { kind: "preinstalled" },
      outputLimits: {
        emittedArtifactBytes: 1_000_000,
        stderrBytes: 100_000,
        stdoutBytes: 100_000,
      },
      schemaVersion: "0.1",
      scope: plan.scope,
      targetAdapter: plan.targetRelease.targetAdapter,
      targetId: plan.targetRelease.targetId,
      targetReleaseId: plan.targetRelease.targetReleaseId,
      workerProtocol: plan.targetRelease.workerProtocol,
    };
    await client.query(
      `INSERT INTO public.proofstack_target_releases (
        tenant_id, project_id, environment_id, target_id, target_release_id,
        schema_version, definition_sha256, target_adapter_name, target_adapter_version,
        target_adapter_protocol_version, worker_protocol_name, worker_protocol_version,
        execution_kind, provenance_artifact_id, execution_artifact_id,
        emitted_artifact_bytes, stderr_bytes, stdout_bytes, created_at, created_at_lexical,
        created_by_principal_id, release
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL,
        $15, $16, $17, $18::timestamptz, $19, $20, $21::jsonb
      )`,
      [
        tenantId,
        projectId,
        environmentId,
        plan.targetRelease.targetId,
        plan.targetRelease.targetReleaseId,
        release.schemaVersion,
        plan.targetRelease.definitionSha256,
        plan.targetRelease.targetAdapter.name,
        plan.targetRelease.targetAdapter.version,
        plan.targetRelease.targetAdapter.protocolVersion,
        plan.targetRelease.workerProtocol.name,
        plan.targetRelease.workerProtocol.version,
        release.execution.kind,
        release.build.provenance.artifactId,
        release.outputLimits.emittedArtifactBytes,
        release.outputLimits.stderrBytes,
        release.outputLimits.stdoutBytes,
        release.createdAt,
        release.createdAt,
        release.createdByPrincipalId,
        JSON.stringify(release),
      ],
    );
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
    await client.query(
      `INSERT INTO public.proofstack_replay_plan_budgets (
        tenant_id, project_id, environment_id, plan_id, plan_version_id,
        dimension, limit_value, measurement
      )
      SELECT $1, $2, $3, $4, $5, budget.key,
        (budget.value ->> 'limit')::bigint,
        budget.value ->> 'measurement'
      FROM jsonb_each($6::jsonb) AS budget(key, value)`,
      [tenantId, projectId, environmentId, planId, planVersionId, JSON.stringify(plan.budget)],
    );
    const result = resultArtifact();
    await client.query(
      `INSERT INTO public.proofstack_artifact_catalog (
        tenant_id, project_id, environment_id, artifact_id, schema_version, state,
        classification, media_type, content_sha256, content_size_bytes, redaction,
        retention_mode, expires_at, created_at, available_at, created_by_principal_id,
        object_key, encryption_version, content_nonce, wrapped_key_algorithm,
        wrapped_key_id, wrapped_key_ciphertext, wrapped_key_nonce, wrapped_key_tag,
        object_receipt_sha256, object_receipt_size_bytes
      ) VALUES (
        $1, $2, $3, $4, '0.1', 'available', $5, $6, $7, $8,
        '{"status":"not_required"}'::jsonb, 'retain', NULL,
        $9::timestamptz, $10::timestamptz, 'usr_worker_seed', $11,
        'a256gcm-v1', 'AQEBAQEBAQEBAQEB', 'A256GCM', 'key_worker_result',
        'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', 'AgICAgICAgICAgIC',
        'AwMDAwMDAwMDAwMDAwMDAw', $12, $13
      )`,
      [
        tenantId,
        projectId,
        environmentId,
        result.artifactId,
        result.classification,
        result.mediaType,
        result.sha256,
        result.sizeBytes,
        plan.createdAt,
        "2026-08-29T10:00:01.000Z",
        `objects/v1/worker/${runKey}/result`,
        "8".repeat(64),
        result.sizeBytes + 20,
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

async function createJob(client: PoolClient, jobId: string) {
  return client.query<{ readonly created: boolean; readonly job: unknown }>(
    "SELECT * FROM public.proofstack_create_replay_job($1, $2, $3, $4, $5, $6, $7)",
    [
      projectId,
      environmentId,
      jobId,
      planId,
      planVersionId,
      planDefinitionSha256,
      "usr_worker_operator",
    ],
  );
}

interface ClaimRow extends QueryResultRow {
  readonly attempt: unknown;
  readonly claimed: boolean;
  readonly job: unknown;
  readonly reason: string | null;
  readonly worker_fence: unknown;
}

async function claimJob(
  client: PoolClient,
  jobId: string,
  attemptId: string,
  leaseId: string,
  protocol: WorkerProtocolReference = workerProtocol,
  leaseDurationMilliseconds = 1_500,
) {
  return client.query<ClaimRow>(
    `SELECT * FROM public.proofstack_claim_replay_job(
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
    )`,
    [
      projectId,
      environmentId,
      jobId,
      attemptId,
      leaseId,
      `worker_${runKey}`,
      protocol.name,
      protocol.version,
      "6".repeat(64),
      leaseDurationMilliseconds,
    ],
  );
}

async function heartbeatJob(
  client: PoolClient,
  fence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>,
  leaseDurationMilliseconds = 1_500,
) {
  return client.query<{ readonly job: unknown }>(
    `SELECT public.proofstack_heartbeat_replay_job(
      $1, $2, $3, $4, $5, $6, $7, $8, $9
    ) AS job`,
    [
      projectId,
      environmentId,
      fence.jobId,
      fence.attemptId,
      fence.leaseId,
      fence.workerId,
      fence.fencingToken,
      fence.recoveryEpoch,
      leaseDurationMilliseconds,
    ],
  );
}

async function requestCancellation(client: PoolClient, jobId: string, cancellationId: string) {
  return client.query<{ readonly request: unknown }>(
    `SELECT * FROM public.proofstack_request_replay_cancellation(
      $1, $2, $3, $4, 'operator_request', $5, 'usr_worker_operator'
    )`,
    [
      projectId,
      environmentId,
      jobId,
      cancellationId,
      "Stop the running replay before terminal completion.",
    ],
  );
}

async function acknowledgeCancellation(
  client: PoolClient,
  fence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>,
  acknowledgementId: string,
  action:
    | "observed_after_uninterruptible_completion"
    | "stop_requested"
    | "stopped_before_target_start" = "stopped_before_target_start",
) {
  return client.query<{ readonly acknowledgement: unknown; readonly created: boolean }>(
    `SELECT * FROM public.proofstack_acknowledge_replay_cancellation(
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
    )`,
    [
      projectId,
      environmentId,
      fence.jobId,
      fence.attemptId,
      fence.leaseId,
      fence.workerId,
      fence.fencingToken,
      fence.recoveryEpoch,
      acknowledgementId,
      action,
    ],
  );
}

function requestedAmounts(overrides: Readonly<Record<string, number>> = {}) {
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [dimension, overrides[dimension] ?? 0]),
  );
}

async function reserveBudget(
  client: PoolClient,
  fence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>,
  reservationId: string,
  requested: Readonly<Record<string, number>>,
  work: Readonly<Record<string, unknown>> = { kind: "attempt_start" },
) {
  return client.query<{ readonly created: boolean; readonly reservation: unknown }>(
    `SELECT * FROM public.proofstack_reserve_replay_budget(
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb
    )`,
    [
      projectId,
      environmentId,
      fence.jobId,
      fence.attemptId,
      fence.leaseId,
      fence.workerId,
      fence.fencingToken,
      fence.recoveryEpoch,
      reservationId,
      JSON.stringify(work),
      JSON.stringify(requested),
    ],
  );
}

async function completeJob(
  client: PoolClient,
  fence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>,
  options:
    | {
        readonly code: "completed";
        readonly result: unknown;
        readonly status: "succeeded";
      }
    | {
        readonly code: "execution_failed";
        readonly error: unknown;
        readonly status: "failed";
      }
    | {
        readonly code: "cancellation_committed";
        readonly error: unknown;
        readonly status: "cancelled";
      },
) {
  return client.query<{ readonly attempt: unknown; readonly job: unknown }>(
    `SELECT * FROM public.proofstack_complete_replay_job(
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb
    )`,
    [
      projectId,
      environmentId,
      fence.jobId,
      fence.attemptId,
      fence.leaseId,
      fence.workerId,
      fence.fencingToken,
      fence.recoveryEpoch,
      options.status,
      options.code,
      "error" in options ? JSON.stringify(options.error) : null,
      "result" in options ? JSON.stringify(options.result) : null,
    ],
  );
}

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, credentials);
  await seedExactPlan();
});

afterAll(async () => {
  await Promise.all([apiPool.end(), workerPool.end()]);
  await withTenantTransaction(adminPool, tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    for (const table of [
      "proofstack_replay_usage_measurements",
      "proofstack_replay_observations",
      "proofstack_replay_budget_entry_dimensions",
      "proofstack_replay_budget_entries",
      "proofstack_replay_cancellation_acknowledgements",
      "proofstack_replay_cancellation_requests",
      "proofstack_replay_attempt_events",
      "proofstack_replay_attempts",
      "proofstack_replay_jobs",
      "proofstack_replay_plan_boundaries",
      "proofstack_replay_plan_budgets",
      "proofstack_replay_plan_resources",
      "proofstack_replay_plans",
      "proofstack_target_releases",
      "proofstack_outbox",
      "proofstack_artifact_catalog",
    ] as const) {
      await client.query(`DELETE FROM public.${table} WHERE tenant_id = $1`, [tenantId]);
    }
  });
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

describe("replay worker lease authority", () => {
  it("claims a queued job and heartbeats its exact current fence using server time", async () => {
    const jobId = `job_worker_happy_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, jobId));

    const claimed = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(client, jobId, `att_worker_happy_${runKey}`, `lease_worker_happy_${runKey}`),
    );
    expect(claimed.rows).toHaveLength(1);
    const row = claimed.rows[0];
    if (!row) throw new Error("Replay claim did not return a row");
    const job = ReplayJobSchema.parse(row.job);
    const attempt = ReplayAttemptSchema.parse(row.attempt);
    const fence = ReplayWorkerMutationFenceSchema.parse(row.worker_fence);
    expect(row.claimed).toBe(true);
    expect(row.reason).toBeNull();
    expect(job).toMatchObject({
      jobId,
      lastFencingToken: 1,
      latestAttemptSequence: 0,
      stateVersion: 2,
      status: "running",
    });
    expect(attempt).toMatchObject({
      attemptId: fence.attemptId,
      attemptSequence: 0,
      jobId,
      status: "running",
      workerProtocol,
    });
    expect(Date.parse(job.currentLease?.expiresAt ?? "")).toBe(
      Date.parse(job.currentLease?.heartbeatAt ?? "") + 1_500,
    );

    const heartbeat = await withTenantTransaction(workerPool, tenantId, (client) =>
      heartbeatJob(client, fence),
    );
    const heartbeatJobValue = ReplayJobSchema.parse(heartbeat.rows[0]?.job);
    expect(heartbeatJobValue.stateVersion).toBe(3);
    expect(heartbeatJobValue.currentLease?.mutationFence).toEqual(fence);
    expect(Date.parse(heartbeatJobValue.currentLease?.expiresAt ?? "")).toBe(
      Date.parse(heartbeatJobValue.currentLease?.heartbeatAt ?? "") + 1_500,
    );

    const stored = await adminPool.query<{
      readonly attempt_count: number;
      readonly state_version: string;
    }>(
      `SELECT job.state_version::text, count(attempt.attempt_id)::integer AS attempt_count
       FROM public.proofstack_replay_jobs AS job
       LEFT JOIN public.proofstack_replay_attempts AS attempt
         ON attempt.tenant_id = job.tenant_id AND attempt.job_id = job.job_id
       WHERE job.tenant_id = $1 AND job.job_id = $2
       GROUP BY job.state_version`,
      [tenantId, jobId],
    );
    expect(stored.rows).toEqual([{ attempt_count: 1, state_version: "3" }]);
  });

  it("reserves exact-plan budget through the current live worker fence", async () => {
    const jobId = `job_worker_reserve_${runKey}`;
    const reservationId = `res_worker_reserve_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, jobId));
    const claimed = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(
        client,
        jobId,
        `att_worker_reserve_${runKey}`,
        `lease_worker_reserve_${runKey}`,
        workerProtocol,
        2_000,
      ),
    );
    const attempt = ReplayAttemptSchema.parse(claimed.rows[0]?.attempt);
    const fence = ReplayWorkerMutationFenceSchema.parse(claimed.rows[0]?.worker_fence);
    const requested = requestedAmounts({ inputTokens: 10, jobAttempts: 1 });

    await expect(
      withTenantTransaction(apiPool, tenantId, (client) =>
        reserveBudget(client, fence, reservationId, requested),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        reserveBudget(client, { ...fence, fencingToken: 2 }, reservationId, requested),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        reserveBudget(client, fence, reservationId, requestedAmounts()),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        reserveBudget(client, fence, reservationId, requested, {
          boundaryId: `bnd_worker_missing_${runKey}`,
          boundaryKind: "retrieval",
          kind: "boundary_call",
        }),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await withTenantTransaction(workerPool, tenantId, (client) =>
      heartbeatJob(client, fence, 2_000),
    );

    const reserved = await withTenantTransaction(workerPool, tenantId, (client) =>
      reserveBudget(client, fence, reservationId, requested),
    );
    const reservation = ReplayBudgetReservationSchema.parse(reserved.rows[0]?.reservation);
    expect(reserved.rows[0]?.created).toBe(true);
    expect(reservation).toMatchObject({
      ledgerSequence: 0,
      mutationFence: fence,
      reservationId,
      scope: { environmentId, projectId, tenantId },
      work: { kind: "attempt_start" },
    });
    expect(reservation.dimensions.inputTokens).toEqual({
      committedBefore: 0,
      limit: 4_096,
      measurement: "estimated",
      reservedAmount: 10,
    });
    expect(Date.parse(reservation.reservedAt)).toBeGreaterThanOrEqual(
      Date.parse(attempt.startedAt),
    );

    const retried = await withTenantTransaction(workerPool, tenantId, (client) =>
      reserveBudget(client, fence, reservationId, requested),
    );
    expect(retried.rows).toEqual([{ created: false, reservation }]);
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        reserveBudget(
          client,
          fence,
          reservationId,
          requestedAmounts({ inputTokens: 11, jobAttempts: 1 }),
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await withTenantTransaction(workerPool, tenantId, (client) =>
      heartbeatJob(client, fence, 2_000),
    );
    const concurrentReservations = await Promise.all([
      withTenantTransaction(workerPool, tenantId, (client) =>
        reserveBudget(
          client,
          fence,
          `res_worker_parallel_a_${runKey}`,
          requestedAmounts({ toolCalls: 1 }),
        ),
      ),
      withTenantTransaction(workerPool, tenantId, (client) =>
        reserveBudget(
          client,
          fence,
          `res_worker_parallel_b_${runKey}`,
          requestedAmounts({ toolCalls: 1 }),
        ),
      ),
    ]);
    const serialized = concurrentReservations
      .map((result) => ReplayBudgetReservationSchema.parse(result.rows[0]?.reservation))
      .sort((left, right) => left.ledgerSequence - right.ledgerSequence);
    expect(serialized.map(({ ledgerSequence }) => ledgerSequence)).toEqual([1, 2]);
    expect(serialized.map(({ dimensions }) => dimensions.toolCalls.committedBefore)).toEqual([
      0, 1,
    ]);

    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        reserveBudget(
          client,
          fence,
          `res_worker_limit_${runKey}`,
          requestedAmounts({ toolCalls: 5 }),
        ),
      ),
    ).rejects.toMatchObject({ code: "22003" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        completeJob(client, fence, {
          code: "completed",
          result: resultArtifact(),
          status: "succeeded",
        }),
      ),
    ).rejects.toMatchObject({ code: "55000" });

    const normalized = await adminPool.query<{
      readonly dimension_count: number;
      readonly input_measurement: string;
    }>(
      `SELECT
         count(*)::integer AS dimension_count,
         max(measurement) FILTER (WHERE dimension = 'inputTokens') AS input_measurement
       FROM public.proofstack_replay_budget_entry_dimensions
       WHERE tenant_id = $1 AND job_id = $2 AND ledger_sequence = 0`,
      [tenantId, jobId],
    );
    expect(normalized.rows).toEqual([{ dimension_count: 10, input_measurement: "estimated" }]);
  });

  it("rejects caller-authored lineage, excessive leases, null input, and stale fences", async () => {
    const lineageJobId = `job_worker_lineage_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, lineageJobId));
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        claimJob(client, lineageJobId, `att_worker_bad_${runKey}`, `lease_worker_bad_${runKey}`, {
          name: workerProtocol.name,
          version: "2.0.0",
        }),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        claimJob(
          client,
          lineageJobId,
          `att_worker_long_${runKey}`,
          `lease_worker_long_${runKey}`,
          workerProtocol,
          2_001,
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        client.query(
          `SELECT * FROM public.proofstack_claim_replay_job(
            $1, $2, $3, NULL, $4, $5, $6, $7, $8, $9
          )`,
          [
            projectId,
            environmentId,
            lineageJobId,
            `lease_worker_null_${runKey}`,
            `worker_${runKey}`,
            workerProtocol.name,
            workerProtocol.version,
            "6".repeat(64),
            1_500,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });

    const claimed = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(client, lineageJobId, `att_worker_valid_${runKey}`, `lease_worker_valid_${runKey}`),
    );
    const fence = ReplayWorkerMutationFenceSchema.parse(claimed.rows[0]?.worker_fence);
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        acknowledgeCancellation(client, fence, `ack_worker_missing_${runKey}`),
      ),
    ).rejects.toMatchObject({ code: "P0002" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        heartbeatJob(client, { ...fence, fencingToken: fence.fencingToken + 1 }),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) => heartbeatJob(client, fence, 2_001)),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("serializes concurrent claims so exactly one worker receives the first fence", async () => {
    const jobId = `job_worker_race_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, jobId));

    const outcomes = await Promise.allSettled([
      withTenantTransaction(workerPool, tenantId, (client) =>
        claimJob(client, jobId, `att_worker_race_a_${runKey}`, `lease_worker_race_a_${runKey}`),
      ),
      withTenantTransaction(workerPool, tenantId, (client) =>
        claimJob(client, jobId, `att_worker_race_b_${runKey}`, `lease_worker_race_b_${runKey}`),
      ),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "55000" } });

    const stored = await adminPool.query<{
      readonly attempt_count: number;
      readonly last_fencing_token: string;
      readonly state_version: string;
    }>(
      `SELECT
         job.last_fencing_token::text,
         job.state_version::text,
         count(attempt.attempt_id)::integer AS attempt_count
       FROM public.proofstack_replay_jobs AS job
       LEFT JOIN public.proofstack_replay_attempts AS attempt
         ON attempt.tenant_id = job.tenant_id AND attempt.job_id = job.job_id
       WHERE job.tenant_id = $1 AND job.job_id = $2
       GROUP BY job.last_fencing_token, job.state_version`,
      [tenantId, jobId],
    );
    expect(stored.rows).toEqual([
      { attempt_count: 1, last_fencing_token: "1", state_version: "2" },
    ]);
  });

  it("permits one guarded attempt closure and preserves both immutable history states", async () => {
    const jobId = `job_worker_history_${runKey}`;
    const attemptId = `att_worker_history_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, jobId));
    const claimed = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(client, jobId, attemptId, `lease_worker_history_${runKey}`),
    );
    const runningAttempt = ReplayAttemptSchema.parse(claimed.rows[0]?.attempt);
    const endedAt = new Date(Date.parse(runningAttempt.startedAt) + 1).toISOString();
    const closedAttempt = ReplayAttemptSchema.parse({
      ...runningAttempt,
      endedAt,
      error: {
        code: "worker_internal_error",
        effectCertainty: "none",
        message: "The isolated worker stopped before producing a result.",
      },
      retryDisposition: "not_retryable",
      status: "failed",
    });

    await expect(
      withTenantTransaction(adminPool, tenantId, (client) =>
        client.query(
          `UPDATE public.proofstack_replay_attempts
           SET status = 'failed', ended_at = $3::timestamptz, ended_at_lexical = $4,
             retry_disposition = 'not_retryable', error_code = 'worker_internal_error',
             effect_certainty = 'none', attempt = $5::jsonb
           WHERE tenant_id = $1 AND attempt_id = $2`,
          [tenantId, attemptId, endedAt, endedAt, JSON.stringify(closedAttempt)],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      withTenantTransaction(adminPool, tenantId, async (client) => {
        await client.query(
          "SELECT set_config('proofstack.replay_attempt_writer', 'stored-function-v1', true)",
        );
        return client.query(
          `UPDATE public.proofstack_replay_attempts
           SET worker_id = $3, status = 'failed', ended_at = $4::timestamptz,
             ended_at_lexical = $5, retry_disposition = 'not_retryable',
             error_code = 'worker_internal_error', effect_certainty = 'none',
             attempt = $6::jsonb
           WHERE tenant_id = $1 AND attempt_id = $2`,
          [
            tenantId,
            attemptId,
            `worker_changed_${runKey}`,
            endedAt,
            endedAt,
            JSON.stringify(closedAttempt),
          ],
        );
      }),
    ).rejects.toMatchObject({ code: "42501" });

    await withTenantTransaction(adminPool, tenantId, async (client) => {
      await client.query(
        "SELECT set_config('proofstack.replay_attempt_writer', 'stored-function-v1', true)",
      );
      await client.query(
        `UPDATE public.proofstack_replay_attempts
         SET status = 'failed', ended_at = $3::timestamptz, ended_at_lexical = $4,
           retry_disposition = 'not_retryable', error_code = 'worker_internal_error',
           effect_certainty = 'none', attempt = $5::jsonb
         WHERE tenant_id = $1 AND attempt_id = $2`,
        [tenantId, attemptId, endedAt, endedAt, JSON.stringify(closedAttempt)],
      );
    });

    await expect(
      withTenantTransaction(adminPool, tenantId, async (client) => {
        await client.query(
          "SELECT set_config('proofstack.replay_attempt_writer', 'stored-function-v1', true)",
        );
        return client.query(
          `UPDATE public.proofstack_replay_attempts
           SET ended_at = ended_at
           WHERE tenant_id = $1 AND attempt_id = $2`,
          [tenantId, attemptId],
        );
      }),
    ).rejects.toMatchObject({ code: "42501" });

    const history = await withTenantTransaction(adminPool, tenantId, (client) =>
      client.query<{
        readonly event: unknown;
        readonly event_type: string;
        readonly status: string;
        readonly transition_sequence: string;
      }>(
        `SELECT event_type, status, transition_sequence::text, event
         FROM public.proofstack_replay_attempt_events
         WHERE tenant_id = $1 AND attempt_id = $2
         ORDER BY transition_sequence`,
        [tenantId, attemptId],
      ),
    );
    expect(
      history.rows.map(({ event_type, status, transition_sequence }) => ({
        event_type,
        status,
        transition_sequence,
      })),
    ).toEqual([
      { event_type: "attempt_claimed", status: "running", transition_sequence: "0" },
      { event_type: "attempt_closed", status: "failed", transition_sequence: "1" },
    ]);
    expect(history.rows[0]?.event).toMatchObject({ attempt: runningAttempt });
    expect(history.rows[1]?.event).toMatchObject({ attempt: closedAttempt });

    await expect(
      withTenantTransaction(adminPool, tenantId, (client) =>
        client.query(
          `UPDATE public.proofstack_replay_attempt_events
           SET status = status
           WHERE tenant_id = $1 AND attempt_id = $2`,
          [tenantId, attemptId],
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        client.query(
          `SELECT * FROM public.proofstack_replay_attempt_events
           WHERE tenant_id = $1 AND attempt_id = $2`,
          [tenantId, attemptId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("atomically completes the current fence with one exact available result artifact", async () => {
    const jobId = `job_worker_complete_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, jobId));
    const claimed = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(client, jobId, `att_worker_complete_${runKey}`, `lease_worker_complete_${runKey}`),
    );
    const fence = ReplayWorkerMutationFenceSchema.parse(claimed.rows[0]?.worker_fence);
    const completed = await withTenantTransaction(workerPool, tenantId, (client) =>
      completeJob(client, fence, {
        code: "completed",
        result: resultArtifact(),
        status: "succeeded",
      }),
    );
    const job = ReplayJobSchema.parse(completed.rows[0]?.job);
    const attempt = ReplayAttemptSchema.parse(completed.rows[0]?.attempt);
    expect(job).toMatchObject({
      jobId,
      stateVersion: 3,
      status: "succeeded",
      terminal: {
        attemptId: fence.attemptId,
        code: "completed",
        status: "succeeded",
      },
    });
    expect(job.currentLease).toBeUndefined();
    expect(attempt).toMatchObject({
      attemptId: fence.attemptId,
      result: resultArtifact(),
      retryDisposition: "not_retryable",
      status: "succeeded",
    });
    expect(attempt.endedAt).toBe(job.terminal?.committedAt);

    const durable = await adminPool.query<{
      readonly event_types: string[];
      readonly outbox_created_at: string;
      readonly outbox_payload: unknown;
    }>(
      `SELECT
         ARRAY_AGG(event.event_type ORDER BY event.transition_sequence) AS event_types,
         to_char(intent.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           AS outbox_created_at,
         intent.payload AS outbox_payload
       FROM public.proofstack_replay_attempt_events AS event
       JOIN public.proofstack_outbox AS intent
         ON intent.tenant_id = event.tenant_id
        AND intent.aggregate_id = event.job_id
        AND intent.event_type = 'replay.job.terminal'
       WHERE event.tenant_id = $1 AND event.job_id = $2
       GROUP BY intent.created_at, intent.payload`,
      [tenantId, jobId],
    );
    expect(durable.rows).toEqual([
      {
        event_types: ["attempt_claimed", "attempt_closed"],
        outbox_created_at: job.terminal?.committedAt,
        outbox_payload: {
          code: "completed",
          environmentId,
          jobId,
          projectId,
          stateVersion: 3,
          status: "succeeded",
        },
      },
    ]);

    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        completeJob(client, fence, {
          code: "completed",
          result: resultArtifact(),
          status: "succeeded",
        }),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      withTenantTransaction(apiPool, tenantId, (client) =>
        completeJob(client, fence, {
          code: "completed",
          result: resultArtifact(),
          status: "succeeded",
        }),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("makes acknowledged cancellation win the terminal commit", async () => {
    const jobId = `job_worker_cancel_${runKey}`;
    const cancellationId = `can_worker_cancel_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, jobId));
    const claimed = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(
        client,
        jobId,
        `att_worker_cancel_${runKey}`,
        `lease_worker_cancel_${runKey}`,
        workerProtocol,
        2_000,
      ),
    );
    const fence = ReplayWorkerMutationFenceSchema.parse(claimed.rows[0]?.worker_fence);
    const cancellation = await withTenantTransaction(apiPool, tenantId, (client) =>
      requestCancellation(client, jobId, cancellationId),
    );
    const request = ReplayCancellationRequestSchema.parse(cancellation.rows[0]?.request);
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        reserveBudget(
          client,
          fence,
          `res_worker_cancel_${runKey}`,
          requestedAmounts({ toolCalls: 1 }),
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    const cancellationError = {
      code: "cancelled",
      effectCertainty: "none",
      message: "Cancellation stopped the bounded worker.",
    } as const;

    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        completeJob(client, fence, {
          code: "execution_failed",
          error: {
            code: "worker_internal_error",
            effectCertainty: "none",
            message: "The worker tried to ignore the cancellation request.",
          },
          status: "failed",
        }),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        completeJob(client, fence, {
          code: "cancellation_committed",
          error: cancellationError,
          status: "cancelled",
        }),
      ),
    ).rejects.toMatchObject({ code: "55000" });

    const acknowledgementId = `ack_worker_cancel_${runKey}`;
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        acknowledgeCancellation(client, { ...fence, fencingToken: 2 }, acknowledgementId),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    const acknowledged = await withTenantTransaction(workerPool, tenantId, (client) =>
      acknowledgeCancellation(client, fence, acknowledgementId),
    );
    const acknowledgement = ReplayCancellationAcknowledgementSchema.parse(
      acknowledged.rows[0]?.acknowledgement,
    );
    expect(acknowledged.rows[0]?.created).toBe(true);
    expect(acknowledgement).toMatchObject({
      acknowledgementId,
      action: "stopped_before_target_start",
      cancellationId,
      mutationFence: fence,
    });
    expect(Date.parse(acknowledgement.acknowledgedAt)).toBeGreaterThanOrEqual(
      Date.parse(request.requestedAt),
    );
    const retried = await withTenantTransaction(workerPool, tenantId, (client) =>
      acknowledgeCancellation(client, fence, acknowledgementId),
    );
    expect(retried.rows).toEqual([{ acknowledgement, created: false }]);
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        acknowledgeCancellation(client, fence, acknowledgementId, "stop_requested"),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      withTenantTransaction(apiPool, tenantId, (client) =>
        acknowledgeCancellation(client, fence, `ack_worker_api_${runKey}`),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const completed = await withTenantTransaction(workerPool, tenantId, (client) =>
      completeJob(client, fence, {
        code: "cancellation_committed",
        error: cancellationError,
        status: "cancelled",
      }),
    );
    expect(ReplayJobSchema.parse(completed.rows[0]?.job).status).toBe("cancelled");
    expect(ReplayAttemptSchema.parse(completed.rows[0]?.attempt).status).toBe("cancelled");
  });

  it("rejects untrusted completion payloads and preserves state when terminal intent conflicts", async () => {
    const validationJobId = `job_worker_validate_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, validationJobId));
    const validationClaim = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(
        client,
        validationJobId,
        `att_worker_validate_${runKey}`,
        `lease_worker_validate_${runKey}`,
      ),
    );
    const validationFence = ReplayWorkerMutationFenceSchema.parse(
      validationClaim.rows[0]?.worker_fence,
    );
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        completeJob(client, validationFence, {
          code: "completed",
          result: { ...resultArtifact(), sizeBytes: 17 },
          status: "succeeded",
        }),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        completeJob(client, validationFence, {
          code: "execution_failed",
          error: {
            code: "worker_internal_error",
            effectCertainty: "none",
            forged: true,
            message: "The isolated worker stopped before producing a result.",
          },
          status: "failed",
        }),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        completeJob(client, validationFence, {
          code: "execution_failed",
          error: {
            code: "worker_internal_error",
            effectCertainty: "confirmed",
            effectRetrySafety: {},
            message: "The worker supplied incomplete retry-safety evidence.",
          },
          status: "failed",
        }),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        completeJob(
          client,
          { ...validationFence, fencingToken: 2 },
          {
            code: "execution_failed",
            error: {
              code: "worker_internal_error",
              effectCertainty: "none",
              message: "The isolated worker stopped before producing a result.",
            },
            status: "failed",
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    const failed = await withTenantTransaction(workerPool, tenantId, (client) =>
      completeJob(client, validationFence, {
        code: "execution_failed",
        error: {
          code: "worker_internal_error",
          effectCertainty: "none",
          message: "The isolated worker stopped before producing a result.",
        },
        status: "failed",
      }),
    );
    expect(ReplayJobSchema.parse(failed.rows[0]?.job).status).toBe("failed");
    expect(ReplayAttemptSchema.parse(failed.rows[0]?.attempt).status).toBe("failed");

    const conflictJobId = `job_worker_conflict_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, conflictJobId));
    const conflictClaim = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(
        client,
        conflictJobId,
        `att_worker_conflict_${runKey}`,
        `lease_worker_conflict_${runKey}`,
      ),
    );
    const conflictFence = ReplayWorkerMutationFenceSchema.parse(
      conflictClaim.rows[0]?.worker_fence,
    );
    await withTenantTransaction(adminPool, tenantId, (client) =>
      client.query(
        `INSERT INTO public.proofstack_outbox (
          tenant_id, event_type, aggregate_type, aggregate_id,
          schema_version, payload, created_at
        ) VALUES (
          $1, 'replay.job.terminal', 'replay.job', $2,
          '0.1', '{"conflict":true}'::jsonb, transaction_timestamp()
        )`,
        [tenantId, conflictJobId],
      ),
    );
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        completeJob(client, conflictFence, {
          code: "completed",
          result: resultArtifact(),
          status: "succeeded",
        }),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const rolledBack = await adminPool.query<{
      readonly event_count: number;
      readonly job_status: string;
      readonly attempt_status: string;
    }>(
      `SELECT
         job.status AS job_status,
         attempt.status AS attempt_status,
         count(event.transition_sequence)::integer AS event_count
       FROM public.proofstack_replay_jobs AS job
       JOIN public.proofstack_replay_attempts AS attempt
         ON attempt.tenant_id = job.tenant_id AND attempt.job_id = job.job_id
       LEFT JOIN public.proofstack_replay_attempt_events AS event
         ON event.tenant_id = attempt.tenant_id AND event.attempt_id = attempt.attempt_id
       WHERE job.tenant_id = $1 AND job.job_id = $2
       GROUP BY job.status, attempt.status`,
      [tenantId, conflictJobId],
    );
    expect(rolledBack.rows).toEqual([
      { attempt_status: "running", event_count: 1, job_status: "running" },
    ]);
  });

  it("keeps worker and API capabilities mutually exclusive", async () => {
    const jobId = `job_worker_split_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, jobId));
    await expect(
      withTenantTransaction(apiPool, tenantId, (client) =>
        claimJob(client, jobId, `att_worker_api_${runKey}`, `lease_worker_api_${runKey}`),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) => createJob(client, jobId)),
    ).rejects.toMatchObject({ code: "42501" });
    const unscopedWorker = await workerPool.connect();
    try {
      await expect(
        claimJob(
          unscopedWorker,
          jobId,
          `att_worker_tenant_${runKey}`,
          `lease_worker_tenant_${runKey}`,
        ),
      ).rejects.toMatchObject({ code: "22023" });
    } finally {
      unscopedWorker.release();
    }
  });
});
