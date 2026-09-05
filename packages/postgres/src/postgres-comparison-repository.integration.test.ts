import { randomUUID } from "node:crypto";
import { ComparisonRepositoryContractError, comparisonRecordId } from "@proofstack/core";
import {
  comparisonRepositoryConformanceCases,
  createComparisonRepositoryTestHarness,
  publishComparisonFixture,
} from "@proofstack/core/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresComparisonRepository } from "./postgres-comparison-repository.js";
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
    name: `ps_comparison_api_${runKey}`,
    password: `proofstack-comparison-api-${runKey}`,
  },
  artifact: {
    name: `ps_comparison_art_${runKey}`,
    password: `proofstack-comparison-artifact-${runKey}`,
  },
  consumer: {
    name: `ps_comparison_con_${runKey}`,
    password: `proofstack-comparison-consumer-${runKey}`,
  },
  evaluationWorker: {
    name: `ps_comparison_eval_${runKey}`,
    password: `proofstack-comparison-evaluation-${runKey}`,
  },
  humanReviewer: {
    name: `ps_comparison_human_${runKey}`,
    password: `proofstack-comparison-human-${runKey}`,
  },
  identity: {
    name: `ps_comparison_id_${runKey}`,
    password: `proofstack-comparison-identity-${runKey}`,
  },
  modelEvaluationWorker: {
    name: `ps_comparison_model_${runKey}`,
    password: `proofstack-comparison-model-${runKey}`,
  },
  publisher: {
    name: `ps_comparison_pub_${runKey}`,
    password: `proofstack-comparison-publisher-${runKey}`,
  },
  replayWorker: {
    name: `ps_comparison_replay_${runKey}`,
    password: `proofstack-comparison-replay-${runKey}`,
  },
} as const satisfies RuntimeRoleProvisioningOptions;

function connectionStringFor(role: RuntimeRoleCredentials): string {
  const url = new URL(databaseUrl as string);
  url.username = role.name;
  url.password = role.password;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
const apiPool = new Pool({ connectionString: connectionStringFor(credentials.api), max: 20 });
const modelWorkerPool = new Pool({
  connectionString: connectionStringFor(credentials.modelEvaluationWorker),
  max: 2,
});

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, credentials);
});

afterAll(async () => {
  await Promise.all([apiPool.end(), modelWorkerPool.end()]);
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

describe("PostgresComparisonRepository conformance", () => {
  for (const conformanceCase of comparisonRepositoryConformanceCases) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run((namespace) => {
        const harness = createComparisonRepositoryTestHarness(`pg_${runKey}_${namespace}`);
        return {
          ...harness,
          repository: new PostgresComparisonRepository(apiPool),
        };
      });
    });
  }

  it("persists one canonical outbox intent per record across restart and retry", async () => {
    const harness = createComparisonRepositoryTestHarness(`pg_${runKey}_durability`);
    const repository = new PostgresComparisonRepository(apiPool);
    for (const fixture of harness.records) {
      await publishComparisonFixture(repository, fixture);
      await publishComparisonFixture(repository, structuredClone(fixture));
    }

    const records = await adminPool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
       FROM public.proofstack_comparison_records
       WHERE tenant_id = $1`,
      [harness.scope.tenantId],
    );
    const intents = await adminPool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
       FROM public.proofstack_outbox
       WHERE tenant_id = $1 AND event_type LIKE 'comparison.%'`,
      [harness.scope.tenantId],
    );
    expect(records.rows).toEqual([{ count: String(harness.records.length) }]);
    expect(intents.rows).toEqual([{ count: String(harness.records.length) }]);

    const resultFixture = harness.records.find(({ kind }) => kind === "comparison_result");
    if (resultFixture?.kind !== "comparison_result") {
      throw new Error("Expected comparison result durability fixture");
    }
    const restartedPool = new Pool({
      connectionString: connectionStringFor(credentials.api),
      max: 1,
    });
    try {
      await expect(
        new PostgresComparisonRepository(restartedPool).findComparisonResult(
          harness.scope,
          resultFixture.record.resultId,
        ),
      ).resolves.toEqual(resultFixture.record);
    } finally {
      await restartedPool.end();
    }
  });

  it("denies publication outside comparison management authority", async () => {
    const harness = createComparisonRepositoryTestHarness(`pg_${runKey}_authority`);
    const definition = harness.records[0];
    if (definition?.kind !== "comparison_definition") {
      throw new Error("Expected comparison authority fixture");
    }
    await expect(
      new PostgresComparisonRepository(modelWorkerPool).publishComparisonDefinition(
        definition.record,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      new PostgresComparisonRepository(apiPool).findComparisonDefinition(
        harness.scope,
        definition.record.comparisonVersionId,
      ),
    ).resolves.toBeNull();
  });

  it("fails closed when retained semantics no longer match the canonical digest", async () => {
    const harness = createComparisonRepositoryTestHarness(`pg_${runKey}_corrupt`);
    const definition = harness.records[0];
    if (definition?.kind !== "comparison_definition") {
      throw new Error("Expected comparison corruption fixture");
    }
    const repository = new PostgresComparisonRepository(apiPool);
    await repository.publishComparisonDefinition(definition.record);
    const recordId = comparisonRecordId(definition.kind, definition.record);

    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(
        `UPDATE public.proofstack_comparison_records
         SET record = jsonb_set(record, '{description}', '"tampered"'::jsonb)
         WHERE tenant_id = $1 AND record_kind = $2 AND record_id = $3`,
        [harness.scope.tenantId, definition.kind, recordId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await expect(
      repository.findComparisonDefinition(harness.scope, recordId),
    ).rejects.toBeInstanceOf(ComparisonRepositoryContractError);
  });
});
