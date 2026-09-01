import type { EvidenceScope, JsonObject, ReplayPlan, TargetRelease } from "@proofstack/contracts";
import { JsonValueSchema, OpaqueIdSchema, TimestampSchema } from "@proofstack/contracts";
import {
  type PublishedReplayDefinitionOutboxIntent,
  type PublishReplayDefinitionResult,
  REPLAY_DEFINITION_OUTBOX_SCHEMA_VERSION,
  REPLAY_PLAN_AGGREGATE_TYPE,
  REPLAY_PLAN_PUBLISHED_EVENT_TYPE,
  type ReplayDefinitionRepository,
  TARGET_RELEASE_AGGREGATE_TYPE,
  TARGET_RELEASE_PUBLISHED_EVENT_TYPE,
} from "@proofstack/replay";
import {
  type ReplayDefinitionPublicationKind,
  replayDefinitionRepositoryConformanceCases,
} from "@proofstack/replay/testing";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresReplayDefinitionRepository } from "./postgres-replay-definition-repository.js";
import {
  provisionRuntimeRoles,
  type RuntimeRoleCredentials,
  type RuntimeRoleProvisioningOptions,
} from "./runtime-roles.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runKey = `${process.pid}_${Date.now()}`;
const credentials = {
  api: {
    name: `proofstack_replay_api_${runKey}`,
    password: `proofstack-replay-api-${runKey}-password`,
  },
  artifact: {
    name: `proofstack_replay_art_${runKey}`,
    password: `proofstack-replay-artifact-${runKey}-password`,
  },
  consumer: {
    name: `proofstack_replay_con_${runKey}`,
    password: `proofstack-replay-consumer-${runKey}-password`,
  },
  evaluationWorker: {
    name: `proofstack_replay_eval_${runKey}`,
    password: `proofstack-replay-evaluation-${runKey}-password`,
  },
  identity: {
    name: `proofstack_replay_id_${runKey}`,
    password: `proofstack-replay-identity-${runKey}-password`,
  },
  publisher: {
    name: `proofstack_replay_pub_${runKey}`,
    password: `proofstack-replay-publisher-${runKey}-password`,
  },
  replayWorker: {
    name: `proofstack_replay_worker_${runKey}`,
    password: `proofstack-replay-worker-${runKey}-password`,
  },
} as const satisfies RuntimeRoleProvisioningOptions;

const adminPool = new Pool({ connectionString: databaseUrl, max: 6 });
const runtimePool = new Pool({ connectionString: connectionStringFor(credentials.api), max: 12 });

interface StoredIntentRow extends QueryResultRow {
  readonly aggregate_id: string;
  readonly aggregate_type: string;
  readonly created_at: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly schema_version: string;
  readonly tenant_id: string;
}

function connectionStringFor(role: RuntimeRoleCredentials): string {
  const url = new URL(databaseUrl as string);
  url.username = role.name;
  url.password = role.password;
  return url.toString();
}

function isJsonObject(input: unknown): input is JsonObject {
  const parsed = JsonValueSchema.safeParse(input);
  return (
    parsed.success &&
    typeof parsed.data === "object" &&
    parsed.data !== null &&
    !Array.isArray(parsed.data)
  );
}

function intentFromRow(row: StoredIntentRow): PublishedReplayDefinitionOutboxIntent {
  if (
    !OpaqueIdSchema.safeParse(row.tenant_id).success ||
    !OpaqueIdSchema.safeParse(row.aggregate_id).success ||
    row.schema_version !== REPLAY_DEFINITION_OUTBOX_SCHEMA_VERSION ||
    !TimestampSchema.safeParse(row.created_at).success ||
    !isJsonObject(row.payload)
  ) {
    throw new Error("Stored replay publication intent is invalid");
  }
  if (
    !(
      (row.event_type === TARGET_RELEASE_PUBLISHED_EVENT_TYPE &&
        row.aggregate_type === TARGET_RELEASE_AGGREGATE_TYPE) ||
      (row.event_type === REPLAY_PLAN_PUBLISHED_EVENT_TYPE &&
        row.aggregate_type === REPLAY_PLAN_AGGREGATE_TYPE)
    )
  ) {
    throw new Error("Stored replay publication intent has an invalid type pair");
  }
  return {
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type,
    createdAt: row.created_at,
    eventType: row.event_type,
    payload: row.payload,
    schemaVersion: row.schema_version,
    tenantId: row.tenant_id,
  } as PublishedReplayDefinitionOutboxIntent;
}

class FaultInjectingReplayPool implements Pick<Pool, "connect"> {
  private readonly pendingFailures = new Set<ReplayDefinitionPublicationKind>();

  constructor(private readonly pool: Pool) {}

