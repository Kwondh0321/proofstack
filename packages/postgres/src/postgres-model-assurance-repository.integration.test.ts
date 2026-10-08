import { randomUUID } from "node:crypto";
import {
  AuthoritySplitModelAssuranceRepository,
  CreateModelAssuranceAssessment,
  type ModelAssuranceRecordKind,
  ModelAssuranceRepositoryContractError,
  modelAssuranceRecordId,
  validateModelAssuranceRecord,
} from "@proofstack/core";
import {
  createModelAssuranceRepositoryTestHarness,
  FixedClock,
  type ModelAssuranceRepositoryFixtureRecord,
  modelAssuranceRetryConformanceCases,
  publishEvaluationFixture,
} from "@proofstack/core/testing";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresEvaluationRepository } from "./postgres-evaluation-repository.js";
import {
  PostgresModelAssuranceRepository,
  readPostgresModelAssuranceRecordOnClient,
} from "./postgres-model-assurance-repository.js";
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

const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const credentials = {
  api: {
    name: `ps_assurance_api_${runKey}`,
    password: `proofstack-assurance-api-${runKey}`,
  },
  artifact: {
    name: `ps_assurance_art_${runKey}`,
    password: `proofstack-assurance-artifact-${runKey}`,
  },
  consumer: {
    name: `ps_assurance_con_${runKey}`,
    password: `proofstack-assurance-consumer-${runKey}`,
  },
  evaluationWorker: {
    name: `ps_assurance_eval_${runKey}`,
    password: `proofstack-assurance-evaluation-${runKey}`,
  },
  humanReviewer: {
    name: `ps_assurance_human_${runKey}`,
    password: `proofstack-assurance-human-${runKey}`,
  },
  identity: {
    name: `ps_assurance_id_${runKey}`,
    password: `proofstack-assurance-identity-${runKey}`,
  },
  modelEvaluationWorker: {
    name: `ps_assurance_model_${runKey}`,
    password: `proofstack-assurance-model-${runKey}`,
  },
  policyAuthor: {
    name: `ps_assurance_policy_${runKey}`,
    password: `proofstack-assurance-policy-${runKey}`,
  },
  publisher: {
    name: `ps_assurance_pub_${runKey}`,
    password: `proofstack-assurance-publisher-${runKey}`,
  },
  replayWorker: {
    name: `ps_assurance_replay_${runKey}`,
    password: `proofstack-assurance-replay-${runKey}`,
  },
} as const satisfies RuntimeRoleProvisioningOptions;

function connectionStringFor(role: RuntimeRoleCredentials): string {
  const url = new URL(databaseUrl as string);
  url.username = role.name;
  url.password = role.password;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
const apiPool = new Pool({ connectionString: connectionStringFor(credentials.api), max: 8 });
const evaluationWorkerPool = new Pool({
  connectionString: connectionStringFor(credentials.evaluationWorker),
  max: 4,
});
const humanReviewerPool = new Pool({
  connectionString: connectionStringFor(credentials.humanReviewer),
  max: 4,
});
const modelWorkerPool = new Pool({
  connectionString: connectionStringFor(credentials.modelEvaluationWorker),
  max: 8,
});

const evaluationExecutionKinds = new Set([
  "evaluation_aggregate",
  "evaluation_run_result",
  "qualification_report",
  "raw_observation",
]);
const modelExecutionKinds = new Set<ModelAssuranceRecordKind>([
  "blinded_evaluation_result",
  "independent_critique",
  "model_qualification_report",
]);

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, credentials);
});

