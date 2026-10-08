import { createHash, randomUUID } from "node:crypto";
import {
  type RegressionDatasetVersion,
  RegressionDatasetVersionDefinitionSchema,
  RegressionDatasetVersionSchema,
  type RegressionFixtureVersion,
  RegressionFixtureVersionDefinitionSchema,
  RegressionFixtureVersionSchema,
} from "@proofstack/contracts";
import {
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
  RegressionRepositoryContractError,
} from "@proofstack/datasets";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import {
  PostgresRegressionVersionRepository,
  readPostgresDatasetVersionOnClient,
  readPostgresFixtureVersionOnClient,
  readPostgresRecordedInteractionFixtureContentOnClient,
  readPostgresRecordedInteractionFixtureVersionOnClient,
} from "./postgres-regression-version-repository.js";
import { provisionRuntimeRoles, type RuntimeRoleProvisioningOptions } from "./runtime-roles.js";
import { withExactScopeTransaction } from "./tenant-transaction.js";

const databaseUrl = process.env["PROOFSTACK_TEST_DATABASE_URL"];
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const key = randomUUID().replaceAll("-", "").slice(0, 12);
const credentials = Object.fromEntries(
  [
    "api",
    "artifact",
    "consumer",
    "evaluationWorker",
    "humanReviewer",
    "identity",
    "modelEvaluationWorker",
    "policyAuthor",
    "publisher",
    "replayWorker",
  ].map((kind) => [
    kind,
    {
      name: `ps_rphys_${kind.toLowerCase()}_${key}`,
      password: `proofstack-regression-fixture-${key}`,
    },
  ]),
) as unknown as RuntimeRoleProvisioningOptions;
const admin = new Pool({ connectionString: databaseUrl, max: 2 });
const apiUrl = new URL(databaseUrl);
apiUrl.username = credentials.api.name;
apiUrl.password = credentials.api.password;
const api = new Pool({ connectionString: apiUrl.toString(), max: 2 });
const scope = {
  tenantId: `tenant_rphys_${key}`,
  projectId: `project_rphys_${key}`,
  environmentId: `environment_rphys_${key}`,
};
const repository = new PostgresRegressionVersionRepository(api);
function fixtureVersion(predecessor?: RegressionFixtureVersion): RegressionFixtureVersion {
  const definition = RegressionFixtureVersionDefinitionSchema.parse({
    schemaVersion: "0.1",
    scope,
    fixtureId: `fixture_${key}`,
    fixtureVersionId: `fixture_${key}_${predecessor ? "v2" : "v1"}`,
    name: "Storage integrity fixture",
    ...(predecessor
      ? {
          predecessor: {
            fixtureVersionId: predecessor.fixtureVersionId,
            definitionSha256: predecessor.definitionSha256,
          },
        }
      : {}),
    replayability: "evidence_only",
    source: {
      kind: "trace_snapshot",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      eventIds: ["event_storage_start", "event_storage_end"],
      observedEventCount: 2,
      sourceCompleteness: "observed_snapshot",
    },
  });
  return RegressionFixtureVersionSchema.parse({
    ...definition,
    source: { ...definition.source, capturedAt: "2026-10-01T00:00:00.000Z" },
    createdAt: predecessor ? "2026-10-01T00:00:02.000Z" : "2026-10-01T00:00:01.000Z",
    createdByPrincipalId: `principal_${key}`,
    definitionSha256: digestRegressionFixtureVersionDefinition(definition),
  });
}
const fixtureRoot = fixtureVersion();
const fixtureNext = fixtureVersion(fixtureRoot);
function datasetVersion(predecessor?: RegressionDatasetVersion): RegressionDatasetVersion {
  const definition = RegressionDatasetVersionDefinitionSchema.parse({
    schemaVersion: "0.1",
    scope,
    datasetId: `dataset_${key}`,
    datasetVersionId: `dataset_${key}_${predecessor ? "v2" : "v1"}`,
    name: "Storage integrity dataset",
    ...(predecessor
      ? {
          predecessor: {
            datasetVersionId: predecessor.datasetVersionId,
            definitionSha256: predecessor.definitionSha256,
          },
        }
      : {}),
    fixtureVersions: [
      {
        fixtureId: fixtureRoot.fixtureId,
        fixtureVersionId: fixtureRoot.fixtureVersionId,
        definitionSha256: fixtureRoot.definitionSha256,
      },
    ],
  });
  return RegressionDatasetVersionSchema.parse({
    ...definition,
    createdAt: predecessor ? "2026-10-01T00:00:04.000Z" : "2026-10-01T00:00:03.000Z",
    createdByPrincipalId: `principal_${key}`,
    definitionSha256: digestRegressionDatasetVersionDefinition(definition),
  });
}
const datasetRoot = datasetVersion();
const datasetNext = datasetVersion(datasetRoot);
const tables = [
  "proofstack_regression_fixtures",
  "proofstack_regression_fixture_versions",
  "proofstack_regression_fixture_events",
  "proofstack_regression_datasets",
  "proofstack_regression_dataset_versions",
  "proofstack_regression_dataset_members",
  "proofstack_outbox",
];
beforeAll(async () => {
  expect((await admin.query("SELECT current_database() AS name")).rows[0]?.name).toBe(
    "proofstack_test",
  );
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, credentials);
  for (const fixture of [fixtureRoot, fixtureNext]) await repository.publishFixtureVersion(fixture);
  for (const dataset of [datasetRoot, datasetNext]) await repository.publishDatasetVersion(dataset);
});
afterAll(async () => {
  await api.end();
  for (const role of Object.values(credentials)) {
    await admin.query(`DROP OWNED BY "${role.name}"`);
    await admin.query(`DROP ROLE "${role.name}"`);
  }
  await admin.end();
});
async function fingerprint() {
  const state = [];
  for (const table of tables)
    state.push(
      (
        await admin.query(
          `SELECT to_jsonb(item) AS record FROM public.${table} AS item WHERE tenant_id=$1 ORDER BY to_jsonb(item)::text`,
          [scope.tenantId],
        )
      ).rows,
    );
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
async function damaged(
  mutate: (client: PoolClient) => Promise<void>,
  inspect: (client: PoolClient) => Promise<void>,
) {
  const before = await fingerprint();
  try {
    await withExactScopeTransaction(admin, scope, async (client) => {
      await client.query("SAVEPOINT retained_original");
      try {
        // Privileged disposable damage only: CHECKs remain active; every change rolls back.
        await client.query("SET LOCAL session_replication_role='replica'");
        await mutate(client);
        await client.query(`SET LOCAL ROLE "${credentials.api.name}"`);
        await inspect(client);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT retained_original");
      }
    });
  } finally {
    expect(await fingerprint()).toBe(before);
    for (const fixture of [fixtureRoot, fixtureNext])
      await expect(repository.findFixtureVersion(scope, fixture.fixtureVersionId)).resolves.toEqual(
        fixture,
      );
    for (const dataset of [datasetRoot, datasetNext])
      await expect(repository.findDatasetVersion(scope, dataset.datasetVersionId)).resolves.toEqual(
        dataset,
      );
  }
}
const families = [
  {
    kind: "fixture",
    resource: "proofstack_regression_fixtures",
    body: "proofstack_regression_fixture_versions",
    children: "proofstack_regression_fixture_events",
    resourceColumn: "fixture_id",
    idColumn: "fixture_version_id",
    rootId: fixtureRoot.fixtureVersionId,
    nextId: fixtureNext.fixtureVersionId,
    resourceId: fixtureRoot.fixtureId,
    read: readPostgresFixtureVersionOnClient,
  },
  {
    kind: "dataset",
    resource: "proofstack_regression_datasets",
    body: "proofstack_regression_dataset_versions",
    children: "proofstack_regression_dataset_members",
    resourceColumn: "dataset_id",
    idColumn: "dataset_version_id",
    rootId: datasetRoot.datasetVersionId,
    nextId: datasetNext.datasetVersionId,
    resourceId: datasetRoot.datasetId,
    read: readPostgresDatasetVersionOnClient,
  },
] as const;
const scenarios = [
  "missing_resource",
  "missing_intent",
  "conflicting_intent",
  "mismatched_resource_digest",
  "orphan_children",
  "orphan_resource",
  "missing_root_body",
  "missing_root_intent",
  "missing_root_children",
] as const;
describe("owning regression storage integrity", () => {
  for (const f of families)
    for (const scenario of scenarios)
      it(`${f.kind}: rejects ${scenario} and preserves scope opacity`, async () => {
        const id = scenario.startsWith("missing_root_") ? f.nextId : f.rootId;
        await damaged(
          async (client) => {
            const values = [scope.tenantId, f.rootId];
            if (scenario === "missing_resource")
              await client.query(
                `DELETE FROM public.${f.resource} WHERE tenant_id=$1 AND ${f.resourceColumn}=$2`,
                [scope.tenantId, f.resourceId],
              );
            else if (scenario === "missing_intent" || scenario === "missing_root_intent")
              await client.query(
                "DELETE FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_id=$2",
                values,
              );
            else if (scenario === "conflicting_intent")
              await client.query(
                "UPDATE public.proofstack_outbox SET payload=payload || '{\"unexpected\":true}'::jsonb WHERE tenant_id=$1 AND aggregate_id=$2",
                values,
              );
            else if (scenario === "mismatched_resource_digest")
              await client.query(
                `UPDATE public.${f.resource} SET root_definition_sha256=$3 WHERE tenant_id=$1 AND ${f.resourceColumn}=$2`,
                [scope.tenantId, f.resourceId, "f".repeat(64)],
              );
            else if (scenario === "missing_root_children")
              await client.query(
                `DELETE FROM public.${f.children} WHERE tenant_id=$1 AND ${f.idColumn}=$2`,
                values,
              );
            else {
              await client.query(
                `DELETE FROM public.${f.body} WHERE tenant_id=$1 AND ${f.idColumn}=$2`,
                values,
              );
              if (scenario === "orphan_children")
                await client.query(
                  `DELETE FROM public.${f.resource} WHERE tenant_id=$1 AND ${f.resourceColumn}=$2`,
                  [scope.tenantId, f.resourceId],
                );
              if (scenario === "orphan_resource")
                await client.query(
                  `DELETE FROM public.${f.children} WHERE tenant_id=$1 AND ${f.idColumn}=$2`,
                  values,
                );
            }
          },
          async (client) => {
            await expect(
              f.read(client, { ...scope, projectId: "project_outside" }, id),
            ).resolves.toBeNull();
            await expect(
              f.read(client, { ...scope, environmentId: "environment_outside" }, id),
            ).resolves.toBeNull();
            await expect(f.read(client, scope, id)).rejects.toBeInstanceOf(
              RegressionRepositoryContractError,
            );
            if (
              f.kind === "fixture" &&
              (scenario === "orphan_children" || scenario === "orphan_resource")
            ) {
              for (const read of [
                readPostgresRecordedInteractionFixtureVersionOnClient,
                readPostgresRecordedInteractionFixtureContentOnClient,
              ]) {
                await expect(read(client, scope, id)).rejects.toBeInstanceOf(
                  RegressionRepositoryContractError,
                );
              }
            }
          },
        );
      });
  it("keeps healthy evidence-only fixtures absent from both recorded read surfaces", async () => {
    await withExactScopeTransaction(api, scope, async (client) => {
      for (const fixture of [fixtureRoot, fixtureNext]) {
        await expect(
          readPostgresRecordedInteractionFixtureVersionOnClient(
            client,
            scope,
            fixture.fixtureVersionId,
          ),
        ).resolves.toBeNull();
        await expect(
          readPostgresRecordedInteractionFixtureContentOnClient(
            client,
            scope,
            fixture.fixtureVersionId,
          ),
        ).resolves.toBeNull();
      }
      for (const f of families)
        await expect(f.read(client, scope, "version_never_published")).resolves.toBeNull();
    });
  });

  for (const kind of ["fixture", "dataset"] as const)
    it(`${kind}: preserves absence when a normal publisher commits after its presence cut`, async () => {
      const record =
        kind === "fixture"
          ? (() => {
              const definition = RegressionFixtureVersionDefinitionSchema.parse({
                schemaVersion: "0.1",
                scope,
                fixtureId: `fixture_race_${key}`,
                fixtureVersionId: `fixture_race_${key}_v1`,
                name: "Normal publication race",
                replayability: "evidence_only",
                source: {
                  kind: "trace_snapshot",
                  traceId: fixtureRoot.source.traceId,
                  eventIds: fixtureRoot.source.eventIds,
                  observedEventCount: fixtureRoot.source.observedEventCount,
                  sourceCompleteness: fixtureRoot.source.sourceCompleteness,
                },
              });
              return RegressionFixtureVersionSchema.parse({
                ...definition,
                source: { ...definition.source, capturedAt: fixtureRoot.source.capturedAt },
                createdAt: "2026-10-01T00:00:05.000Z",
                createdByPrincipalId: fixtureRoot.createdByPrincipalId,
                definitionSha256: digestRegressionFixtureVersionDefinition(definition),
              });
            })()
          : (() => {
              const definition = RegressionDatasetVersionDefinitionSchema.parse({
                schemaVersion: "0.1",
                scope,
                datasetId: `dataset_race_${key}`,
                datasetVersionId: `dataset_race_${key}_v1`,
                name: "Normal publication race",
                fixtureVersions: datasetRoot.fixtureVersions,
              });
              return RegressionDatasetVersionSchema.parse({
                ...definition,
                createdAt: "2026-10-01T00:00:05.000Z",
                createdByPrincipalId: datasetRoot.createdByPrincipalId,
                definitionSha256: digestRegressionDatasetVersionDefinition(definition),
              });
            })();
      const id = "fixtureVersionId" in record ? record.fixtureVersionId : record.datasetVersionId;
      const read =
        kind === "fixture"
          ? readPostgresFixtureVersionOnClient
          : readPostgresDatasetVersionOnClient;
      let published = false;
      await withExactScopeTransaction(api, scope, async (client) => {
        const port = new Proxy(client, {
          get(target, property) {
            if (property !== "query") return Reflect.get(target, property);
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(target.query, target, args);
              if (
                typeof args[0] === "string" &&
                args[0].includes("AS retained_regression_storage")
              ) {
                expect(published).toBe(false);
                expect(result.rows[0]).toMatchObject({
                  retained_regression_body: false,
                  retained_regression_storage: false,
                });
                if ("fixtureVersionId" in record) await repository.publishFixtureVersion(record);
                else await repository.publishDatasetVersion(record);
                published = true;
              }
              return result;
            };
          },
        });
        await expect(read(port, scope, id)).resolves.toBeNull();
      });
      expect(published).toBe(true);
      await expect(
        withExactScopeTransaction<RegressionFixtureVersion | RegressionDatasetVersion | null>(
          api,
          scope,
          (client) => read(client, scope, id),
        ),
      ).resolves.toEqual(record);
    });

  for (const value of [null, undefined, "true", 1] as const)
    it(`rejects non-native presence ${String(value)} before another read`, async () => {
      await withExactScopeTransaction(api, scope, async (client) => {
        let queries = 0;
        const port = new Proxy(client, {
          get(target, property) {
            if (property !== "query") return Reflect.get(target, property);
            return async (...args: unknown[]) => {
              queries += 1;
              const result = await Reflect.apply(target.query, target, args);
              return { ...result, rows: [{ ...result.rows[0], retained_regression_body: value }] };
            };
          },
        });
        await expect(
          readPostgresFixtureVersionOnClient(port, scope, fixtureRoot.fixtureVersionId),
        ).rejects.toBeInstanceOf(RegressionRepositoryContractError);
        expect(queries).toBe(1);
      });
    });
});
