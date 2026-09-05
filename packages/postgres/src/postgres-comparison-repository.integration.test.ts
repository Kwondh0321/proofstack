import { randomUUID } from "node:crypto";
import {
  ComparisonLineageError,
  ComparisonRepositoryContractError,
  comparisonRecordId,
} from "@proofstack/core";
import {
  comparisonDefinitionFixture,
  comparisonRepositoryConformanceCases,
  comparisonResultFixture,
  comparisonSnapshotFixture,
  createComparisonRepositoryTestHarness,
  publishComparisonFixture,
  type ComparisonRepositoryFixtureRecord,
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
import { withTenantTransaction } from "./tenant-transaction.js";

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

interface TenantComparisonGraph {
  readonly definition: ReturnType<typeof comparisonDefinitionFixture>;
  readonly records: readonly ComparisonRepositoryFixtureRecord[];
  readonly scope: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly tenantId: string;
  };
}

function tenantComparisonGraph(
  label: string,
  namespace = `matrix_${runKey}`,
): TenantComparisonGraph {
  const scope = {
    environmentId: `env_matrix_${runKey}`,
    projectId: `prj_matrix_${runKey}`,
    tenantId: `ten_matrix_${label}_${runKey}`,
  };
  const definition = comparisonDefinitionFixture(namespace, scope, {
    description: `Three-tenant isolation fixture owned by ${label}`,
  });
  const baseline = comparisonSnapshotFixture(namespace, scope, definition, "baseline");
  const candidate = comparisonSnapshotFixture(namespace, scope, definition, "candidate");
  const result = comparisonResultFixture(namespace, scope, definition, baseline, candidate);
  return {
    definition,
    records: [
      { kind: "comparison_definition", record: definition },
      { kind: "comparison_evidence_snapshot", record: baseline },
      { kind: "comparison_evidence_snapshot", record: candidate },
      { kind: "comparison_result", record: result },
    ],
    scope,
  };
}

async function findComparisonFixture(
  repository: PostgresComparisonRepository,
  scope: TenantComparisonGraph["scope"],
  fixture: ComparisonRepositoryFixtureRecord,
) {
  switch (fixture.kind) {
    case "comparison_definition":
      return repository.findComparisonDefinition(scope, fixture.record.comparisonVersionId);
    case "comparison_evidence_snapshot":
      return repository.findComparisonEvidenceSnapshot(scope, fixture.record.snapshotId);
    case "comparison_result":
      return repository.findComparisonResult(scope, fixture.record.resultId);
  }
}

