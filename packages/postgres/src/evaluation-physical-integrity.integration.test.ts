import { createHash, randomUUID } from "node:crypto";
import {
  digestEvaluationRecordDefinition,
  evaluationRecordId,
  evaluationRecordReferences,
  evaluationResource,
  EvaluationRepositoryContractError,
  validateEvaluationRecord,
} from "@proofstack/core";
import {
  createEvaluationRepositoryTestHarness,
  publishEvaluationFixture,
} from "@proofstack/core/testing";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import {
  listPostgresCriterionSetStatusesOnClient,
  PostgresEvaluationRepository,
  readPostgresEvaluationRecordOnClient,
} from "./postgres-evaluation-repository.js";
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
      name: `ps_ephys_${kind.toLowerCase()}_${key}`,
      password: `proofstack-evaluation-fixture-${key}`,
    },
  ]),
) as unknown as RuntimeRoleProvisioningOptions;
const admin = new Pool({ connectionString: databaseUrl, max: 2 });
function runtime(kind: "api" | "evaluationWorker") {
  const url = new URL(databaseUrl as string);
  url.username = credentials[kind].name;
  url.password = credentials[kind].password;
  return new Pool({ connectionString: url.toString(), max: 2 });
}
const api = runtime("api");
const worker = runtime("evaluationWorker");
const executionKinds = new Set([
  "evaluation_aggregate",
  "evaluation_run_result",
  "qualification_report",
  "raw_observation",
]);
const h = createEvaluationRepositoryTestHarness(`ephys_${key}`);
const rootFixture = h.records.find((f) => f.kind === "criterion_set");
if (!rootFixture) throw new Error("Missing criterion resource root");
const independentDefinition = structuredClone(rootFixture.record) as unknown as Record<
  string,
  unknown
>;
independentDefinition["criterionSetVersionId"] = "crv_independent";
for (const field of [
  "definitionSha256",
  "schemaVersion",
  "scope",
  "publishedAt",
  "publishedByPrincipalId",
])
  delete independentDefinition[field];
const independent = {
  ...rootFixture.record,
  criterionSetVersionId: "crv_independent",
  definitionSha256: digestEvaluationRecordDefinition(
    "criterion_set",
    h.scope,
    independentDefinition,
  ),
};
const tables = [
  "proofstack_evaluation_records",
  "proofstack_evaluation_record_registry",
  "proofstack_evaluation_lineage",
  "proofstack_evaluation_resource_bindings",
  "proofstack_evaluation_unique_bindings",
  "proofstack_outbox",
];
function repository(kind: string) {
  return new PostgresEvaluationRepository(executionKinds.has(kind) ? worker : api);
}
beforeAll(async () => {
  expect((await admin.query("SELECT current_database() AS name")).rows[0]?.name).toBe(
    "proofstack_test",
  );
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, credentials);
  for (const f of h.records) await publishEvaluationFixture(repository(f.kind), f);
  await repository("criterion_set").publishCriterionSet(independent);
});
afterAll(async () => {
  await Promise.all([api.end(), worker.end()]);
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
        // Disposable administrator-only damage; CHECKs remain enabled and every mutation rolls back.
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
          readPostgresEvaluationRecordOnClient(
            client,
            h.scope,
            f.kind,
            evaluationRecordId(f.kind, f.record),
          ),
        ),
      ).resolves.toEqual(f.record);
  }
}