  async connect(): Promise<PoolClient> {
    const client = await this.pool.connect();
    const pendingFailures = this.pendingFailures;
    return new Proxy(client, {
      get(target, property) {
        if (property === "query") {
          return async (...arguments_: unknown[]) => {
            const statement = arguments_[0];
            const values = arguments_[1];
            if (
              typeof statement === "string" &&
              statement.includes("INSERT INTO public.proofstack_outbox") &&
              Array.isArray(values)
            ) {
              const kind =
                values[1] === TARGET_RELEASE_PUBLISHED_EVENT_TYPE
                  ? "target_release"
                  : values[1] === REPLAY_PLAN_PUBLISHED_EVENT_TYPE
                    ? "replay_plan"
                    : null;
              if (kind && pendingFailures.delete(kind)) {
                throw new Error(`Injected ${kind} replay publication intent failure`);
              }
            }
            const query = target.query.bind(target) as unknown as (
              ...queryArguments: unknown[]
            ) => Promise<unknown>;
            return query(...arguments_);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  failNextPublicationIntent(kind: ReplayDefinitionPublicationKind): void {
    this.pendingFailures.add(kind);
  }

  clearPublicationIntentFailures(): void {
    this.pendingFailures.clear();
  }
}

async function withAdminTenant(
  tenantId: string,
  operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('proofstack.tenant_id', $1, true)", [tenantId]);
    await operation(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedArtifact(
  client: PoolClient,
  scope: EvidenceScope,
  reference: TargetRelease["build"]["provenance"],
): Promise<void> {
  await client.query(
    `INSERT INTO public.proofstack_artifact_catalog (
      tenant_id, project_id, environment_id, artifact_id, schema_version, state,
      classification, media_type, content_sha256, content_size_bytes, redaction,
      retention_mode, expires_at, created_at, available_at, tombstoned_at, purged_at,
      created_by_principal_id, object_key, encryption_version, content_nonce,
      wrapped_key_algorithm, wrapped_key_id, wrapped_key_ciphertext, wrapped_key_nonce,
      wrapped_key_tag, object_receipt_sha256, object_receipt_size_bytes
    ) VALUES (
      $1, $2, $3, $4, '0.1', 'available', $5, $6, $7, $8,
      '{"status":"not_required"}'::jsonb, 'retain', NULL,
      '2026-08-29T10:00:00.000Z', '2026-08-29T10:00:00.000Z', NULL, NULL,
      'usr_replay_seed', $9, 'a256gcm-v1', 'AAAAAAAAAAAAAAAA', 'A256GCM',
      'key_replay_seed', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      'CCCCCCCCCCCCCCCC', 'DDDDDDDDDDDDDDDDDDDDDD', $10, $11
    ) ON CONFLICT (tenant_id, artifact_id) DO NOTHING`,
    [
      scope.tenantId,
      scope.projectId,
      scope.environmentId,
      reference.artifactId,
      reference.classification,
      reference.mediaType,
      reference.sha256,
      reference.sizeBytes,
      `${scope.tenantId}/${reference.artifactId}`,
      "e".repeat(64),
      reference.sizeBytes + 20,
    ],
  );
}

async function seedFixture(
  client: PoolClient,
  scope: EvidenceScope,
  fixtureId: string,
  fixtureVersionId: string,
  definitionSha256: string,
): Promise<void> {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const eventId = `evt_${fixtureVersionId}`.slice(0, 64);
  await client.query(
    `INSERT INTO public.proofstack_regression_fixtures (
      tenant_id, project_id, environment_id, fixture_id,
      root_fixture_version_id, root_definition_sha256
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (tenant_id, fixture_id) DO NOTHING`,
    [
      scope.tenantId,
      scope.projectId,
      scope.environmentId,
      fixtureId,
      fixtureVersionId,
      definitionSha256,
    ],
  );
  await client.query(
    `INSERT INTO public.proofstack_regression_fixture_versions (
      tenant_id, project_id, environment_id, fixture_id, root_fixture_version_id,
      root_definition_sha256, fixture_version_id, schema_version, name, description,
      predecessor_fixture_version_id, predecessor_definition_sha256, replayability,
      source_kind, source_trace_id, source_event_count, source_completeness,
      source_captured_at, source_captured_at_lexical, created_at, created_at_lexical,
      created_by_principal_id, definition_sha256
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $5, '0.1', 'Replay dependency seed', NULL,
      NULL, NULL, 'evidence_only', 'trace_snapshot', $7, 1, 'observed_snapshot',
      '2026-08-29T10:00:00.000Z', '2026-08-29T10:00:00.000Z',
      '2026-08-29T10:00:00.000Z', '2026-08-29T10:00:00.000Z',
      'usr_replay_seed', $6
    ) ON CONFLICT (tenant_id, fixture_version_id) DO NOTHING`,
    [
      scope.tenantId,
      scope.projectId,
      scope.environmentId,
      fixtureId,
      fixtureVersionId,
      definitionSha256,
      traceId,
    ],
  );
  await client.query(
    `INSERT INTO public.proofstack_regression_fixture_events (
      tenant_id, project_id, environment_id, fixture_id, fixture_version_id,
      source_trace_id, source_event_count, event_position, event_id
    ) VALUES ($1, $2, $3, $4, $5, $6, 1, 0, $7)
    ON CONFLICT (tenant_id, fixture_version_id, event_position) DO NOTHING`,
    [
      scope.tenantId,
      scope.projectId,
      scope.environmentId,
      fixtureId,
      fixtureVersionId,
      traceId,
      eventId,
    ],
  );
}

async function seedPlanDependencies(plan: ReplayPlan): Promise<void> {
  await withAdminTenant(plan.scope.tenantId, async (client) => {
    const recorded = plan.boundaries.find((boundary) => boundary.mode === "recorded_stub");
    const fixture =
      recorded?.mode === "recorded_stub"
        ? recorded.invocation.fixture
        : {
            definitionSha256: "0".repeat(64),
            fixtureId: `fix_${plan.dataset.datasetVersionId}`.slice(0, 64),
            fixtureVersionId: `fiv_${plan.dataset.datasetVersionId}`.slice(0, 64),
          };
    await seedFixture(
      client,
      plan.scope,
      fixture.fixtureId,
      fixture.fixtureVersionId,
      fixture.definitionSha256,
    );
    for (const boundary of plan.boundaries) {
      if (boundary.mode === "recorded_stub") {
        await seedFixture(
          client,
          plan.scope,
          boundary.invocation.fixture.fixtureId,
          boundary.invocation.fixture.fixtureVersionId,
          boundary.invocation.fixture.definitionSha256,
        );
      } else if (boundary.mode === "simulation") {
        await seedArtifact(client, plan.scope, boundary.qualification);
      } else if (boundary.sideEffect.kind === "non_idempotent_write") {
        await seedArtifact(client, plan.scope, boundary.sideEffect.riskAcceptance);
      }
    }
    await client.query(
      `INSERT INTO public.proofstack_regression_datasets (
        tenant_id, project_id, environment_id, dataset_id,
        root_dataset_version_id, root_definition_sha256
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, dataset_id) DO NOTHING`,
      [
        plan.scope.tenantId,
        plan.scope.projectId,
        plan.scope.environmentId,
        plan.dataset.datasetId,
        plan.dataset.datasetVersionId,
        plan.dataset.definitionSha256,
      ],
    );
    await client.query(
      `INSERT INTO public.proofstack_regression_dataset_versions (
        tenant_id, project_id, environment_id, dataset_id, root_dataset_version_id,
        root_definition_sha256, dataset_version_id, schema_version, name, description,
        predecessor_dataset_version_id, predecessor_definition_sha256,
        fixture_version_count, created_at, created_at_lexical,
        created_by_principal_id, definition_sha256
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $5, '0.1', 'Replay dependency seed', NULL,
        NULL, NULL, 1, '2026-08-29T10:00:00.000Z', '2026-08-29T10:00:00.000Z',
        'usr_replay_seed', $6
      ) ON CONFLICT (tenant_id, dataset_version_id) DO NOTHING`,
      [
        plan.scope.tenantId,
        plan.scope.projectId,
        plan.scope.environmentId,
        plan.dataset.datasetId,
        plan.dataset.datasetVersionId,
        plan.dataset.definitionSha256,
      ],
    );
    await client.query(
      `INSERT INTO public.proofstack_regression_dataset_members (
        tenant_id, project_id, environment_id, dataset_id, dataset_version_id,
        fixture_version_count, member_position, fixture_id, fixture_version_id,
        fixture_definition_sha256
      ) VALUES ($1, $2, $3, $4, $5, 1, 0, $6, $7, $8)
      ON CONFLICT (tenant_id, dataset_version_id, member_position) DO NOTHING`,
      [
        plan.scope.tenantId,
        plan.scope.projectId,
        plan.scope.environmentId,
        plan.dataset.datasetId,
        plan.dataset.datasetVersionId,
        fixture.fixtureId,
        fixture.fixtureVersionId,
        fixture.definitionSha256,
      ],
    );
  });
}

async function seedTargetDependencies(release: TargetRelease): Promise<void> {
  await withAdminTenant(release.scope.tenantId, async (client) => {
    await seedArtifact(client, release.scope, release.build.provenance);
    if (release.execution.kind === "artifact") {
      await seedArtifact(client, release.scope, release.execution.artifact);
    }
  });
}

class SeededReplayDefinitionRepository implements ReplayDefinitionRepository {
  private readonly planPublications = new Map<
    string,
    Promise<PublishReplayDefinitionResult<ReplayPlan>>
  >();

  constructor(private readonly repository: ReplayDefinitionRepository) {}

  findReplayPlan(scope: EvidenceScope, planVersionId: string): Promise<ReplayPlan | null> {
    return this.repository.findReplayPlan(scope, planVersionId);
  }

  findTargetRelease(scope: EvidenceScope, targetReleaseId: string): Promise<TargetRelease | null> {
    return this.repository.findTargetRelease(scope, targetReleaseId);
  }

  async publishReplayPlan(
    candidate: ReplayPlan,
  ): Promise<PublishReplayDefinitionResult<ReplayPlan>> {
    const key = `${candidate.scope.tenantId}:${candidate.planVersionId}`;
    const pending = this.planPublications.get(key);
    if (pending) {
      await pending.catch(() => undefined);
      await seedPlanDependencies(candidate);
      return this.repository.publishReplayPlan(candidate);
    }
    const publication = (async () => {
      await seedPlanDependencies(candidate);
      return this.repository.publishReplayPlan(candidate);
    })();
    this.planPublications.set(key, publication);
    try {
      return await publication;
    } finally {
      this.planPublications.delete(key);
    }
  }

  async publishTargetRelease(
    candidate: TargetRelease,
  ): Promise<PublishReplayDefinitionResult<TargetRelease>> {
    await seedTargetDependencies(candidate);
    return this.repository.publishTargetRelease(candidate);
  }
}

const faultPool = new FaultInjectingReplayPool(runtimePool);
const repository = new SeededReplayDefinitionRepository(
  new PostgresReplayDefinitionRepository(faultPool),
);

async function publishedIntents(
  tenantId: string,
): Promise<readonly PublishedReplayDefinitionOutboxIntent[]> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('proofstack.tenant_id', $1, true)", [tenantId]);
    const result = await client.query<StoredIntentRow>(
      `SELECT
        tenant_id, event_type, aggregate_type, aggregate_id, schema_version, payload,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM public.proofstack_outbox
      WHERE tenant_id = $1 AND event_type = ANY($2::varchar[])
      ORDER BY event_type COLLATE "C", aggregate_type COLLATE "C", aggregate_id COLLATE "C"`,
      [tenantId, [REPLAY_PLAN_PUBLISHED_EVENT_TYPE, TARGET_RELEASE_PUBLISHED_EVENT_TYPE]],
    );
    await client.query("COMMIT");
    return result.rows.map(intentFromRow);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function removePublicationIntent(
  kind: ReplayDefinitionPublicationKind,
  tenantId: string,
  aggregateId: string,
): Promise<void> {
  await withAdminTenant(tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      `DELETE FROM public.proofstack_outbox
       WHERE tenant_id = $1 AND event_type = $2 AND aggregate_id = $3`,
      [
        tenantId,
        kind === "target_release"
          ? TARGET_RELEASE_PUBLISHED_EVENT_TYPE
          : REPLAY_PLAN_PUBLISHED_EVENT_TYPE,
        aggregateId,
      ],
    );
  });
}

async function resetReplayCatalog(): Promise<void> {
  await adminPool.query(`TRUNCATE TABLE
    public.proofstack_replay_plan_boundaries,
    public.proofstack_replay_plan_budgets,
    public.proofstack_replay_plans,
    public.proofstack_replay_plan_resources,
    public.proofstack_target_releases,
    public.proofstack_replay_targets,
    public.proofstack_regression_dataset_members,
    public.proofstack_regression_dataset_versions,
    public.proofstack_regression_datasets,
    public.proofstack_regression_fixture_events,
    public.proofstack_regression_fixture_versions,
    public.proofstack_regression_fixtures,
    public.proofstack_artifact_purge_receipts,
    public.proofstack_artifact_tombstones,
    public.proofstack_artifact_catalog,
    public.proofstack_outbox
    RESTART IDENTITY CASCADE`);
}

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, credentials);
});

beforeEach(async () => {
  faultPool.clearPublicationIntentFailures();
  await resetReplayCatalog();
});

afterAll(async () => {
  await runtimePool.end();
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

describe("PostgresReplayDefinitionRepository contract", () => {
  for (const testCase of replayDefinitionRepositoryConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(() => ({
        failNextPublicationIntent: (kind) => faultPool.failNextPublicationIntent(kind),
        publishedIntents,
        removePublicationIntent,
        repository,
      }));
    });
  }
});