afterAll(async () => {
  await Promise.all([
    apiPool.end(),
    evaluationWorkerPool.end(),
    humanReviewerPool.end(),
    modelWorkerPool.end(),
  ]);
  for (const { name } of Object.values(credentials)) {
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

async function publishBaseGraph(
  harness: Awaited<ReturnType<typeof createModelAssuranceRepositoryTestHarness>>,
): Promise<void> {
  const control = new PostgresEvaluationRepository(apiPool);
  const execution = new PostgresEvaluationRepository(evaluationWorkerPool);
  for (const fixture of harness.evaluation.records) {
    await publishEvaluationFixture(
      evaluationExecutionKinds.has(fixture.kind) ? execution : control,
      fixture,
    );
  }
}

function poolFor(fixture: ModelAssuranceRepositoryFixtureRecord) {
  if (fixture.kind === "human_review_record") {
    return humanReviewerPool;
  }
  if (modelExecutionKinds.has(fixture.kind)) {
    return modelWorkerPool;
  }
  return apiPool;
}

function repositoryFor(fixture: ModelAssuranceRepositoryFixtureRecord) {
  return new PostgresModelAssuranceRepository(poolFor(fixture));
}

async function publishAssuranceFixture(fixture: ModelAssuranceRepositoryFixtureRecord) {
  return repositoryFor(fixture).publish(fixture.kind, fixture.record as never);
}

function rawCommand(fixture: ModelAssuranceRepositoryFixtureRecord) {
  const r = fixture.record as unknown as Record<string, unknown>;
  return {
    actorPrincipalId:
      r["publishedByPrincipalId"] ??
      r["recordedByPrincipalId"] ??
      r["executedByPrincipalId"] ??
      r["reviewedByPrincipalId"] ??
      (r["reviewer"] as { principalId?: string } | undefined)?.principalId ??
      null,
    definitionSha256: fixture.record.definitionSha256,
    environmentId: fixture.record.scope.environmentId,
    lifecycleState:
      r["status"] ??
      r["action"] ??
      r["reviewStatus"] ??
      (r["outcome"] as { status?: string } | undefined)?.status ??
      r["eligibility"] ??
      null,
    projectId: fixture.record.scope.projectId,
    record: fixture.record,
    recordedAt: r["publishedAt"] ?? r["recordedAt"],
    recordId: modelAssuranceRecordId(fixture.kind, fixture.record),
    recordKind: fixture.kind,
    schemaVersion: fixture.record.schemaVersion,
    tenantId: fixture.record.scope.tenantId,
  };
}

async function rawPublish(fixture: ModelAssuranceRepositoryFixtureRecord, command: unknown) {
  const fn =
    fixture.kind === "human_review_record"
      ? "public.proofstack_publish_model_assurance_human_review_record"
      : modelExecutionKinds.has(fixture.kind)
        ? "public.proofstack_publish_model_assurance_execution_record"
        : "public.proofstack_publish_model_assurance_control_record";
  await withExactScopeTransaction(poolFor(fixture), fixture.record.scope, async (client) => {
    await client.query(`SELECT ${fn}($1::jsonb)`, [JSON.stringify(command)]);
  });
}

async function retainedState(tenantId: string) {
  const state: unknown[] = [];
  for (const table of [
    "proofstack_evaluation_record_registry",
    "proofstack_evaluation_lineage",
    "proofstack_model_assurance_records",
    "proofstack_outbox",
  ]) {
    state.push(
      (
        await adminPool.query(
          `SELECT to_jsonb(item) AS record FROM public.${table} AS item
       WHERE tenant_id = $1 ORDER BY to_jsonb(item)::text`,
          [tenantId],
        )
      ).rows,
    );
  }
  return state;
}

const requiredActors = [
  "blinded_evaluation_plan",
  "blinded_evaluation_result",
  "calibration_report",
  "human_review_protocol",
  "human_review_record",
  "human_reviewer_independence",
  "independence_declaration",
  "independent_critique",
  "model_assisted_evaluator",
  "model_evaluator_profile",
  "model_qualification_report",
  "model_qualification_suite",
] as const satisfies readonly ModelAssuranceRecordKind[];
const requiredStates = [
  "blinded_evaluation_result",
  "calibration_report",
  "human_review_record",
  "human_reviewer_independence",
  "independence_declaration",
  "independent_critique",
  "model_assurance_assessment",
  "model_qualification_report",
] as const satisfies readonly ModelAssuranceRecordKind[];

describe("model-assurance scalar integrity through actual runtime publication", () => {
  it.each([
    ...requiredActors.map((kind) => ({ kind, field: "actorPrincipalId" as const })),
    ...requiredStates.map((kind) => ({ kind, field: "lifecycleState" as const })),
  ])(
    "rejects missing $field for $kind without partial records or intent",
    async ({ kind, field }) => {
      const harness = await createModelAssuranceRepositoryTestHarness(
        `sc_${runKey}_${randomUUID().replaceAll("-", "").slice(0, 6)}`,
      );
      let fixture = harness.records.find((f) => f.kind === kind);
      if (kind === "model_assurance_assessment") {
        const result = await new CreateModelAssuranceAssessment({
          clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
          evaluationRepository: harness.evaluation.repository,
          modelAssuranceRepository: harness.repository,
        }).execute(harness.command);
        fixture = { kind, record: result.record };
      }
      if (!fixture) throw new Error("Missing scalar integrity fixture");
      await publishBaseGraph(harness);
      for (const f of harness.records) {
        if (f === fixture) break;
        await publishAssuranceFixture(f);
      }
      const before = await retainedState(fixture.record.scope.tenantId);
      await expect(
        rawPublish(fixture, { ...rawCommand(fixture), [field]: null }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "proofstack_model_assurance_records_scalar_integrity",
      });
      expect(await retainedState(fixture.record.scope.tenantId)).toEqual(before);
      await expect(publishAssuranceFixture(fixture)).resolves.toMatchObject({
        created: true,
        record: fixture.record,
      });
      await expect(
        repositoryFor(fixture).find(
          fixture.record.scope,
          kind,
          modelAssuranceRecordId(kind, fixture.record),
        ),
      ).resolves.toEqual(fixture.record);
    },
  );

  it.each([
    "schemaVersion",
    "definitionSha256",
    "tenantId",
    "projectId",
    "environmentId",
    "modelProfileVersionId",
    "publishedAt",
    "publishedByPrincipalId",
  ])("rejects an absent canonical %s instead of accepting SQL UNKNOWN", async (key) => {
    const harness = await createModelAssuranceRepositoryTestHarness(
      `ms_${runKey}_${randomUUID().replaceAll("-", "").slice(0, 6)}`,
    );
    const fixture = harness.records.find((f) => f.kind === "model_evaluator_profile");
    if (!fixture) throw new Error("Missing profile fixture");
    const body = structuredClone(fixture.record) as unknown as Record<string, unknown>;
    const scope = body["scope"] as Record<string, unknown>;
    if (["tenantId", "projectId", "environmentId"].includes(key)) delete scope[key];
    else delete body[key];
    const before = await retainedState(fixture.record.scope.tenantId);
    await expect(
      rawPublish(fixture, { ...rawCommand(fixture), record: body }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "proofstack_model_assurance_records_scalar_integrity",
    });
    expect(await retainedState(fixture.record.scope.tenantId)).toEqual(before);
  });

  it.each(["false::boolean", "'true'::text"])(
    "rejects a nonmatching native receipt projection %s",
    async (projection) => {
      const harness = await createModelAssuranceRepositoryTestHarness(
        `native_${runKey}_${projection.startsWith("false") ? "false" : "text"}`,
      );
      const fixture = harness.records.find((f) => f.kind === "model_evaluator_profile");
      if (!fixture) throw new Error("Missing profile fixture");
      await publishAssuranceFixture(fixture);
      await withExactScopeTransaction(apiPool, fixture.record.scope, async (client) => {
        let projected = false;
        const view = {
          query: (sql: string, parameters: unknown[]) => {
            const expression =
              "recorded_at = recorded_at_lexical::timestamptz AS recorded_at_matches";
            if (!sql.includes("AS recorded_at_matches")) return client.query(sql, parameters);
            expect(sql).toContain(expression);
            projected = true;
            // Real backend response, intentionally wrong boolean/type projection; no stored row mutation.
            return client.query(
              sql.replace(expression, `${projection} AS recorded_at_matches`),
              parameters,
            );
          },
        } as Pick<PoolClient, "query">;
        await expect(
          readPostgresModelAssuranceRecordOnClient(
            view,
            fixture.record.scope,
            fixture.kind,
            modelAssuranceRecordId(fixture.kind, fixture.record),
          ),
        ).rejects.toBeInstanceOf(ModelAssuranceRepositoryContractError);
        expect(projected).toBe(true);
      });
      await expect(
        repositoryFor(fixture).find(
          fixture.record.scope,
          fixture.kind,
          modelAssuranceRecordId(fixture.kind, fixture.record),
        ),
      ).resolves.toEqual(fixture.record);
    },
  );
});

describe("PostgresModelAssuranceRepository", () => {
  it.each(["absent", "conflicting_original", "incoming_only"] as const)(
    "rejects %s intent on a same-definition retry without repairing or rewriting evidence",
    async (mode) => {
      const h = await createModelAssuranceRepositoryTestHarness(
        `intent_${runKey}_${mode === "absent" ? "a" : mode === "incoming_only" ? "i" : "c"}`,
      );
      const f = h.records.find(({ kind }) => kind === "model_evaluator_profile");
      if (f?.kind !== "model_evaluator_profile") throw new Error("Missing retry intent fixture");
      const repository = new PostgresModelAssuranceRepository(apiPool);
      await repository.publish(f.kind, f.record);
      const candidate = {
        ...f.record,
        publishedAt: "2026-09-02T00:00:00.000Z",
        publishedByPrincipalId: "usr_retry_publisher",
      };
      expect(validateModelAssuranceRecord(f.kind, candidate).definitionSha256).toBe(
        f.record.definitionSha256,
      );
      const id = modelAssuranceRecordId(f.kind, f.record);
      await withExactScopeTransaction(adminPool, f.record.scope, async (client) => {
        // Deliberately damaged task-owned fixture; ordinary roles cannot mutate original intents.
        // CHECK constraints remain active, and the scope/replication setting is transaction-local.
        await client.query("SET LOCAL session_replication_role = 'replica'");
        if (mode === "absent") {
          await client.query(
            "DELETE FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_type=$2 AND aggregate_id=$3",
            [f.record.scope.tenantId, `model_assurance_${f.kind}`, id],
          );
        } else {
          await client.query(
            "UPDATE public.proofstack_outbox SET payload=$4::jsonb, created_at=$5::timestamptz WHERE tenant_id=$1 AND aggregate_type=$2 AND aggregate_id=$3",
            [
              f.record.scope.tenantId,
              `model_assurance_${f.kind}`,
              id,
              JSON.stringify(
                mode === "incoming_only"
                  ? { record: candidate, recordKind: f.kind }
                  : { damaged: true },
              ),
              mode === "incoming_only" ? candidate.publishedAt : f.record.publishedAt,
            ],
          );
        }
      });
      await withExactScopeTransaction(apiPool, f.record.scope, async (client) => {
        const statuses: string[] = [];
        for (const record of [f.record, candidate]) {
          const result = await client.query(
            "SELECT public.proofstack_evaluation_intent_status($1, $2, $3, $4, $5::jsonb, $6::timestamptz) AS status",
            [
              "model_assurance.definition.published",
              `model_assurance_${f.kind}`,
              id,
              record.schemaVersion,
              JSON.stringify({ record, recordKind: f.kind }),
              record.publishedAt,
            ],
          );
          statuses.push(result.rows[0]?.status);
        }
        expect(statuses).toEqual(
          mode === "absent"
            ? ["absent", "absent"]
            : mode === "incoming_only"
              ? ["conflict", "canonical"]
              : ["conflict", "conflict"],
        );
      });
      const before = await retainedState(f.record.scope.tenantId);
      await expect(repository.publish(f.kind, candidate)).rejects.toBeInstanceOf(
        ModelAssuranceRepositoryContractError,
      );
      expect(await retainedState(f.record.scope.tenantId)).toEqual(before);
      await expect(repository.find(f.record.scope, f.kind, id)).rejects.toBeInstanceOf(
        ModelAssuranceRepositoryContractError,
      );
    },
  );

  for (const [index, testCase] of modelAssuranceRetryConformanceCases.entries()) {
    it(testCase.name, async () => {
      const h = await createModelAssuranceRepositoryTestHarness(`retry_${runKey}_${index}`);
      await publishBaseGraph(h);
      for (const fixture of h.records) await publishAssuranceFixture(fixture);
      const repository = new PostgresModelAssuranceRepository(apiPool);
      const assessment = await new CreateModelAssuranceAssessment({
        clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
        evaluationRepository: new PostgresEvaluationRepository(apiPool),
        modelAssuranceRepository: repository,
      }).execute(h.command);
      const before = await retainedState(h.evaluation.scope.tenantId);
      // Writes still use the kind's real control/model-worker/human-review authority.
      const split = new AuthoritySplitModelAssuranceRepository({
        control: repository,
        execution: new PostgresModelAssuranceRepository(modelWorkerPool),
        humanReview: new PostgresModelAssuranceRepository(humanReviewerPool),
        read: repository,
      });
      await testCase.run({
        repository: split,
        records: [
          ...h.records,
          {
            kind: "model_assurance_assessment",
            record: assessment.record,
          },
        ],
      });
      expect(await retainedState(h.evaluation.scope.tenantId)).toEqual(before);
    });
  }

  it("persists and reads a complete eligible graph through disjoint authorities", async () => {
    const harness = await createModelAssuranceRepositoryTestHarness(`pg_assurance_${runKey}`);
    await publishBaseGraph(harness);

    const profile = harness.records.find(({ kind }) => kind === "model_evaluator_profile");
    const executionResult = harness.records.find(
      ({ kind }) => kind === "blinded_evaluation_result",
    );
    const humanReview = harness.records.find(({ kind }) => kind === "human_review_record");
    if (!profile || !executionResult || !humanReview) {
      throw new Error("Expected complete authority probes");
    }
    await expect(
      new PostgresModelAssuranceRepository(modelWorkerPool).publish(
        profile.kind,
        profile.record as never,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      new PostgresModelAssuranceRepository(apiPool).publish(
        executionResult.kind,
        executionResult.record as never,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      new PostgresModelAssuranceRepository(modelWorkerPool).publish(
        humanReview.kind,
        humanReview.record as never,
      ),
    ).rejects.toMatchObject({ code: "42501" });

    for (const fixture of harness.records) await publishAssuranceFixture(fixture);
    const assessment = await new CreateModelAssuranceAssessment({
      clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
      evaluationRepository: new PostgresEvaluationRepository(apiPool),
      modelAssuranceRepository: new PostgresModelAssuranceRepository(apiPool),
    }).execute(harness.command);
    expect(assessment).toMatchObject({
      created: true,
      record: { eligibility: "eligible", reasons: [] },
    });

    const restartedPool = new Pool({
      connectionString: connectionStringFor(credentials.api),
      max: 1,
    });
    try {
      await expect(
        new PostgresModelAssuranceRepository(restartedPool).find(
          harness.evaluation.scope,
          "model_assurance_assessment",
          assessment.record.assessmentExtensionId,
        ),
      ).resolves.toEqual(assessment.record);
    } finally {
      await restartedPool.end();
    }
    await expect(
      new PostgresModelAssuranceRepository(apiPool).find(
        { ...harness.evaluation.scope, tenantId: `ten_wrong_${runKey}` },
        "model_assurance_assessment",
        assessment.record.assessmentExtensionId,
      ),
    ).resolves.toBeNull();

    const persisted = await adminPool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
       FROM public.proofstack_model_assurance_records
       WHERE tenant_id = $1`,
      [harness.evaluation.scope.tenantId],
    );
    const intents = await adminPool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
       FROM public.proofstack_outbox
       WHERE tenant_id = $1 AND aggregate_type LIKE 'model_assurance_%'`,
      [harness.evaluation.scope.tenantId],
    );
    const expectedRecordCount = String(harness.records.length + 1);
    expect(persisted.rows).toEqual([{ count: expectedRecordCount }]);
    expect(intents.rows).toEqual([{ count: expectedRecordCount }]);
    await expect(
      modelWorkerPool.query(
        "INSERT INTO public.proofstack_model_assurance_records (tenant_id) VALUES ($1)",
        [harness.evaluation.scope.tenantId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("linearizes concurrent retries into one immutable record and outbox intent", async () => {
    const harness = await createModelAssuranceRepositoryTestHarness(`pg_assurance_race_${runKey}`);
    const profile = harness.records.find(({ kind }) => kind === "model_evaluator_profile");
    if (profile?.kind !== "model_evaluator_profile") {
      throw new Error("Expected model profile race fixture");
    }
    const repository = new PostgresModelAssuranceRepository(apiPool);
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      ...structuredClone(profile.record),
      publishedAt: new Date(Date.parse(profile.record.publishedAt) + index * 1000).toISOString(),
      publishedByPrincipalId: `usr_race_${index}`,
    }));
    const before = structuredClone(candidates);
    const results = await Promise.all(
      candidates.map((candidate) => repository.publish(profile.kind, candidate)),
    );
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(results.filter(({ created }) => !created)).toHaveLength(7);
    const original = results.find(({ created }) => created)?.record;
    expect(original).toBeDefined();
    expect(results.map(({ record }) => record)).toEqual(results.map(() => original));
    expect(candidates).toEqual(before);

    const recordId = modelAssuranceRecordId(profile.kind, profile.record);
    const persisted = await adminPool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
       FROM public.proofstack_model_assurance_records
       WHERE tenant_id = $1 AND record_kind = $2 AND record_id = $3`,
      [harness.evaluation.scope.tenantId, profile.kind, recordId],
    );
    const intents = await adminPool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
       FROM public.proofstack_outbox
       WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3`,
      [harness.evaluation.scope.tenantId, `model_assurance_${profile.kind}`, recordId],
    );
    expect(persisted.rows).toEqual([{ count: "1" }]);
    expect(intents.rows).toEqual([{ count: "1" }]);
    await expect(
      repository.find(harness.evaluation.scope, profile.kind, recordId),
    ).resolves.toEqual(original);
  });

  it("fails closed when stored semantics no longer match the retained digest", async () => {
    const harness = await createModelAssuranceRepositoryTestHarness(
      `pg_assurance_corrupt_${runKey}`,
    );
    const profile = harness.records.find(({ kind }) => kind === "model_evaluator_profile");
    if (profile?.kind !== "model_evaluator_profile") {
      throw new Error("Expected model profile corruption fixture");
    }
    const repository = new PostgresModelAssuranceRepository(apiPool);
    await repository.publish(profile.kind, profile.record);
    const recordId = modelAssuranceRecordId(profile.kind, profile.record);

    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(
        `UPDATE public.proofstack_model_assurance_records
         SET record = jsonb_set(record, '{knownLimitations}', '["tampered"]'::jsonb)
         WHERE tenant_id = $1 AND record_kind = $2 AND record_id = $3`,
        [harness.evaluation.scope.tenantId, profile.kind, recordId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await expect(
      repository.find(harness.evaluation.scope, profile.kind, recordId),
    ).rejects.toBeInstanceOf(ModelAssuranceRepositoryContractError);
    for (const outside of [
      { ...harness.evaluation.scope, tenantId: `ten_outside_${runKey}` },
      { ...harness.evaluation.scope, projectId: `prj_outside_${runKey}` },
      { ...harness.evaluation.scope, environmentId: `env_outside_${runKey}` },
    ]) {
      await expect(repository.find(outside, profile.kind, recordId)).resolves.toBeNull();
    }
  });
});
