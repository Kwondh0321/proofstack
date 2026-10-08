import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  EvidenceScope,
  JsonObject,
  ReplayPlan,
  ReplayPlanDefinition,
  TargetRelease,
  TargetReleaseDefinition,
} from "@proofstack/contracts";
import {
  JsonValueSchema,
  OpaqueIdSchema,
  ReplayPlanSchema,
  TargetReleaseSchema,
  TimestampSchema,
} from "@proofstack/contracts";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
  type PublishedReplayDefinitionOutboxIntent,
  type PublishReplayDefinitionResult,
  REPLAY_DEFINITION_OUTBOX_SCHEMA_VERSION,
  REPLAY_PLAN_AGGREGATE_TYPE,
  REPLAY_PLAN_PUBLISHED_EVENT_TYPE,
  type ReplayDefinitionRepository,
  ReplayRepositoryContractError,
  TARGET_RELEASE_AGGREGATE_TYPE,
  TARGET_RELEASE_PUBLISHED_EVENT_TYPE,
} from "@proofstack/replay";
import {
  type ReplayDefinitionPublicationKind,
  replayDefinitionRepositoryConformanceCases,
} from "@proofstack/replay/testing";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import {
  PostgresReplayDefinitionRepository,
  readPostgresReplayPlanOnClient,
  readPostgresTargetReleaseOnClient,
} from "./postgres-replay-definition-repository.js";
import {
  provisionRuntimeRoles,
  type RuntimeRoleCredentials,
  type RuntimeRoleProvisioningOptions,
} from "./runtime-roles.js";
import { withExactScopeTransaction } from "./tenant-transaction.js";

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
  humanReviewer: {
    name: `proofstack_replay_human_${runKey}`,
    password: `proofstack-replay-human-${runKey}-password`,
  },
  identity: {
    name: `proofstack_replay_id_${runKey}`,
    password: `proofstack-replay-identity-${runKey}-password`,
  },
  modelEvaluationWorker: {
    name: `proofstack_replay_model_${runKey}`,
    password: `proofstack-replay-model-${runKey}-password`,
  },
  policyAuthor: {
    name: `proofstack_replay_policy_${runKey}`,
    password: `proofstack-replay-policy-${runKey}-password`,
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
const replayWorkerPool = new Pool({
  connectionString: connectionStringFor(credentials.replayWorker),
  max: 2,
});

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
  await replayWorkerPool.end();
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

async function scopeFixture() {
  const vectors = JSON.parse(
    readFileSync(
      new URL("../../replay/vectors/replay-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    vectors: { kind: string; input: ReplayPlanDefinition | TargetReleaseDefinition }[];
  };
  const targetDefinition = structuredClone(
    vectors.vectors.find((v) => v.kind === "target_release")?.input,
  ) as TargetReleaseDefinition;
  const planDefinition = structuredClone(
    vectors.vectors.find((v) => v.kind === "replay_plan")?.input,
  ) as ReplayPlanDefinition;
  const scope = { ...targetDefinition.scope, tenantId: `ten_scope_${runKey}` };
  const receipt = {
    createdAt: "2026-08-30T16:00:00.000Z",
    createdByPrincipalId: "usr_scope_author",
  };
  targetDefinition.scope = scope;
  const release = TargetReleaseSchema.parse({
    ...targetDefinition,
    ...receipt,
    definitionSha256: digestTargetReleaseDefinition(targetDefinition),
  });
  planDefinition.scope = scope;
  planDefinition.targetRelease = {
    ...planDefinition.targetRelease,
    definitionSha256: release.definitionSha256,
  };
  const plan = ReplayPlanSchema.parse({
    ...planDefinition,
    ...receipt,
    definitionSha256: digestReplayPlanDefinition(planDefinition),
  });
  await repository.publishTargetRelease(release);
  await repository.publishReplayPlan(plan);
  return { release, plan, scope };
}
async function scopeFingerprint(scope: EvidenceScope) {
  const state = [];
  for (const table of [
    "proofstack_replay_plan_resources",
    "proofstack_replay_targets",
    "proofstack_target_releases",
    "proofstack_replay_plans",
    "proofstack_replay_plan_budgets",
    "proofstack_replay_plan_boundaries",
    "proofstack_outbox",
  ])
    state.push(
      (
        await adminPool.query(
          `SELECT to_jsonb(item) AS record FROM public.${table} AS item WHERE tenant_id = $1 ORDER BY to_jsonb(item)::text`,
          [scope.tenantId],
        )
      ).rows,
    );
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
async function damagedReplayStorage(
  h: Awaited<ReturnType<typeof scopeFixture>>,
  kind: "replay_plan" | "target_release",
  mutate: (client: PoolClient) => Promise<void>,
  inspect?: (view: Pick<PoolClient, "query">) => Promise<void>,
  readerRole: RuntimeRoleCredentials = credentials.api,
) {
  const before = await scopeFingerprint(h.scope);
  const read = (client: Pick<PoolClient, "query">, scope: EvidenceScope) =>
    kind === "replay_plan"
      ? readPostgresReplayPlanOnClient(client, scope, h.plan.planVersionId)
      : readPostgresTargetReleaseOnClient(client, scope, h.release.targetReleaseId);
  try {
    await withExactScopeTransaction(adminPool, h.scope, async (client) => {
      await client.query("SAVEPOINT retained_original");
      try {
        // Privileged isolated damage only; CHECKs remain active and every change rolls back.
        await client.query("SET LOCAL session_replication_role = 'replica'");
        await mutate(client);
        await client.query(`SET LOCAL ROLE "${readerRole.name}"`);
        const calls: string[] = [];
        const view = {
          query: async (sql: string, values: unknown[]) => {
            expect(sql.trim()).toMatch(/^SELECT\b/);
            calls.push(sql);
            return client.query(sql, values);
          },
        } as Pick<PoolClient, "query">;
        for (const dimension of ["tenantId", "projectId", "environmentId"] as const) {
          const previous = calls.length;
          await expect(read(view, { ...h.scope, [dimension]: "other_scope" })).resolves.toBeNull();
          expect(calls.length - previous).toBe(1);
        }
        if (inspect) await inspect(view);
        else
          await expect(read(view, h.scope)).rejects.toBeInstanceOf(ReplayRepositoryContractError);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT retained_original");
      }
    });
  } finally {
    expect(await scopeFingerprint(h.scope)).toBe(before);
    await expect(repository.findTargetRelease(h.scope, h.release.targetReleaseId)).resolves.toEqual(
      h.release,
    );
    await expect(repository.findReplayPlan(h.scope, h.plan.planVersionId)).resolves.toEqual(h.plan);
  }
}

describe("replay owning original intents and normalized plan storage", () => {
  it("keeps the worker intent probe tenant-bound and limited to replay definitions", async () => {
    const h = await scopeFixture();
    const intents = await publishedIntents(h.scope.tenantId);
    expect(intents).toHaveLength(2);
    await withExactScopeTransaction(replayWorkerPool, h.scope, async (client) => {
      for (const intent of intents) {
        const values = [
          intent.tenantId,
          intent.eventType,
          intent.aggregateType,
          intent.aggregateId,
          intent.schemaVersion,
          JSON.stringify(intent.payload),
          intent.createdAt,
        ];
        const probe = async (input: unknown[]) =>
          (
            await client.query(
              "SELECT public.proofstack_replay_publication_intent_status($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz) AS status",
              input,
            )
          ).rows;
        await expect(probe(values)).resolves.toEqual([{ status: "canonical" }]);
        await expect(probe(["ten_other", ...values.slice(1)])).resolves.toEqual([
          { status: "absent" },
        ]);
        const unsupported = [...values];
        unsupported[1] = "policy.published";
        await expect(probe(unsupported)).resolves.toEqual([{ status: "absent" }]);
        const extra = [...values];
        extra[5] = JSON.stringify({ ...intent.payload, unexpected: true });
        await expect(probe(extra)).resolves.toEqual([{ status: "absent" }]);
      }
    });
  });

  it("keeps worker raw outbox access and new definition publication denied", async () => {
    const h = await scopeFixture();
    const before = await scopeFingerprint(h.scope);
    const { createdAt, createdByPrincipalId, definitionSha256: _hash, ...original } = h.release;
    const definition = { ...original, targetReleaseId: `tre_worker_denied_${runKey}` };
    const release = TargetReleaseSchema.parse({
      ...definition,
      createdAt,
      createdByPrincipalId,
      definitionSha256: digestTargetReleaseDefinition(definition),
    });
    await expect(
      replayWorkerPool.query("SELECT * FROM public.proofstack_outbox"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      new PostgresReplayDefinitionRepository(replayWorkerPool).publishTargetRelease(release),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await scopeFingerprint(h.scope)).toBe(before);
    await expect(repository.findTargetRelease(h.scope, h.release.targetReleaseId)).resolves.toEqual(
      h.release,
    );
  });

  for (const kind of ["target_release", "replay_plan"] as const)
    it(`rejects a damaged ${kind} intent under the replay worker role`, async () => {
      const h = await scopeFixture();
      const id = kind === "replay_plan" ? h.plan.planVersionId : h.release.targetReleaseId;
      await damagedReplayStorage(
        h,
        kind,
        async (client) => {
          expect(
            (
              await client.query(
                "UPDATE public.proofstack_outbox SET payload=payload || '{\"unexpected\":true}'::jsonb WHERE tenant_id=$1 AND aggregate_id=$2",
                [h.scope.tenantId, id],
              )
            ).rowCount,
          ).toBe(1);
        },
        undefined,
        credentials.replayWorker,
      );
    });

  for (const kind of ["target_release", "replay_plan"] as const)
    it(`allows the provisioned replay worker to read canonical ${kind}`, async () => {
      const h = await scopeFixture();
      const worker = new PostgresReplayDefinitionRepository(replayWorkerPool);
      if (kind === "target_release")
        await expect(worker.findTargetRelease(h.scope, h.release.targetReleaseId)).resolves.toEqual(
          h.release,
        );
      else
        await expect(worker.findReplayPlan(h.scope, h.plan.planVersionId)).resolves.toEqual(h.plan);
    });

  it("rejects an existing body without either normalized child witness", async () => {
    const h = await scopeFixture();
    await damagedReplayStorage(h, "replay_plan", async (client) => {
      for (const table of ["proofstack_replay_plan_budgets", "proofstack_replay_plan_boundaries"])
        expect(
          (
            await client.query(
              `DELETE FROM public.${table} WHERE tenant_id=$1 AND plan_version_id=$2`,
              [h.scope.tenantId, h.plan.planVersionId],
            )
          ).rowCount,
        ).toBeGreaterThan(0);
    });
  });

  for (const kind of ["target_release", "replay_plan"] as const)
    it(`preserves ${kind} canonical intent across ordinary delivery updates`, async () => {
      const h = await scopeFixture();
      const id = kind === "replay_plan" ? h.plan.planVersionId : h.release.targetReleaseId;
      await damagedReplayStorage(
        h,
        kind,
        async (client) => {
          // Keep ordinary immutable-intent triggers active for a permitted delivery update.
          await client.query("SET LOCAL session_replication_role = 'origin'");
          expect(
            (
              await client.query(
                "UPDATE public.proofstack_outbox SET attempt_count=attempt_count+1, available_at=available_at+interval '1 second', published_at='2026-08-30T17:00:00.000Z'::timestamptz, last_error='temporary' WHERE tenant_id=$1 AND aggregate_id=$2",
                [h.scope.tenantId, id],
              )
            ).rowCount,
          ).toBe(1);
        },
        async (client) => {
          await expect(
            kind === "replay_plan"
              ? readPostgresReplayPlanOnClient(client, h.scope, id)
              : readPostgresTargetReleaseOnClient(client, h.scope, id),
          ).resolves.toEqual(kind === "replay_plan" ? h.plan : h.release);
        },
      );
    });

  it("rejects a plan removed after its positive presence cut", async () => {
    const h = await scopeFixture();
    let retainedClient: PoolClient;
    await damagedReplayStorage(
      h,
      "replay_plan",
      async (client) => {
        retainedClient = client;
      },
      async (client) => {
        let removed = false;
        const view = {
          query: async (sql: string, values: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.includes("AS retained_replay_plan_storage")) {
              expect(result.rows).toEqual([
                { retained_replay_plan_body: true, retained_replay_plan_storage: true },
              ]);
              await retainedClient.query("SET LOCAL ROLE NONE");
              expect(
                (
                  await retainedClient.query(
                    "DELETE FROM public.proofstack_replay_plans WHERE tenant_id=$1 AND plan_version_id=$2",
                    [h.scope.tenantId, h.plan.planVersionId],
                  )
                ).rowCount,
              ).toBe(1);
              await retainedClient.query(`SET LOCAL ROLE "${credentials.api.name}"`);
              removed = true;
            }
            return result;
          },
        } as Pick<PoolClient, "query">;
        await expect(
          readPostgresReplayPlanOnClient(view, h.scope, h.plan.planVersionId),
        ).rejects.toThrow("disappeared or changed scope");
        expect(removed).toBe(true);
      },
    );
  });

  for (const table of [
    "proofstack_replay_plan_budgets",
    "proofstack_replay_plan_boundaries",
  ] as const)
    it.each(["true", null])(`requires native ${table} coordinates, not %s`, async (value) => {
      const h = await scopeFixture();
      await withExactScopeTransaction(runtimePool, h.scope, async (client) => {
        let projected = false;
        const view = {
          query: async (sql: string, values: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.includes("AS coordinates_match") && sql.includes(`FROM public.${table}`)) {
              expect(result.rows[0]?.coordinates_match).toBe(true);
              result.rows[0].coordinates_match = value;
              projected = true;
            }
            return result;
          },
        } as Pick<PoolClient, "query">;
        await expect(
          readPostgresReplayPlanOnClient(view, h.scope, h.plan.planVersionId),
        ).rejects.toBeInstanceOf(ReplayRepositoryContractError);
        expect(projected).toBe(true);
      });
      await expect(repository.findReplayPlan(h.scope, h.plan.planVersionId)).resolves.toEqual(
        h.plan,
      );
    });

  it.each([
    ["retained_replay_plan_body", "true"],
    ["retained_replay_plan_body", null],
    ["retained_replay_plan_storage", "true"],
    ["retained_replay_plan_storage", null],
  ] as const)("rejects malformed native presence flag %s=%s", async (column, value) => {
    const h = await scopeFixture();
    await withExactScopeTransaction(runtimePool, h.scope, async (client) => {
      let projected = false;
      const view = {
        query: async (sql: string, values: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql.includes("AS retained_replay_plan_storage")) {
            expect(result.rows[0]?.[column]).toBe(true);
            result.rows[0][column] = value; // Explicit port corruption, not backend-produced types.
            projected = true;
          }
          return result;
        },
      } as Pick<PoolClient, "query">;
      await expect(
        readPostgresReplayPlanOnClient(view, h.scope, h.plan.planVersionId),
      ).rejects.toBeInstanceOf(ReplayRepositoryContractError);
      expect(projected).toBe(true);
    });
    await expect(repository.findReplayPlan(h.scope, h.plan.planVersionId)).resolves.toEqual(h.plan);
  });

  it.each([0, 2])("rejects %s native presence rows", async (count) => {
    const h = await scopeFixture();
    await withExactScopeTransaction(runtimePool, h.scope, async (client) => {
      let projected = false;
      const view = {
        query: async (sql: string, values: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql.includes("AS retained_replay_plan_storage")) {
            expect(result.rows).toHaveLength(1);
            result.rows = Array.from({ length: count }, () => ({ ...result.rows[0] }));
            projected = true;
          }
          return result;
        },
      } as Pick<PoolClient, "query">;
      await expect(
        readPostgresReplayPlanOnClient(view, h.scope, h.plan.planVersionId),
      ).rejects.toBeInstanceOf(ReplayRepositoryContractError);
      expect(projected).toBe(true);
    });
  });

  it("keeps the absent cut when normal plan publication follows on another connection", async () => {
    const h = await scopeFixture();
    const {
      createdAt,
      createdByPrincipalId,
      definitionSha256: _originalHash,
      ...original
    } = h.plan;
    const definition = { ...original, planVersionId: `plv_race_${runKey}` };
    const plan = ReplayPlanSchema.parse({
      ...definition,
      createdAt,
      createdByPrincipalId,
      definitionSha256: digestReplayPlanDefinition(definition),
    });
    await withExactScopeTransaction(runtimePool, h.scope, async (client) => {
      let observed = false;
      const view = {
        query: async (sql: string, values: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql.includes("AS retained_replay_plan_storage")) {
            expect(result.rows).toEqual([
              { retained_replay_plan_body: false, retained_replay_plan_storage: false },
            ]);
            observed = true;
            await repository.publishReplayPlan(plan);
          }
          return result;
        },
      } as Pick<PoolClient, "query">;
      await expect(
        readPostgresReplayPlanOnClient(view, h.scope, plan.planVersionId),
      ).resolves.toBeNull();
      expect(observed).toBe(true);
    });
    await expect(repository.findReplayPlan(h.scope, plan.planVersionId)).resolves.toEqual(plan);
  });

  it("returns one derived overflow row for forty additional boundaries", async () => {
    const h = await scopeFixture();
    expect(h.plan.boundaries).toHaveLength(1);
    await damagedReplayStorage(
      h,
      "replay_plan",
      async (client) => {
        const result = await client.query(
          `INSERT INTO public.proofstack_replay_plan_boundaries
         SELECT (jsonb_populate_record(NULL::public.proofstack_replay_plan_boundaries,
           to_jsonb(original) || jsonb_build_object('boundary_position', position,
             'boundary_id', 'bnd_extra_' || position,
             'declaration', original.declaration || jsonb_build_object('boundaryId', 'bnd_extra_' || position)))).*
         FROM public.proofstack_replay_plan_boundaries AS original CROSS JOIN generate_series(1,40) AS position
         WHERE original.tenant_id=$1 AND original.plan_version_id=$2 AND original.boundary_position=0`,
          [h.scope.tenantId, h.plan.planVersionId],
        );
        expect(result.rowCount).toBe(40);
      },
      async (client) => {
        let returned: number | undefined;
        const view = {
          query: async (sql: string, values: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.includes("ORDER BY boundary_position")) {
              expect(values.at(-1)).toBe(2);
              returned = result.rows.length;
            }
            return result;
          },
        } as Pick<PoolClient, "query">;
        await expect(
          readPostgresReplayPlanOnClient(view, h.scope, h.plan.planVersionId),
        ).rejects.toThrow("boundary row set is incomplete");
        expect(returned).toBe(2);
      },
    );
  });

  for (const kind of ["target_release", "replay_plan"] as const)
    it.each(["absent", "payload", "receipt"] as const)(
      `rejects ${kind} %s original intent damage`,
      async (mode) => {
        const h = await scopeFixture();
        const id = kind === "replay_plan" ? h.plan.planVersionId : h.release.targetReleaseId;
        await damagedReplayStorage(h, kind, async (client) => {
          const statement =
            mode === "absent"
              ? "DELETE FROM public.proofstack_outbox"
              : mode === "payload"
                ? "UPDATE public.proofstack_outbox SET payload=jsonb_set(payload, '{unexpected}', 'true'::jsonb)"
                : "UPDATE public.proofstack_outbox SET created_at=created_at+interval '1 second'";
          expect(
            (
              await client.query(`${statement} WHERE tenant_id=$1 AND aggregate_id=$2`, [
                h.scope.tenantId,
                id,
              ])
            ).rowCount,
          ).toBe(1);
        });
      },
    );

  it.each(["all", "budgets_only", "boundaries_only"] as const)(
    "rejects missing plan bodies with %s child ownership",
    async (mode) => {
      const h = await scopeFixture();
      await damagedReplayStorage(h, "replay_plan", async (client) => {
        const values = [h.scope.tenantId, h.plan.planVersionId];
        expect(
          (
            await client.query(
              "DELETE FROM public.proofstack_replay_plans WHERE tenant_id=$1 AND plan_version_id=$2",
              values,
            )
          ).rowCount,
        ).toBe(1);
        if (mode !== "all") {
          const table =
            mode === "budgets_only"
              ? "proofstack_replay_plan_boundaries"
              : "proofstack_replay_plan_budgets";
          expect(
            (
              await client.query(
                `DELETE FROM public.${table} WHERE tenant_id=$1 AND plan_version_id=$2`,
                values,
              )
            ).rowCount,
          ).toBeGreaterThan(0);
        }
      });
    },
  );

  for (const table of [
    "proofstack_replay_plan_budgets",
    "proofstack_replay_plan_boundaries",
  ] as const)
    it.each(["project_id", "environment_id", "plan_id"] as const)(
      `rejects ${table} %s disagreement`,
      async (column) => {
        const h = await scopeFixture();
        await damagedReplayStorage(h, "replay_plan", async (client) => {
          expect(
            (
              await client.query(
                `UPDATE public.${table} SET ${column}=$3 WHERE tenant_id=$1 AND plan_version_id=$2`,
                [h.scope.tenantId, h.plan.planVersionId, "other_coordinate"],
              )
            ).rowCount,
          ).toBeGreaterThan(0);
        });
      },
    );
});

