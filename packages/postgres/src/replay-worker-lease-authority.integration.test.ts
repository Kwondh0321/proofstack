import {
  REPLAY_BUDGET_DIMENSIONS,
  ReplayAttemptSchema,
  ReplayBudgetReconciliationSchema,
  ReplayBudgetReservationSchema,
  ReplayCancellationAcknowledgementSchema,
  ReplayCancellationRequestSchema,
  ReplayExecutionObservationSchema,
  ReplayJobSchema,
  ReplayPlanSchema,
  ReplayUsageObservationSchema,
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
  const targetAdapter = {
    name: "proofstack.worker_test",
    protocolVersion: "1.0.0",
    version: "1.0.0",
  } as const;
  const fixture = {
    definitionSha256: "8".repeat(64),
    fixtureId: `fix_worker_${runKey}`,
    fixtureVersionId: `fiv_worker_${runKey}`,
  };
  return ReplayPlanSchema.parse({
    boundaries: [
      {
        boundaryId: `bnd_worker_recorded_${runKey}`,
        invocation: {
          fixture,
          invocationId: `rpi_worker_${runKey}`,
          runtime: {
            boundaryMode: "recorded_stub",
            clock: { instant: createdAt, mode: "fixed" },
            isolation: { mode: "cooperative_in_process" },
            locale: "en-US",
            network: { policy: "deny_fallback" },
            random: {
              algorithm: "hmac_sha256_counter_v1",
              mode: "seeded",
              seedHex: "a".repeat(64),
            },
            timeZone: "UTC",
          },
          schemaVersion: "0.1",
          targetAdapter: { name: targetAdapter.name, version: targetAdapter.version },
        },
        invocationDefinitionSha256: "9".repeat(64),
        kind: "tool",
        mode: "recorded_stub",
      },
    ],
    budget: {
      concurrentInteractions: { limit: 4, measurement: "measured" },
      elapsedMilliseconds: { limit: 20_000, measurement: "measured" },
      emittedArtifactBytes: { limit: 1_000_000, measurement: "measured" },
      inputTokens: { limit: 4_096, measurement: "estimated" },
      jobAttempts: { limit: 3, measurement: "measured" },
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
      automatic: true,
      backoff: { delayMilliseconds: 2_000, kind: "fixed" },
      idempotencyRequirement: "no_external_effect",
      maxAttempts: 3,
      perAttemptTimeoutMilliseconds: 2_000,
      retryableErrors: ["target_process_interrupted"],
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
      targetAdapter,
      targetId: `target_worker_${runKey}`,
      targetReleaseId: `trg_worker_${runKey}`,
      workerProtocol,
    },
    workerProtocol,
  });
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
    const boundary = plan.boundaries[0];
    if (!boundary || boundary.mode !== "recorded_stub") {
      throw new Error("Replay worker fixture requires one recorded boundary");
    }
    await client.query(
      `INSERT INTO public.proofstack_replay_plan_boundaries (
        tenant_id, project_id, environment_id, plan_id, plan_version_id,
        boundary_position, boundary_id, boundary_kind, boundary_mode,
        recorded_fixture_id, recorded_fixture_version_id,
        recorded_fixture_definition_sha256, recorded_invocation_definition_sha256,
        declaration
      ) VALUES (
        $1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, $11, $12, $13::jsonb
      )`,
      [
        tenantId,
        projectId,
        environmentId,
        planId,
        planVersionId,
        boundary.boundaryId,
        boundary.kind,
        boundary.mode,
        boundary.invocation.fixture.fixtureId,
        boundary.invocation.fixture.fixtureVersionId,
        boundary.invocation.fixture.definitionSha256,
        boundary.invocationDefinitionSha256,
        JSON.stringify(boundary),
      ],
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

function usageMeasurements(overrides: Readonly<Record<string, unknown>> = {}) {
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [
      dimension,
      overrides[dimension] ?? { amount: 0, source: "measured", status: "observed" },
    ]),
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

async function reconcileBudget(
  client: PoolClient,
  fence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>,
  reconciliationId: string,
  reservationId: string,
  usage: Readonly<Record<string, unknown>>,
) {
  return client.query<{ readonly created: boolean; readonly reconciliation: unknown }>(
    `SELECT * FROM public.proofstack_reconcile_replay_budget(
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
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
      reconciliationId,
      reservationId,
      JSON.stringify(usage),
    ],
  );
}

async function appendExecutionObservation(
  client: PoolClient,
  fence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>,
  observationId: string,
  payload: Readonly<Record<string, unknown>>,
) {
  return client.query<{ readonly created: boolean; readonly observation: unknown }>(
    `SELECT * FROM public.proofstack_append_replay_execution_observation(
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
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
      observationId,
      JSON.stringify(payload),
    ],
  );
}

async function appendUsageObservation(
  client: PoolClient,
  fence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>,
  observationId: string,
  sourceEventSha256: string,
  measurements: readonly Readonly<Record<string, unknown>>[],
  boundaryId?: string,
) {
  return client.query<{ readonly created: boolean; readonly observation: unknown }>(
    `SELECT * FROM public.proofstack_append_replay_usage_observation(
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
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
      observationId,
      boundaryId ?? null,
      sourceEventSha256,
      JSON.stringify(measurements),
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
      }
    | {
        readonly code: "budget_limit_reached";
        readonly error: unknown;
        readonly status: "budget_exhausted";
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

    const repeatedClaim = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(client, jobId, fence.attemptId, fence.leaseId),
    );
    expect(repeatedClaim.rows).toEqual(claimed.rows);

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

  it("reconciles settled, disputed, and overrun usage without trusting worker arithmetic", async () => {
    const jobId = `job_worker_reconcile_${runKey}`;
    const reservationId = `res_worker_reconcile_${runKey}`;
    const reconciliationId = `rec_worker_reconcile_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, jobId));
    const claimed = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(
        client,
        jobId,
        `att_worker_reconcile_${runKey}`,
        `lease_worker_reconcile_${runKey}`,
        workerProtocol,
        2_000,
      ),
    );
    const fence = ReplayWorkerMutationFenceSchema.parse(claimed.rows[0]?.worker_fence);
    await withTenantTransaction(workerPool, tenantId, (client) =>
      reserveBudget(
        client,
        fence,
        reservationId,
        requestedAmounts({ inputTokens: 10, jobAttempts: 1, providerCostMicrounits: 100 }),
      ),
    );
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        completeJob(client, fence, {
          code: "completed",
          result: resultArtifact(),
          status: "succeeded",
        }),
      ),
    ).rejects.toMatchObject({ code: "55000" });

    const usage = usageMeasurements({
      inputTokens: { amount: 4, source: "provider_reported", status: "observed" },
      jobAttempts: { amount: 1, source: "measured", status: "observed" },
      providerCostMicrounits: { reason: "provider_did_not_report", status: "unavailable" },
    });
    await expect(
      withTenantTransaction(apiPool, tenantId, (client) =>
        reconcileBudget(client, fence, reconciliationId, reservationId, usage),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        reconcileBudget(
          client,
          { ...fence, fencingToken: 2 },
          reconciliationId,
          reservationId,
          usage,
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        reconcileBudget(client, fence, reconciliationId, reservationId, {}),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await withTenantTransaction(workerPool, tenantId, (client) =>
      heartbeatJob(client, fence, 2_000),
    );

    const reconciled = await withTenantTransaction(workerPool, tenantId, (client) =>
      reconcileBudget(client, fence, reconciliationId, reservationId, usage),
    );
    const reconciliation = ReplayBudgetReconciliationSchema.parse(
      reconciled.rows[0]?.reconciliation,
    );
    expect(reconciled.rows[0]?.created).toBe(true);
    expect(reconciliation).toMatchObject({
      ledgerSequence: 1,
      mutationFence: fence,
      reconciliationId,
      reservationId,
      scope: { environmentId, projectId, tenantId },
    });
    expect(reconciliation.dimensions.inputTokens).toEqual({
      actualUsage: { amount: 4, source: "provider_reported", status: "observed" },
      disposition: "settled",
      overrunAmount: 0,
      releasedAmount: 6,
      reservedAmount: 10,
    });
    expect(reconciliation.dimensions.providerCostMicrounits).toEqual({
      actualUsage: { reason: "provider_did_not_report", status: "unavailable" },
      disposition: "disputed",
      overrunAmount: 0,
      releasedAmount: 0,
      reservedAmount: 100,
    });

    const retried = await withTenantTransaction(workerPool, tenantId, (client) =>
      reconcileBudget(client, fence, reconciliationId, reservationId, usage),
    );
    expect(retried.rows).toEqual([{ created: false, reconciliation }]);
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        reconcileBudget(
          client,
          fence,
          reconciliationId,
          reservationId,
          usageMeasurements({
            ...usage,
            inputTokens: { amount: 5, source: "provider_reported", status: "observed" },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        reconcileBudget(client, fence, `rec_worker_duplicate_${runKey}`, reservationId, usage),
      ),
    ).rejects.toMatchObject({ code: "23505" });

    const overrunReservationId = `res_worker_overrun_${runKey}`;
    await withTenantTransaction(workerPool, tenantId, (client) =>
      heartbeatJob(client, fence, 2_000),
    );
    await withTenantTransaction(workerPool, tenantId, (client) =>
      reserveBudget(client, fence, overrunReservationId, requestedAmounts({ toolCalls: 1 })),
    );
    const overrun = await withTenantTransaction(workerPool, tenantId, (client) =>
      reconcileBudget(
        client,
        fence,
        `rec_worker_overrun_${runKey}`,
        overrunReservationId,
        usageMeasurements({ toolCalls: { amount: 2, source: "measured", status: "observed" } }),
      ),
    );
    expect(
      ReplayBudgetReconciliationSchema.parse(overrun.rows[0]?.reconciliation).dimensions.toolCalls,
    ).toMatchObject({
      disposition: "overrun",
      overrunAmount: 1,
      releasedAmount: 0,
      reservedAmount: 1,
    });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        completeJob(client, fence, {
          code: "completed",
          result: resultArtifact(),
          status: "succeeded",
        }),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    const exhausted = await withTenantTransaction(workerPool, tenantId, (client) =>
      completeJob(client, fence, {
        code: "budget_limit_reached",
        error: {
          code: "budget_exhausted",
          effectCertainty: "none",
          message: "Observed usage exceeded its complete reservation.",
        },
        status: "budget_exhausted",
      }),
    );
    expect(ReplayJobSchema.parse(exhausted.rows[0]?.job).status).toBe("budget_exhausted");
  });

  it("appends ordered execution evidence through the current live fence", async () => {
    const jobId = `job_worker_observe_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, jobId));
    const claimed = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(
        client,
        jobId,
        `att_worker_observe_${runKey}`,
        `lease_worker_observe_${runKey}`,
        workerProtocol,
        2_000,
      ),
    );
    const fence = ReplayWorkerMutationFenceSchema.parse(claimed.rows[0]?.worker_fence);
    const targetObservationId = `obs_worker_target_${runKey}`;
    const targetPayload = {
      afterCancellationRequest: false,
      event: "started",
      evidenceSha256: "a".repeat(64),
      kind: "target",
    } as const;

    await expect(
      withTenantTransaction(apiPool, tenantId, (client) =>
        appendExecutionObservation(client, fence, targetObservationId, targetPayload),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendExecutionObservation(
          client,
          { ...fence, fencingToken: 2 },
          targetObservationId,
          targetPayload,
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendExecutionObservation(client, fence, `obs_worker_exit_bad_${runKey}`, {
          afterCancellationRequest: false,
          event: "started",
          evidenceSha256: "b".repeat(64),
          exitCode: 0,
          kind: "target",
        }),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendExecutionObservation(client, fence, `obs_worker_null_bad_${runKey}`, {
          ...targetPayload,
          event: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "22023" });

    const concurrent = await Promise.all([
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendExecutionObservation(client, fence, targetObservationId, targetPayload),
      ),
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendExecutionObservation(client, fence, `obs_worker_isolation_${runKey}`, {
          control: "network_policy",
          evidenceSha256: "c".repeat(64),
          kind: "isolation",
          verdict: "verified",
        }),
      ),
    ]);
    const ordered = concurrent
      .map((result) => ReplayExecutionObservationSchema.parse(result.rows[0]?.observation))
      .sort((left, right) => left.observationSequence - right.observationSequence);
    expect(ordered.map(({ observationSequence }) => observationSequence)).toEqual([0, 1]);
    const targetObservation = ordered.find(
      ({ observationId }) => observationId === targetObservationId,
    );
    expect(targetObservation?.payload).toEqual(targetPayload);

    const retried = await withTenantTransaction(workerPool, tenantId, (client) =>
      appendExecutionObservation(client, fence, targetObservationId, targetPayload),
    );
    expect(retried.rows).toEqual([{ created: false, observation: targetObservation }]);
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendExecutionObservation(client, fence, targetObservationId, {
          ...targetPayload,
          evidenceSha256: "d".repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendExecutionObservation(client, fence, `obs_worker_boundary_missing_${runKey}`, {
          afterCancellationRequest: false,
          boundaryId: `bnd_worker_missing_${runKey}`,
          boundaryKind: "retrieval",
          effectCertainty: "none",
          evidenceSha256: "e".repeat(64),
          executionOrigin: "recorded",
          kind: "boundary",
          mode: "recorded_stub",
          phase: "request_started",
        }),
      ),
    ).rejects.toMatchObject({ code: "23503" });

    const cancellationId = `can_worker_observe_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) =>
      requestCancellation(client, jobId, cancellationId),
    );
    await withTenantTransaction(workerPool, tenantId, (client) =>
      heartbeatJob(client, fence, 2_000),
    );
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendExecutionObservation(client, fence, `obs_worker_cancel_order_bad_${runKey}`, {
          ...targetPayload,
          evidenceSha256: "f".repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    const afterCancellation = await withTenantTransaction(workerPool, tenantId, (client) =>
      appendExecutionObservation(client, fence, `obs_worker_after_cancel_${runKey}`, {
        ...targetPayload,
        afterCancellationRequest: true,
        evidenceSha256: "1".repeat(64),
      }),
    );
    expect(
      ReplayExecutionObservationSchema.parse(afterCancellation.rows[0]?.observation)
        .observationSequence,
    ).toBe(2);
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendExecutionObservation(client, fence, `obs_worker_cancel_wrong_${runKey}`, {
          cancellationId: `can_worker_wrong_${runKey}`,
          event: "request_observed",
          evidenceSha256: "2".repeat(64),
          kind: "cancellation",
        }),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    const cancellationObservation = await withTenantTransaction(workerPool, tenantId, (client) =>
      appendExecutionObservation(client, fence, `obs_worker_cancel_${runKey}`, {
        cancellationId,
        event: "request_observed",
        evidenceSha256: "3".repeat(64),
        kind: "cancellation",
      }),
    );
    expect(
      ReplayExecutionObservationSchema.parse(cancellationObservation.rows[0]?.observation)
        .observationSequence,
    ).toBe(3);
  });

  it("appends normalized usage evidence through the shared live-fence sequence", async () => {
    const jobId = `job_worker_usage_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, jobId));
    const claimed = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(
        client,
        jobId,
        `att_worker_usage_${runKey}`,
        `lease_worker_usage_${runKey}`,
        workerProtocol,
        2_000,
      ),
    );
    const fence = ReplayWorkerMutationFenceSchema.parse(claimed.rows[0]?.worker_fence);
    const observationId = `obs_worker_usage_${runKey}`;
    const sourceEventSha256 = "4".repeat(64);
    const measurements = [
      {
        dimension: "inputTokens",
        usage: { amount: 12, source: "provider_reported", status: "observed" },
      },
      {
        dimension: "outputTokens",
        usage: { reason: "provider_did_not_report", status: "unavailable" },
      },
    ] as const;

    await expect(
      withTenantTransaction(apiPool, tenantId, (client) =>
        appendUsageObservation(client, fence, observationId, sourceEventSha256, measurements),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendUsageObservation(
          client,
          { ...fence, fencingToken: 2 },
          observationId,
          sourceEventSha256,
          measurements,
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendUsageObservation(
          client,
          fence,
          `obs_worker_usage_order_${runKey}`,
          sourceEventSha256,
          [...measurements].reverse(),
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendUsageObservation(
          client,
          fence,
          `obs_worker_usage_null_${runKey}`,
          sourceEventSha256,
          [
            {
              dimension: "inputTokens",
              usage: { amount: 1, source: null, status: "observed" },
            },
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendUsageObservation(
          client,
          fence,
          `obs_worker_usage_boundary_${runKey}`,
          sourceEventSha256,
          measurements,
          `bnd_worker_missing_${runKey}`,
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });

    const concurrent = await Promise.all([
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendUsageObservation(client, fence, observationId, sourceEventSha256, measurements),
      ),
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendExecutionObservation(client, fence, `obs_worker_usage_peer_${runKey}`, {
          control: "output_limits",
          evidenceSha256: "5".repeat(64),
          kind: "isolation",
          verdict: "verified",
        }),
      ),
    ]);
    const usageObservation = ReplayUsageObservationSchema.parse(
      concurrent[0]?.rows[0]?.observation,
    );
    const executionObservation = ReplayExecutionObservationSchema.parse(
      concurrent[1]?.rows[0]?.observation,
    );
    expect(
      [usageObservation.observationSequence, executionObservation.observationSequence].sort(
        (left, right) => left - right,
      ),
    ).toEqual([0, 1]);
    expect(usageObservation).toMatchObject({
      measurements,
      mutationFence: fence,
      observationId,
      scope: { environmentId, projectId, tenantId },
      sourceEventSha256,
    });
    expect(usageObservation).not.toHaveProperty("boundaryId");

    const retried = await withTenantTransaction(workerPool, tenantId, (client) =>
      appendUsageObservation(client, fence, observationId, sourceEventSha256, measurements),
    );
    expect(retried.rows).toEqual([{ created: false, observation: usageObservation }]);
    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        appendUsageObservation(client, fence, observationId, "6".repeat(64), measurements),
      ),
    ).rejects.toMatchObject({ code: "23505" });

    const normalized = await adminPool.query<{
      readonly amount: string | null;
      readonly dimension: string;
      readonly source: string | null;
      readonly unavailable_reason: string | null;
      readonly usage_status: string;
    }>(
      `SELECT dimension, usage_status, amount::text, source, unavailable_reason
       FROM public.proofstack_replay_usage_measurements
       WHERE tenant_id = $1 AND observation_id = $2
       ORDER BY dimension`,
      [tenantId, observationId],
    );
    expect(normalized.rows).toEqual([
      {
        amount: "12",
        dimension: "inputTokens",
        source: "provider_reported",
        unavailable_reason: null,
        usage_status: "observed",
      },
      {
        amount: null,
        dimension: "outputTokens",
        source: null,
        unavailable_reason: "provider_did_not_report",
        usage_status: "unavailable",
      },
    ]);
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

  it("reclaims an expired lease only after backoff and permanently fences the prior worker", async () => {
    const jobId = `job_worker_reclaim_${runKey}`;
    const firstAttemptId = `att_worker_reclaim_a_${runKey}`;
    const firstLeaseId = `lease_worker_reclaim_a_${runKey}`;
    const secondAttemptId = `att_worker_reclaim_b_${runKey}`;
    const secondLeaseId = `lease_worker_reclaim_b_${runKey}`;
    const competingAttemptId = `att_worker_reclaim_c_${runKey}`;
    const competingLeaseId = `lease_worker_reclaim_c_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, jobId));

    const firstClaim = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(client, jobId, firstAttemptId, firstLeaseId, workerProtocol, 100),
    );
    const firstJob = ReplayJobSchema.parse(firstClaim.rows[0]?.job);
    const firstFence = ReplayWorkerMutationFenceSchema.parse(firstClaim.rows[0]?.worker_fence);
    await adminPool.query("SELECT pg_sleep(0.15)");

    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        claimJob(client, jobId, firstAttemptId, firstLeaseId, workerProtocol, 100),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const waiting = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(client, jobId, secondAttemptId, secondLeaseId, workerProtocol, 100),
    );
    expect(waiting.rows).toHaveLength(1);
    expect(waiting.rows[0]).toMatchObject({
      attempt: firstClaim.rows[0]?.attempt,
      claimed: false,
      job: firstClaim.rows[0]?.job,
      reason: "retry_not_ready",
      worker_fence: null,
    });

    await adminPool.query("SELECT pg_sleep(2.05)");
    const reclaimOutcomes = await Promise.allSettled([
      withTenantTransaction(workerPool, tenantId, (client) =>
        claimJob(client, jobId, secondAttemptId, secondLeaseId, workerProtocol, 100),
      ),
      withTenantTransaction(workerPool, tenantId, (client) =>
        claimJob(client, jobId, competingAttemptId, competingLeaseId, workerProtocol, 100),
      ),
    ]);
    expect(reclaimOutcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(reclaimOutcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const rejectedReclaim = reclaimOutcomes.find(({ status }) => status === "rejected");
    expect(rejectedReclaim).toMatchObject({ reason: { code: "55000" } });
    const successfulReclaim = reclaimOutcomes.find(({ status }) => status === "fulfilled");
    if (!successfulReclaim || successfulReclaim.status !== "fulfilled") {
      throw new Error("Concurrent replay reclaim produced no winner");
    }
    const reclaimed = successfulReclaim.value;
    const reclaimedJob = ReplayJobSchema.parse(reclaimed.rows[0]?.job);
    const secondAttempt = ReplayAttemptSchema.parse(reclaimed.rows[0]?.attempt);
    const secondFence = ReplayWorkerMutationFenceSchema.parse(reclaimed.rows[0]?.worker_fence);
    expect(reclaimed.rows[0]?.claimed).toBe(true);
    expect(reclaimed.rows[0]?.reason).toBeNull();
    expect(reclaimedJob).toMatchObject({
      jobId,
      lastFencingToken: 2,
      latestAttemptSequence: 1,
      startedAt: firstJob.startedAt,
      stateVersion: 3,
      status: "running",
    });
    expect(secondAttempt).toMatchObject({
      attemptSequence: 1,
      mutationFence: secondFence,
      status: "running",
    });
    expect(secondFence.fencingToken).toBe(2);

    const durable = await adminPool.query<{
      readonly attempt: unknown;
      readonly event_types: string[];
    }>(
      `SELECT
         attempt.attempt,
         ARRAY_AGG(event.event_type ORDER BY event.transition_sequence) AS event_types
       FROM public.proofstack_replay_attempts AS attempt
       JOIN public.proofstack_replay_attempt_events AS event
         ON event.tenant_id = attempt.tenant_id AND event.attempt_id = attempt.attempt_id
       WHERE attempt.tenant_id = $1 AND attempt.attempt_id = $2
       GROUP BY attempt.attempt`,
      [tenantId, firstAttemptId],
    );
    const expiredAttempt = ReplayAttemptSchema.parse(durable.rows[0]?.attempt);
    expect(expiredAttempt).toMatchObject({
      attemptId: firstAttemptId,
      error: { code: "lease_expired", effectCertainty: "none" },
      retryDisposition: "retry_scheduled",
      status: "lease_expired",
    });
    expect(expiredAttempt.endedAt).toBe(secondAttempt.startedAt);
    expect(durable.rows[0]?.event_types).toEqual(["attempt_claimed", "attempt_closed"]);

    await expect(
      withTenantTransaction(workerPool, tenantId, (client) => heartbeatJob(client, firstFence)),
    ).rejects.toMatchObject({ code: "55000" });
    const repeatedClaim = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(client, jobId, secondFence.attemptId, secondFence.leaseId, workerProtocol, 100),
    );
    expect(repeatedClaim.rows).toEqual(reclaimed.rows);
  });

  it("lets a cancellation request terminalize an expired lease without starting new work", async () => {
    const jobId = `job_worker_expired_cancel_${runKey}`;
    const firstAttemptId = `att_worker_expired_cancel_a_${runKey}`;
    const firstLeaseId = `lease_worker_expired_cancel_a_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, jobId));
    const firstClaim = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(client, jobId, firstAttemptId, firstLeaseId, workerProtocol, 100),
    );
    await withTenantTransaction(apiPool, tenantId, (client) =>
      requestCancellation(client, jobId, `can_worker_expired_${runKey}`),
    );
    await adminPool.query("SELECT pg_sleep(0.15)");

    const terminal = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(
        client,
        jobId,
        `att_worker_expired_cancel_b_${runKey}`,
        `lease_worker_expired_cancel_b_${runKey}`,
        workerProtocol,
        100,
      ),
    );
    const job = ReplayJobSchema.parse(terminal.rows[0]?.job);
    const attempt = ReplayAttemptSchema.parse(terminal.rows[0]?.attempt);
    expect(terminal.rows[0]).toMatchObject({
      claimed: false,
      reason: "terminalized",
      worker_fence: null,
    });
    expect(job).toMatchObject({
      jobId,
      status: "cancelled",
      terminal: {
        attemptId: firstAttemptId,
        code: "cancellation_committed",
        status: "cancelled",
      },
    });
    expect(job.currentLease).toBeUndefined();
    expect(attempt).toMatchObject({
      attemptId: firstAttemptId,
      retryDisposition: "not_retryable",
      status: "lease_expired",
    });
    expect(attempt.endedAt).toBe(
      ReplayJobSchema.parse(firstClaim.rows[0]?.job).currentLease?.expiresAt,
    );

    const repeated = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(
        client,
        jobId,
        `att_worker_expired_cancel_c_${runKey}`,
        `lease_worker_expired_cancel_c_${runKey}`,
        workerProtocol,
        100,
      ),
    );
    expect(repeated.rows).toEqual(terminal.rows);
    const durable = await adminPool.query<{
      readonly attempt_count: number;
      readonly terminal_intent_count: number;
    }>(
      `SELECT
         count(DISTINCT attempt.attempt_id)::integer AS attempt_count,
         count(DISTINCT intent.outbox_id)::integer AS terminal_intent_count
       FROM public.proofstack_replay_jobs AS job
       LEFT JOIN public.proofstack_replay_attempts AS attempt
         ON attempt.tenant_id = job.tenant_id AND attempt.job_id = job.job_id
       LEFT JOIN public.proofstack_outbox AS intent
         ON intent.tenant_id = job.tenant_id
        AND intent.aggregate_id = job.job_id
        AND intent.event_type = 'replay.job.terminal'
       WHERE job.tenant_id = $1 AND job.job_id = $2`,
      [tenantId, jobId],
    );
    expect(durable.rows).toEqual([{ attempt_count: 1, terminal_intent_count: 1 }]);
  });

  it("rolls back expired cancellation closure when its terminal intent conflicts", async () => {
    const jobId = `job_worker_expired_conflict_${runKey}`;
    const firstAttemptId = `att_worker_expired_conflict_a_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, jobId));
    await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(
        client,
        jobId,
        firstAttemptId,
        `lease_worker_expired_conflict_a_${runKey}`,
        workerProtocol,
        100,
      ),
    );
    await withTenantTransaction(apiPool, tenantId, (client) =>
      requestCancellation(client, jobId, `can_worker_expired_conflict_${runKey}`),
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
        [tenantId, jobId],
      ),
    );
    await adminPool.query("SELECT pg_sleep(0.15)");

    await expect(
      withTenantTransaction(workerPool, tenantId, (client) =>
        claimJob(
          client,
          jobId,
          `att_worker_expired_conflict_b_${runKey}`,
          `lease_worker_expired_conflict_b_${runKey}`,
          workerProtocol,
          100,
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const durable = await adminPool.query<{
      readonly attempt_status: string;
      readonly event_count: number;
      readonly job_status: string;
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
      [tenantId, jobId],
    );
    expect(durable.rows).toEqual([
      { attempt_status: "running", event_count: 1, job_status: "running" },
    ]);
  });

  it("fails closed on an expired lease with an unreconciled budget reservation", async () => {
    const jobId = `job_worker_expired_budget_${runKey}`;
    const firstAttemptId = `att_worker_expired_budget_a_${runKey}`;
    await withTenantTransaction(apiPool, tenantId, (client) => createJob(client, jobId));
    const firstClaim = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(
        client,
        jobId,
        firstAttemptId,
        `lease_worker_expired_budget_a_${runKey}`,
        workerProtocol,
        300,
      ),
    );
    const firstFence = ReplayWorkerMutationFenceSchema.parse(firstClaim.rows[0]?.worker_fence);
    const reservationId = `res_worker_expired_budget_${runKey}`;
    await withTenantTransaction(workerPool, tenantId, (client) =>
      reserveBudget(client, firstFence, reservationId, requestedAmounts({ jobAttempts: 1 })),
    );
    await adminPool.query("SELECT pg_sleep(0.35)");

    const terminal = await withTenantTransaction(workerPool, tenantId, (client) =>
      claimJob(
        client,
        jobId,
        `att_worker_expired_budget_b_${runKey}`,
        `lease_worker_expired_budget_b_${runKey}`,
        workerProtocol,
        100,
      ),
    );
    const job = ReplayJobSchema.parse(terminal.rows[0]?.job);
    const attempt = ReplayAttemptSchema.parse(terminal.rows[0]?.attempt);
    expect(terminal.rows[0]).toMatchObject({
      claimed: false,
      reason: "terminalized",
      worker_fence: null,
    });
    expect(job).toMatchObject({
      jobId,
      status: "failed",
      terminal: { attemptId: firstAttemptId, code: "execution_failed", status: "failed" },
    });
    expect(attempt).toMatchObject({
      attemptId: firstAttemptId,
      error: { code: "lease_expired", effectCertainty: "none" },
      retryDisposition: "not_retryable",
      status: "lease_expired",
    });

    const ledger = await adminPool.query<{
      readonly entry_count: number;
      readonly entry_type: string;
      readonly reservation_id: string;
    }>(
      `SELECT
         count(*)::integer AS entry_count,
         max(entry_type) AS entry_type,
         max(reservation_id) AS reservation_id
       FROM public.proofstack_replay_budget_entries
       WHERE tenant_id = $1 AND job_id = $2`,
      [tenantId, jobId],
    );
    expect(ledger.rows).toEqual([
      { entry_count: 1, entry_type: "reservation", reservation_id: reservationId },
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
    const cancellationReservationId = `res_worker_cancel_existing_${runKey}`;
    await withTenantTransaction(workerPool, tenantId, (client) =>
      reserveBudget(client, fence, cancellationReservationId, requestedAmounts({ toolCalls: 1 })),
    );
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
    const cancellationReconciliation = await withTenantTransaction(workerPool, tenantId, (client) =>
      reconcileBudget(
        client,
        fence,
        `rec_worker_cancel_existing_${runKey}`,
        cancellationReservationId,
        usageMeasurements({ toolCalls: { amount: 1, source: "measured", status: "observed" } }),
      ),
    );
    expect(cancellationReconciliation.rows[0]?.created).toBe(true);
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