function definitionCommand(
  fixture: ComparisonRepositoryFixtureRecord,
): Readonly<Record<string, unknown>> {
  if (fixture.kind !== "comparison_definition") {
    throw new Error("Expected a comparison definition command fixture");
  }
  const { record } = fixture;
  return {
    actorPrincipalId: record.createdByPrincipalId,
    comparisonId: record.comparisonId,
    comparisonRole: null,
    comparisonVersionId: record.comparisonVersionId,
    createdAt: record.createdAt,
    definitionSha256: record.definitionSha256,
    environmentId: record.scope.environmentId,
    projectId: record.scope.projectId,
    record,
    recordId: record.comparisonVersionId,
    recordKind: fixture.kind,
    schemaVersion: record.schemaVersion,
    tenantId: record.scope.tenantId,
  };
}

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

  it("isolates colliding identities, guessed reads, lineage, writes, and pooled context across three tenants", async () => {
    const isolationPool = new Pool({
      connectionString: connectionStringFor(credentials.api),
      max: 1,
    });
    const repository = new PostgresComparisonRepository(isolationPool);
    const graphs = [
      tenantComparisonGraph("alpha"),
      tenantComparisonGraph("beta"),
      tenantComparisonGraph("gamma"),
    ] as const;

    try {
      for (const graph of graphs) {
        for (const fixture of graph.records) {
          await publishComparisonFixture(repository, fixture);
        }
      }

      const definitions = graphs.map(({ definition }) => definition);
      expect(new Set(definitions.map(({ comparisonVersionId }) => comparisonVersionId)).size).toBe(
        1,
      );
      expect(new Set(definitions.map(({ definitionSha256 }) => definitionSha256)).size).toBe(3);

      for (const graph of graphs) {
        for (const fixture of graph.records) {
          await expect(findComparisonFixture(repository, graph.scope, fixture)).resolves.toEqual(
            fixture.record,
          );
        }

        const visible = await withTenantTransaction(isolationPool, graph.scope.tenantId, (client) =>
          client.query<{
            readonly binding_tenants: readonly string[];
            readonly lineage_tenants: readonly string[];
            readonly record_count: number;
            readonly record_tenants: readonly string[];
            readonly registry_tenants: readonly string[];
            readonly tenant_context: string;
          }>(`
              SELECT
                current_setting('proofstack.tenant_id') AS tenant_context,
                ARRAY(
                  SELECT DISTINCT tenant_id
                  FROM public.proofstack_comparison_record_registry
                  ORDER BY tenant_id
                ) AS registry_tenants,
                ARRAY(
                  SELECT DISTINCT tenant_id
                  FROM public.proofstack_comparison_resource_bindings
                  ORDER BY tenant_id
                ) AS binding_tenants,
                ARRAY(
                  SELECT DISTINCT tenant_id
                  FROM public.proofstack_comparison_lineage
                  ORDER BY tenant_id
                ) AS lineage_tenants,
                ARRAY(
                  SELECT DISTINCT tenant_id
                  FROM public.proofstack_comparison_records
                  ORDER BY tenant_id
                ) AS record_tenants,
                (
                  SELECT count(*)::integer
                  FROM public.proofstack_comparison_records
                ) AS record_count
            `),
        );
        expect(visible.rows).toEqual([
          {
            binding_tenants: [graph.scope.tenantId],
            lineage_tenants: [graph.scope.tenantId],
            record_count: graph.records.length,
            record_tenants: [graph.scope.tenantId],
            registry_tenants: [graph.scope.tenantId],
            tenant_context: graph.scope.tenantId,
          },
        ]);
      }

      const alpha = graphs[0];
      const beta = graphs[1];
      const gamma = graphs[2];
      const alphaPrivate = tenantComparisonGraph("alpha", `matrix_private_${runKey}`);
      for (const fixture of alphaPrivate.records) {
        await publishComparisonFixture(repository, fixture);
        await expect(findComparisonFixture(repository, beta.scope, fixture)).resolves.toBeNull();
        await expect(findComparisonFixture(repository, gamma.scope, fixture)).resolves.toBeNull();
      }
      await expect(
        repository.findComparisonDefinition(beta.scope, `comparison_absent_${runKey}`),
      ).resolves.toBeNull();
      await expect(
        repository.findComparisonEvidenceSnapshot(beta.scope, `snapshot_absent_${runKey}`),
      ).resolves.toBeNull();
      await expect(
        repository.findComparisonResult(beta.scope, `result_absent_${runKey}`),
      ).resolves.toBeNull();

      const betaDefinition = definitions[1];
      if (!betaDefinition) throw new Error("Expected the beta definition fixture");
      const crossTenantSnapshot = comparisonSnapshotFixture(
        `matrix_cross_${runKey}`,
        alpha.scope,
        betaDefinition,
        "candidate",
      );
      await expect(
        repository.publishComparisonEvidenceSnapshot(crossTenantSnapshot),
      ).rejects.toBeInstanceOf(ComparisonLineageError);
      await expect(
        repository.findComparisonEvidenceSnapshot(alpha.scope, crossTenantSnapshot.snapshotId),
      ).resolves.toBeNull();

      const forgedDefinition = comparisonDefinitionFixture(`matrix_forged_${runKey}`, alpha.scope);
      const forgedFixture = {
        kind: "comparison_definition",
        record: forgedDefinition,
      } as const satisfies ComparisonRepositoryFixtureRecord;
      await expect(
        isolationPool.query("SELECT public.proofstack_publish_comparison_record($1::jsonb)", [
          JSON.stringify(definitionCommand(forgedFixture)),
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        withTenantTransaction(isolationPool, beta.scope.tenantId, (client) =>
          client.query("SELECT public.proofstack_publish_comparison_record($1::jsonb)", [
            JSON.stringify(definitionCommand(forgedFixture)),
          ]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        repository.findComparisonDefinition(alpha.scope, forgedDefinition.comparisonVersionId),
      ).resolves.toBeNull();

      const unscoped = await isolationPool.query<{
        readonly binding_count: number;
        readonly lineage_count: number;
        readonly record_count: number;
        readonly registry_count: number;
        readonly tenant_context: string | null;
      }>(`
        SELECT
          NULLIF(current_setting('proofstack.tenant_id', true), '') AS tenant_context,
          (SELECT count(*)::integer FROM public.proofstack_comparison_record_registry)
            AS registry_count,
          (SELECT count(*)::integer FROM public.proofstack_comparison_resource_bindings)
            AS binding_count,
          (SELECT count(*)::integer FROM public.proofstack_comparison_lineage)
            AS lineage_count,
          (SELECT count(*)::integer FROM public.proofstack_comparison_records)
            AS record_count
      `);
      expect(unscoped.rows).toEqual([
        {
          binding_count: 0,
          lineage_count: 0,
          record_count: 0,
          registry_count: 0,
          tenant_context: null,
        },
      ]);
    } finally {
      await isolationPool.end();
    }
  });
});
