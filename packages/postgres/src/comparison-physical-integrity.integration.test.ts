import { createHash, randomUUID } from "node:crypto";
import {
  comparisonRecordId,
  comparisonRecordReferences,
  ComparisonRepositoryContractError,
} from "@proofstack/core";
import {
  comparisonDefinitionFixture,
  createComparisonRepositoryTestHarness,
  publishComparisonFixture,
} from "@proofstack/core/testing";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import {
  PostgresComparisonRepository,
  readPostgresComparisonRecordOnClient,
} from "./postgres-comparison-repository.js";
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
      name: `ps_cphys_${kind.toLowerCase()}_${key}`,
      password: `proofstack-comparison-fixture-${key}`,
    },
  ]),
) as unknown as RuntimeRoleProvisioningOptions;
const admin = new Pool({ connectionString: databaseUrl, max: 2 });
const apiUrl = new URL(databaseUrl);
apiUrl.username = credentials.api.name;
apiUrl.password = credentials.api.password;
const api = new Pool({ connectionString: apiUrl.toString(), max: 2 });
const repository = new PostgresComparisonRepository(api);
const h = createComparisonRepositoryTestHarness(`cphys_${key}`);
const definition = h.records.find((f) => f.kind === "comparison_definition");
const result = h.records.find((f) => f.kind === "comparison_result");
if (!definition || !result) throw new Error("Missing comparison graph fixture");
const independent = comparisonDefinitionFixture(`cphys_${key}`, h.scope, {
  comparisonId: definition.record.comparisonId,
  version: "independent",
});
const successor = comparisonDefinitionFixture(`cphys_${key}`, h.scope, {
  comparisonId: definition.record.comparisonId,
  version: "successor",
  predecessor: {
    comparisonVersionId: definition.record.comparisonVersionId,
    definitionSha256: definition.record.definitionSha256,
  },
});
const tables = [
  "proofstack_comparison_records",
  "proofstack_comparison_record_registry",
  "proofstack_comparison_lineage",
  "proofstack_comparison_resource_bindings",
  "proofstack_outbox",
];
beforeAll(async () => {
  expect((await admin.query("SELECT current_database() AS name")).rows[0]?.name).toBe(
    "proofstack_test",
  );
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, credentials);
  for (const f of h.records) await publishComparisonFixture(repository, f);
  await repository.publishComparisonDefinition(independent);
  await repository.publishComparisonDefinition(successor);
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
          [h.scope.tenantId],
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
    await withExactScopeTransaction(admin, h.scope, async (client) => {
      await client.query("SAVEPOINT retained_original");
      try {
        // Administrator-only disposable damage; CHECKs remain enabled and every mutation rolls back.
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
    for (const f of h.records)
      await expect(
        withExactScopeTransaction(api, h.scope, (client) =>
          readPostgresComparisonRecordOnClient(
            client,
            h.scope,
            f.kind,
            comparisonRecordId(f.kind, f.record),
          ),
        ),
      ).resolves.toEqual(f.record);
    await expect(
      repository.findComparisonDefinition(h.scope, independent.comparisonVersionId),
    ).resolves.toEqual(independent);
    await expect(
      repository.findComparisonDefinition(h.scope, successor.comparisonVersionId),
    ).resolves.toEqual(successor);
  }
}
describe("owning comparison physical integrity", () => {
  it("keeps observed absence when a normal publication commits after its statement cut", async () => {
    const record = comparisonDefinitionFixture(`cphys_${key}`, h.scope, {
      comparisonId: definition.record.comparisonId,
      version: "concurrent",
    });
    await expect(
      repository.findComparisonDefinition(h.scope, record.comparisonVersionId),
    ).resolves.toBeNull();
    let published = false;
    await withExactScopeTransaction(api, h.scope, async (client) => {
      const view = {
        query: async (sql: string, values?: readonly unknown[]) => {
          const response = await client.query(sql, values ? [...values] : undefined);
          if (!published && sql.includes("AS retained_comparison_body")) {
            expect(response.rows[0]?.["retained_comparison_body"]).toBe(false);
            await expect(repository.publishComparisonDefinition(record)).resolves.toEqual({
              created: true,
              record,
            });
            published = true;
          }
          return response;
        },
      } as unknown as Pick<PoolClient, "query">;
      await expect(
        readPostgresComparisonRecordOnClient(
          view,
          h.scope,
          "comparison_definition",
          record.comparisonVersionId,
        ),
      ).resolves.toBeNull();
    });
    expect(published).toBe(true);
    await expect(
      repository.findComparisonDefinition(h.scope, record.comparisonVersionId),
    ).resolves.toEqual(record);
  });
  it.each([false, null, undefined, "true", 1])(
    "rejects a non-native successful timestamp witness %s",
    async (flag) => {
      // Adversarial supplied-client response, not a claim that PostgreSQL emitted a non-native boolean.
      await withExactScopeTransaction(api, h.scope, async (client) => {
        const view = {
          query: async (sql: string, values?: readonly unknown[]) => {
            const response = await client.query(sql, values ? [...values] : undefined);
            return sql.includes("AS created_at_matches")
              ? {
                  ...response,
                  rows: response.rows.map((row) => ({ ...row, created_at_matches: flag })),
                }
              : response;
          },
        } as unknown as Pick<PoolClient, "query">;
        await expect(
          readPostgresComparisonRecordOnClient(
            view,
            h.scope,
            "comparison_result",
            result.record.resultId,
          ),
        ).rejects.toBeInstanceOf(ComparisonRepositoryContractError);
      });
      await expect(
        repository.findComparisonResult(h.scope, result.record.resultId),
      ).resolves.toEqual(result.record);
    },
  );
  it("rejects an unexpected physical edge for a canonical definition with no parents", async () => {
    await damaged(
      async (client) => {
        await client.query(
          "INSERT INTO public.proofstack_comparison_lineage (tenant_id,project_id,environment_id,child_record_kind,child_record_id,child_definition_sha256,edge_position,parent_record_kind,parent_record_id,parent_definition_sha256) VALUES ($1,$2,$3,'comparison_definition',$4,$5,0,'comparison_definition',$6,$7)",
          [
            h.scope.tenantId,
            h.scope.projectId,
            h.scope.environmentId,
            definition.record.comparisonVersionId,
            definition.record.definitionSha256,
            independent.comparisonVersionId,
            independent.definitionSha256,
          ],
        );
      },
      async (client) => {
        await expect(
          readPostgresComparisonRecordOnClient(
            client,
            h.scope,
            "comparison_definition",
            definition.record.comparisonVersionId,
          ),
        ).rejects.toBeInstanceOf(ComparisonRepositoryContractError);
      },
    );
  });
  it("matches deployed fixed positional reference extraction for every retained kind", async () => {
    expect(new Set(h.records.map((f) => f.kind)).size).toBe(3);
    for (const f of [...h.records, { kind: "comparison_definition" as const, record: successor }]) {
      const stored = await admin.query(
        "SELECT * FROM public.proofstack_comparison_record_references($1,$2::jsonb)",
        [f.kind, JSON.stringify(f.record)],
      );
      expect(
        stored.rows.map((row) => [
          row.edge_position,
          row.parent_record_kind,
          row.parent_record_id,
          row.parent_definition_sha256,
        ]),
      ).toEqual(
        comparisonRecordReferences(f.kind, f.record).map((reference, position) => [
          position,
          reference.recordKind,
          reference.recordId,
          reference.definitionSha256,
        ]),
      );
    }
  });
  it.each(["registry", "lineage", "resource"] as const)(
    "rejects absent body with only its owned %s witness",
    async (witness) => {
      const f = witness === "resource" ? definition : result;
      const id = comparisonRecordId(f.kind, f.record);
      await damaged(
        async (client) => {
          const values = [h.scope.tenantId, f.kind, id];
          expect(
            (
              await client.query(
                "DELETE FROM public.proofstack_comparison_records WHERE tenant_id=$1 AND record_kind=$2 AND record_id=$3",
                values,
              )
            ).rowCount,
          ).toBe(1);
          if (witness !== "registry")
            expect(
              (
                await client.query(
                  "DELETE FROM public.proofstack_comparison_record_registry WHERE tenant_id=$1 AND record_kind=$2 AND record_id=$3",
                  values,
                )
              ).rowCount,
            ).toBe(1);
          if (witness !== "lineage")
            await client.query(
              "DELETE FROM public.proofstack_comparison_lineage WHERE tenant_id=$1 AND child_record_kind=$2 AND child_record_id=$3",
              values,
            );
        },
        async (client) => {
          await expect(
            readPostgresComparisonRecordOnClient(client, h.scope, f.kind, id),
          ).rejects.toBeInstanceOf(ComparisonRepositoryContractError);
        },
      );
    },
  );
  it.each([
    "child_registry",
    "physical_lineage",
    "parent_registry",
    "original_intent",
    "resource_binding",
  ] as const)("rejects missing %s", async (target) => {
    const f = target === "resource_binding" ? definition : result;
    const id = comparisonRecordId(f.kind, f.record);
    await damaged(
      async (client) => {
        const sql =
          target === "physical_lineage"
            ? "DELETE FROM public.proofstack_comparison_lineage WHERE tenant_id=$1 AND child_record_kind=$2 AND child_record_id=$3"
            : target === "parent_registry"
              ? "DELETE FROM public.proofstack_comparison_record_registry WHERE tenant_id=$1 AND (record_kind,record_id) IN (SELECT parent_record_kind,parent_record_id FROM public.proofstack_comparison_lineage WHERE tenant_id=$1 AND child_record_kind=$2 AND child_record_id=$3)"
              : target === "original_intent"
                ? "DELETE FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_type=$2 AND aggregate_id=$3"
                : target === "resource_binding"
                  ? "DELETE FROM public.proofstack_comparison_resource_bindings WHERE tenant_id=$1 AND root_record_kind=$2 AND root_record_id=$3"
                  : "DELETE FROM public.proofstack_comparison_record_registry WHERE tenant_id=$1 AND record_kind=$2 AND record_id=$3";
        expect((await client.query(sql, [h.scope.tenantId, f.kind, id])).rowCount).toBeGreaterThan(
          0,
        );
      },
      async (client) => {
        await expect(
          readPostgresComparisonRecordOnClient(client, h.scope, f.kind, id),
        ).rejects.toBeInstanceOf(ComparisonRepositoryContractError);
      },
    );
  });
  it.each(["body", "intent"] as const)(
    "validates a distinct logical root's original %s",
    async (target) => {
      await damaged(
        async (client) => {
          const sql =
            target === "body"
              ? "DELETE FROM public.proofstack_comparison_records WHERE tenant_id=$1 AND record_kind='comparison_definition' AND record_id=$2"
              : "DELETE FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_type='comparison_definition' AND aggregate_id=$2";
          expect(
            (await client.query(sql, [h.scope.tenantId, definition.record.comparisonVersionId]))
              .rowCount,
          ).toBe(1);
        },
        async (client) => {
          await expect(
            readPostgresComparisonRecordOnClient(
              client,
              h.scope,
              "comparison_definition",
              independent.comparisonVersionId,
            ),
          ).rejects.toBeInstanceOf(ComparisonRepositoryContractError);
        },
      );
    },
  );
  it.each([
    "child_scope",
    "child_digest",
    "edge_scope",
    "edge_child",
    "edge_parent",
    "edge_position",
    "parent_scope",
    "resource_scope",
    "root_digest",
  ] as const)("rejects mismatched %s", async (target) => {
    const id = result.record.resultId;
    await damaged(
      async (client) => {
        if (target === "edge_position") {
          const edge = (
            await client.query(
              "SELECT * FROM public.proofstack_comparison_lineage WHERE tenant_id=$1 AND child_record_kind='comparison_result' AND child_record_id=$2 AND edge_position=0",
              [h.scope.tenantId, id],
            )
          ).rows[0];
          expect(edge).toBeDefined();
          expect(
            (
              await client.query(
                "DELETE FROM public.proofstack_comparison_lineage WHERE tenant_id=$1 AND child_record_kind='comparison_result' AND child_record_id=$2 AND edge_position=0",
                [h.scope.tenantId, id],
              )
            ).rowCount,
          ).toBe(1);
          expect(
            (
              await client.query(
                "UPDATE public.proofstack_comparison_lineage SET edge_position=0 WHERE tenant_id=$1 AND child_record_kind='comparison_result' AND child_record_id=$2 AND edge_position=1",
                [h.scope.tenantId, id],
              )
            ).rowCount,
          ).toBe(1);
          await client.query(
            "INSERT INTO public.proofstack_comparison_lineage (tenant_id,project_id,environment_id,child_record_kind,child_record_id,child_definition_sha256,edge_position,parent_record_kind,parent_record_id,parent_definition_sha256) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9)",
            [
              edge.tenant_id,
              edge.project_id,
              edge.environment_id,
              edge.child_record_kind,
              edge.child_record_id,
              edge.child_definition_sha256,
              edge.parent_record_kind,
              edge.parent_record_id,
              edge.parent_definition_sha256,
            ],
          );
          return;
        }
        const sql = target.startsWith("child_")
          ? `UPDATE public.proofstack_comparison_record_registry SET ${target === "child_scope" ? "project_id='project_other'" : "definition_sha256='" + "0".repeat(64) + "'"} WHERE tenant_id=$1 AND record_kind='comparison_result' AND record_id=$2`
          : target === "parent_scope"
            ? "UPDATE public.proofstack_comparison_record_registry SET project_id='project_other' WHERE tenant_id=$1 AND record_kind='comparison_definition' AND record_id=$2"
            : target.startsWith("resource_") || target === "root_digest"
              ? `UPDATE public.proofstack_comparison_resource_bindings SET ${target === "resource_scope" ? "environment_id='environment_other'" : "root_definition_sha256='" + "0".repeat(64) + "'"} WHERE tenant_id=$1 AND root_record_id=$2`
              : `UPDATE public.proofstack_comparison_lineage SET ${target === "edge_scope" ? "environment_id='environment_other'" : (target === "edge_child" ? "child_definition_sha256" : "parent_definition_sha256") + "='" + "0".repeat(64) + "'"} WHERE tenant_id=$1 AND child_record_kind='comparison_result' AND child_record_id=$2`;
        const selected =
          target === "parent_scope" || target === "resource_scope" || target === "root_digest"
            ? definition.record.comparisonVersionId
            : id;
        expect((await client.query(sql, [h.scope.tenantId, selected])).rowCount).toBeGreaterThan(0);
      },
      async (client) => {
        await expect(
          readPostgresComparisonRecordOnClient(client, h.scope, "comparison_result", id),
        ).rejects.toBeInstanceOf(ComparisonRepositoryContractError);
      },
    );
  });
});