describe("replay definition scope before normalized projections and child reads", () => {
  for (const kind of ["replay_plan", "target_release"] as const) {
    it(`keeps damaged outside ${kind} opaque under the existing API role`, async () => {
      const h = await scopeFixture();
      const isPlan = kind === "replay_plan";
      const table = isPlan ? "proofstack_replay_plans" : "proofstack_target_releases";
      const idColumn = isPlan ? "plan_version_id" : "target_release_id";
      const bodyColumn = isPlan ? "plan" : "release";
      const record = isPlan ? h.plan : h.release;
      const id = isPlan ? h.plan.planVersionId : h.release.targetReleaseId;
      const read = (client: Pick<PoolClient, "query">, scope: EvidenceScope) =>
        isPlan
          ? readPostgresReplayPlanOnClient(client, scope, id)
          : readPostgresTargetReleaseOnClient(client, scope, id);
      const find = (scope: EvidenceScope) =>
        isPlan ? repository.findReplayPlan(scope, id) : repository.findTargetRelease(scope, id);
      const before = await scopeFingerprint(h.scope);
      const outside = ["tenantId", "projectId", "environmentId"].map((dimension) => ({
        ...h.scope,
        [dimension]: "other_scope",
      }));
      for (const scope of outside) await expect(find(scope)).resolves.toBeNull();
      try {
        for (const [index, scope] of [...outside, h.scope].entries()) {
          await withExactScopeTransaction(adminPool, scope, async (client) => {
            await client.query("SAVEPOINT retained_original");
            try {
              await client.query("SET LOCAL session_replication_role = 'replica'");
              const digest = `${record.definitionSha256[0] === "f" ? "e" : "f"}${record.definitionSha256.slice(1)}`;
              expect(
                (
                  await client.query(
                    `UPDATE public.${table} SET definition_sha256 = $3::text, ${bodyColumn} = jsonb_set(${bodyColumn}, '{definitionSha256}', to_jsonb($3::text)) WHERE tenant_id = $1 AND ${idColumn} = $2`,
                    [h.scope.tenantId, id, digest],
                  )
                ).rowCount,
              ).toBe(1);
              await client.query(`SET LOCAL ROLE "${credentials.api.name}"`);
              const rows: number[] = [];
              const view = {
                query: async (sql: string, values?: unknown[]) => {
                  expect(sql.trim()).toMatch(/^SELECT\b/);
                  const result = await client.query(sql, values);
                  if (isPlan && index < 3) {
                    expect(sql).toContain("AS retained_replay_plan_storage");
                    expect(result.rows).toEqual([
                      {
                        retained_replay_plan_body: false,
                        retained_replay_plan_storage: false,
                      },
                    ]);
                  }
                  rows.push(result.rows.length);
                  return result;
                },
              } as Pick<PoolClient, "query">;
              if (index < 3) {
                await expect(read(view, scope)).resolves.toBeNull();
                expect(rows).toEqual([isPlan ? 1 : 0]);
              } else await expect(read(view, scope)).rejects.toThrow(/canonical|contract/);
            } finally {
              await client.query("ROLLBACK TO SAVEPOINT retained_original");
            }
          });
        }
      } finally {
        expect(await scopeFingerprint(h.scope)).toBe(before);
        await expect(find(h.scope)).resolves.toEqual(record);
      }
    });
  }
  it.each(["proofstack_replay_plan_budgets", "proofstack_replay_plan_boundaries"] as const)(
    "does not read damaged %s rows for an outside plan",
    async (table) => {
      const h = await scopeFixture();
      const before = await scopeFingerprint(h.scope);
      try {
        for (const [index, scope] of [
          { ...h.scope, projectId: "other_scope" },
          { ...h.scope, environmentId: "other_scope" },
          h.scope,
        ].entries()) {
          await withExactScopeTransaction(adminPool, scope, async (client) => {
            await client.query("SAVEPOINT retained_original");
            try {
              await client.query("SET LOCAL session_replication_role = 'replica'");
              expect(
                (
                  await client.query(
                    `DELETE FROM public.${table} WHERE tenant_id = $1 AND plan_version_id = $2`,
                    [h.scope.tenantId, h.plan.planVersionId],
                  )
                ).rowCount,
              ).toBeGreaterThan(0);
              await client.query(`SET LOCAL ROLE "${credentials.api.name}"`);
              const rows: number[] = [];
              const view = {
                query: async (sql: string, values?: unknown[]) => {
                  expect(sql.trim()).toMatch(/^SELECT\b/);
                  const result = await client.query(sql, values);
                  if (index < 2) {
                    expect(sql).toContain("AS retained_replay_plan_storage");
                    expect(result.rows).toEqual([
                      {
                        retained_replay_plan_body: false,
                        retained_replay_plan_storage: false,
                      },
                    ]);
                  }
                  rows.push(result.rows.length);
                  return result;
                },
              } as Pick<PoolClient, "query">;
              if (index < 2) {
                await expect(
                  readPostgresReplayPlanOnClient(view, scope, h.plan.planVersionId),
                ).resolves.toBeNull();
                expect(rows).toEqual([1]);
              } else
                await expect(
                  readPostgresReplayPlanOnClient(view, scope, h.plan.planVersionId),
                ).rejects.toThrow(
                  table === "proofstack_replay_plan_budgets"
                    ? "budget row set is incomplete"
                    : "boundary row set is incomplete",
                );
            } finally {
              await client.query("ROLLBACK TO SAVEPOINT retained_original");
            }
          });
        }
      } finally {
        expect(await scopeFingerprint(h.scope)).toBe(before);
        await expect(repository.findReplayPlan(h.scope, h.plan.planVersionId)).resolves.toEqual(
          h.plan,
        );
      }
    },
  );
});
