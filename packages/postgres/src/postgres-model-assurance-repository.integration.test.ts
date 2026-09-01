import { randomUUID } from "node:crypto";
import {
  CreateModelAssuranceAssessment,
  type ModelAssuranceRecordKind,
  ModelAssuranceRepositoryContractError,
  modelAssuranceRecordId,
} from "@proofstack/core";
import {
  createModelAssuranceRepositoryTestHarness,
  FixedClock,
  type ModelAssuranceRepositoryFixtureRecord,
  publishEvaluationFixture,
} from "@proofstack/core/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresEvaluationRepository } from "./postgres-evaluation-repository.js";
import { PostgresModelAssuranceRepository } from "./postgres-model-assurance-repository.js";
import {
  provisionRuntimeRoles,
  type RuntimeRoleCredentials,
  type RuntimeRoleProvisioningOptions,
} from "./runtime-roles.js";

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

function repositoryFor(fixture: ModelAssuranceRepositoryFixtureRecord) {
  if (fixture.kind === "human_review_record") {
    return new PostgresModelAssuranceRepository(humanReviewerPool);
  }
  if (modelExecutionKinds.has(fixture.kind)) {
    return new PostgresModelAssuranceRepository(modelWorkerPool);
  }
  return new PostgresModelAssuranceRepository(apiPool);
}

async function publishAssuranceFixture(fixture: ModelAssuranceRepositoryFixtureRecord) {
  return repositoryFor(fixture).publish(fixture.kind, fixture.record as never);
}

describe("PostgresModelAssuranceRepository", () => {
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
    expect(persisted.rows).toEqual([{ count: "18" }]);
    expect(intents.rows).toEqual([{ count: "18" }]);
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
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.publish(profile.kind, structuredClone(profile.record)),
      ),
    );
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(results.filter(({ created }) => !created)).toHaveLength(7);

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
  });
});