describe("owning evaluation physical storage and original receipts", () => {
  it("keeps observed absence when normal publication commits after the same-statement cut", async () => {
    const original = h.records.find((f) => f.kind === "discovery_record");
    if (!original) throw new Error("Missing discovery fixture");
    const definition = structuredClone(original.record) as unknown as Record<string, unknown>;
    definition["discoveryId"] = "dsc_concurrent";
    for (const field of [
      "definitionSha256",
      "schemaVersion",
      "scope",
      "recordedAt",
      "recordedByPrincipalId",
    ])
      delete definition[field];
    const record = {
      ...original.record,
      discoveryId: "dsc_concurrent",
      definitionSha256: digestEvaluationRecordDefinition("discovery_record", h.scope, definition),
    };
    const control = repository("discovery_record");
    await expect(control.findDiscoveryRecord(h.scope, record.discoveryId)).resolves.toBeNull();
    let published = false;
    await withExactScopeTransaction(api, h.scope, async (client) => {
      const view = {
        query: async (sql: string, values?: readonly unknown[]) => {
          const result = await client.query(sql, values ? [...values] : undefined);
          if (!published && sql.includes("AS retained_evaluation_body")) {
            expect(result.rows[0]?.["retained_evaluation_body"]).toBe(false);
            await expect(control.publishDiscoveryRecord(record)).resolves.toEqual({
              created: true,
              record,
            });
            published = true;
          }
          return result;
        },
      } as unknown as Pick<PoolClient, "query">;
      await expect(
        readPostgresEvaluationRecordOnClient(view, h.scope, "discovery_record", record.discoveryId),
      ).resolves.toBeNull();
    });
    expect(published).toBe(true);
    await expect(control.findDiscoveryRecord(h.scope, record.discoveryId)).resolves.toEqual(record);
  });
  it.each(["registry", "lineage", "resource", "unique"] as const)(
    "rejects an absent body with only its owned %s witness",
    async (witness) => {
      const kind =
        witness === "resource"
          ? "criterion_set"
          : witness === "unique"
            ? "raw_observation"
            : "source_snapshot";
      const f = h.records.find((f) => f.kind === kind);
      if (!f) throw new Error("Missing presence fixture");
      const id = evaluationRecordId(f.kind, f.record);
      await damaged(
        async (client) => {
          const values = [h.scope.tenantId, f.kind, id];
          expect(
            (
              await client.query(
                "DELETE FROM public.proofstack_evaluation_records WHERE tenant_id=$1 AND record_kind=$2 AND record_id=$3",
                values,
              )
            ).rowCount,
          ).toBe(1);
          if (witness !== "registry")
            expect(
              (
                await client.query(
                  "DELETE FROM public.proofstack_evaluation_record_registry WHERE tenant_id=$1 AND record_kind=$2 AND record_id=$3",
                  values,
                )
              ).rowCount,
            ).toBe(1);
          if (witness !== "lineage")
            await client.query(
              "DELETE FROM public.proofstack_evaluation_lineage WHERE tenant_id=$1 AND child_record_kind=$2 AND child_record_id=$3",
              values,
            );
        },
        async (client) => {
          await expect(
            readPostgresEvaluationRecordOnClient(client, h.scope, f.kind, id),
          ).rejects.toBeInstanceOf(EvaluationRepositoryContractError);
        },
      );
    },
  );
  it.each(["body", "intent"] as const)(
    "verifies the distinct logical root's original %s",
    async (target) => {
      await expect(
        repository("criterion_set").findCriterionSet(h.scope, independent.criterionSetVersionId),
      ).resolves.toEqual(independent);
      await damaged(
        async (client) => {
          const id = rootFixture.record.criterionSetVersionId;
          const sql =
            target === "body"
              ? "DELETE FROM public.proofstack_evaluation_records WHERE tenant_id=$1 AND record_kind='criterion_set' AND record_id=$2"
              : "DELETE FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_type='evaluation_criterion_set' AND aggregate_id=$2";
          expect((await client.query(sql, [h.scope.tenantId, id])).rowCount).toBe(1);
        },
        async (client) => {
          await expect(
            readPostgresEvaluationRecordOnClient(
              client,
              h.scope,
              "criterion_set",
              independent.criterionSetVersionId,
            ),
          ).rejects.toBeInstanceOf(EvaluationRepositoryContractError);
        },
      );
      await expect(
        repository("criterion_set").findCriterionSet(h.scope, independent.criterionSetVersionId),
      ).resolves.toEqual(independent);
    },
  );
  it.each([
    [
      "resource scope",
      "criterion_set",
      "proofstack_evaluation_resource_bindings",
      "project_id='prj_damaged'",
      "root_record_kind=$2 AND root_record_id=$3",
    ],
    [
      "resource root digest",
      "criterion_set",
      "proofstack_evaluation_resource_bindings",
      "root_definition_sha256=repeat('f',64)",
      "root_record_kind=$2 AND root_record_id=$3",
    ],
    [
      "unique scope",
      "raw_observation",
      "proofstack_evaluation_unique_bindings",
      "environment_id='env_damaged'",
      "record_kind=$2 AND record_id=$3",
    ],
    [
      "unique key",
      "raw_observation",
      "proofstack_evaluation_unique_bindings",
      "binding_key='raw_observation:attempt:other_run:other_attempt'",
      "record_kind=$2 AND record_id=$3",
    ],
  ] as const)("rejects mismatched %s", async (_name, kind, table, change, where) => {
    const f = h.records.find((f) => f.kind === kind);
    if (!f) throw new Error("Missing binding fixture");
    const id = evaluationRecordId(f.kind, f.record);
    await damaged(
      async (client) => {
        expect(
          (
            await client.query(
              `UPDATE public.${table} SET ${change} WHERE tenant_id=$1 AND ${where}`,
              [h.scope.tenantId, f.kind, id],
            )
          ).rowCount,
        ).toBe(1);
      },
      async (client) => {
        await expect(
          readPostgresEvaluationRecordOnClient(client, h.scope, f.kind, id),
        ).rejects.toBeInstanceOf(EvaluationRepositoryContractError);
      },
    );
  });
  it.each([
    [
      "child registry scope",
      "proofstack_evaluation_record_registry",
      "project_id='prj_damaged'",
      "record_kind=$2 AND record_id=$3",
    ],
    [
      "child registry digest",
      "proofstack_evaluation_record_registry",
      "definition_sha256=repeat('f',64)",
      "record_kind=$2 AND record_id=$3",
    ],
    [
      "edge scope",
      "proofstack_evaluation_lineage",
      "environment_id='env_damaged'",
      "child_record_kind=$2 AND child_record_id=$3",
    ],
    [
      "edge child digest",
      "proofstack_evaluation_lineage",
      "child_definition_sha256=repeat('f',64)",
      "child_record_kind=$2 AND child_record_id=$3",
    ],
    [
      "edge parent digest",
      "proofstack_evaluation_lineage",
      "parent_definition_sha256=repeat('f',64)",
      "child_record_kind=$2 AND child_record_id=$3",
    ],
    [
      "edge position",
      "proofstack_evaluation_lineage",
      "edge_position=1",
      "child_record_kind=$2 AND child_record_id=$3",
    ],
    [
      "parent registry scope",
      "proofstack_evaluation_record_registry",
      "project_id='prj_damaged'",
      "(record_kind,record_id) IN (SELECT parent_record_kind,parent_record_id FROM public.proofstack_evaluation_lineage WHERE tenant_id=$1 AND child_record_kind=$2 AND child_record_id=$3)",
    ],
  ])(
    "rejects mismatched %s on a retained canonical source body",
    async (_name, table, change, where) => {
      const f = h.records.find((f) => f.kind === "source_snapshot");
      if (!f) throw new Error("Missing source fixture");
      const id = evaluationRecordId(f.kind, f.record);
      await damaged(
        async (client) => {
          expect(
            (
              await client.query(
                `UPDATE public.${table} SET ${change} WHERE tenant_id=$1 AND ${where}`,
                [h.scope.tenantId, f.kind, id],
              )
            ).rowCount,
          ).toBe(1);
        },
        async (client) => {
          await expect(
            readPostgresEvaluationRecordOnClient(client, h.scope, f.kind, id),
          ).rejects.toBeInstanceOf(EvaluationRepositoryContractError);
        },
      );
    },
  );
  it("validates physical storage for every retained complete criterion status history row", async () => {
    const f = h.records.find((f) => f.kind === "criterion_set_status");
    if (!f) throw new Error("Missing criterion status fixture");
    const id = evaluationRecordId(f.kind, f.record);
    await damaged(
      async (client) => {
        expect(
          (
            await client.query(
              "DELETE FROM public.proofstack_evaluation_record_registry WHERE tenant_id=$1 AND record_kind=$2 AND record_id=$3",
              [h.scope.tenantId, f.kind, id],
            )
          ).rowCount,
        ).toBe(1);
      },
      async (client) => {
        await expect(
          listPostgresCriterionSetStatusesOnClient(client, h.scope, {
            maxRecords: 100,
            maxRecordBytes: 10_000,
          }),
        ).rejects.toBeInstanceOf(EvaluationRepositoryContractError);
      },
    );
  });
  it("matches the independent deployed SQL reference extraction for all seventeen kinds", async () => {
    expect(new Set(h.records.map((f) => f.kind)).size).toBe(17);
    for (const f of h.records) {
      const id = evaluationRecordId(f.kind, f.record);
      const sql = await admin.query(
        "SELECT * FROM public.proofstack_evaluation_record_references($1,$2,$3::jsonb)",
        [f.kind, id, JSON.stringify(f.record)],
      );
      const expected = [
        ...new Set(
          evaluationRecordReferences(f.kind, f.record).map((r) =>
            JSON.stringify([r.recordKind, r.recordId, r.definitionSha256 ?? null]),
          ),
        ),
      ].sort();
      expect(
        sql.rows
          .map((r) =>
            JSON.stringify([r.parent_record_kind, r.parent_record_id, r.parent_definition_sha256]),
          )
          .sort(),
      ).toEqual(expected);
      const resource = evaluationResource(f.kind, f.record);
      if (resource)
        expect(
          (
            await admin.query(
              "SELECT resource_id FROM public.proofstack_evaluation_resource_bindings WHERE tenant_id=$1 AND resource_kind=$2 AND resource_id=$3",
              [h.scope.tenantId, resource.kind, resource.resourceId],
            )
          ).rows,
        ).toHaveLength(1);
    }
  });
  it.each([
    "child_registry",
    "physical_lineage",
    "parent_registry",
    "original_intent",
    "resource_binding",
    "unique_binding",
    "orphan_registry",
  ] as const)("rejects a missing %s through the actual API role", async (target) => {
    const kind =
      target === "resource_binding"
        ? "criterion_set"
        : target === "unique_binding"
          ? "raw_observation"
          : "source_snapshot";
    const f = h.records.find((f) => f.kind === kind);
    if (!f) throw new Error("Missing damaged evaluation fixture");
    const id = evaluationRecordId(f.kind, f.record);
    await damaged(
      async (client) => {
        const values = [h.scope.tenantId, f.kind, id];
        const sql =
          target === "physical_lineage"
            ? "DELETE FROM public.proofstack_evaluation_lineage WHERE tenant_id=$1 AND child_record_kind=$2 AND child_record_id=$3"
            : target === "parent_registry"
              ? "DELETE FROM public.proofstack_evaluation_record_registry WHERE tenant_id=$1 AND (record_kind,record_id) IN (SELECT parent_record_kind,parent_record_id FROM public.proofstack_evaluation_lineage WHERE tenant_id=$1 AND child_record_kind=$2 AND child_record_id=$3)"
              : target === "original_intent"
                ? "DELETE FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_type='evaluation_' || $2::text AND aggregate_id=$3"
                : target === "resource_binding"
                  ? "DELETE FROM public.proofstack_evaluation_resource_bindings WHERE tenant_id=$1 AND root_record_kind=$2 AND root_record_id=$3"
                  : `DELETE FROM public.${target === "orphan_registry" ? "proofstack_evaluation_records" : target === "unique_binding" ? "proofstack_evaluation_unique_bindings" : "proofstack_evaluation_record_registry"} WHERE tenant_id=$1 AND record_kind=$2 AND record_id=$3`;
        expect((await client.query(sql, values)).rowCount).toBe(1);
      },
      async (client) => {
        await expect(
          readPostgresEvaluationRecordOnClient(client, h.scope, f.kind, id),
        ).rejects.toBeInstanceOf(EvaluationRepositoryContractError);
      },
    );
  });
  const kinds = [...new Set(h.records.map((f) => f.kind))];
  it.each(kinds)("returns the original valid receipt on %s semantic retries", async (kind) => {
    const f = h.records.find((f) => f.kind === kind);
    if (!f) throw new Error("Missing evaluation fixture");
    const time = [
      "aggregation_policy",
      "criterion_set",
      "evaluator_spec",
      "oracle_spec",
      "qualification_fixture_set",
    ].includes(kind)
      ? "publishedAt"
      : ["assessment", "evaluation_aggregate", "evaluation_run"].includes(kind)
        ? "createdAt"
        : kind === "source_review"
          ? "reviewedAt"
          : "recordedAt";
    const record = f.record as unknown as Readonly<Record<string, unknown>>;
    const proposed = {
      ...record,
      [time]: new Date(Date.parse(String(record[time])) + 1000).toISOString(),
    };
    validateEvaluationRecord(kind, proposed);
    await expect(
      publishEvaluationFixture(repository(kind), { ...f, record: proposed } as typeof f),
    ).resolves.toEqual({ created: false, record: f.record });
  });
});
