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
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { modelAssuranceStorageReferences } from "./model-assurance-storage-references.js";
import { PostgresEvaluationRepository } from "./postgres-evaluation-repository.js";
import {
  PostgresModelAssuranceRepository,
  readPostgresModelAssuranceRecordOnClient,
} from "./postgres-model-assurance-repository.js";
import { provisionRuntimeRoles, type RuntimeRoleProvisioningOptions } from "./runtime-roles.js";
import { withExactScopeTransaction } from "./tenant-transaction.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
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
      name: `ps_phys_${kind.toLowerCase()}_${key}`,
      password: `proofstack-physical-fixture-${key}`,
    },
  ]),
) as unknown as RuntimeRoleProvisioningOptions;
const admin = new Pool({ connectionString: databaseUrl, max: 2 });
const pools = new Map<keyof RuntimeRoleProvisioningOptions, Pool>();
function pool(kind: keyof RuntimeRoleProvisioningOptions) {
  let result = pools.get(kind);
  if (!result) {
    const url = new URL(databaseUrl as string);
    const role = credentials[kind];
    if (!role) throw new Error("Missing fixture role");
    url.username = role.name;
    url.password = role.password;
    result = new Pool({ connectionString: url.toString(), max: 2 });
    pools.set(kind, result);
  }
  return result;
}
let records: readonly ModelAssuranceRepositoryFixtureRecord[];
function fixture(kind: ModelAssuranceRecordKind) {
  const result = records.find((f) => f.kind === kind);
  if (!result) throw new Error("Missing physical integrity fixture");
  return result;
}

beforeAll(async () => {
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, credentials);
  const h = await createModelAssuranceRepositoryTestHarness(`ph_${key}`);
  const execution = new Set([
    "evaluation_aggregate",
    "evaluation_run_result",
    "qualification_report",
    "raw_observation",
  ]);
  for (const f of h.evaluation.records)
    await publishEvaluationFixture(
      new PostgresEvaluationRepository(pool(execution.has(f.kind) ? "evaluationWorker" : "api")),
      f,
    );
  for (const f of h.records) {
    const role =
      f.kind === "human_review_record"
        ? "humanReviewer"
        : [
              "blinded_evaluation_result",
              "independent_critique",
              "model_qualification_report",
            ].includes(f.kind)
          ? "modelEvaluationWorker"
          : "api";
    await new PostgresModelAssuranceRepository(pool(role)).publish(f.kind, f.record);
  }
  const assessment = await new CreateModelAssuranceAssessment({
    clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
    evaluationRepository: new PostgresEvaluationRepository(pool("api")),
    modelAssuranceRepository: new PostgresModelAssuranceRepository(pool("api")),
  }).execute(h.command);
  records = [...h.records, { kind: "model_assurance_assessment", record: assessment.record }];
});
afterAll(async () => {
  await Promise.all([...pools.values()].map((p) => p.end()));
  for (const role of Object.values(credentials)) {
    await admin.query(`DROP OWNED BY "${role.name}"`);
    await admin.query(`DROP ROLE "${role.name}"`);
  }
  await admin.end();
});

interface ReadCall {
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly rows: number;
}
async function damaged(
  f: ModelAssuranceRepositoryFixtureRecord,
  mutate: (client: PoolClient, values: readonly unknown[]) => Promise<void>,
  inspect?: (view: Pick<PoolClient, "query">, calls: ReadCall[]) => Promise<void>,
) {
  await withExactScopeTransaction(admin, f.record.scope, async (client) => {
    await client.query("SAVEPOINT retained_original");
    try {
      // Administrator-only disposable damage; CHECKs stay active. All changes roll back.
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await mutate(client, [
        f.record.scope.tenantId,
        f.kind,
        modelAssuranceRecordId(f.kind, f.record),
      ]);
      await client.query(`SET LOCAL ROLE "${credentials.api.name}"`);
      const calls: ReadCall[] = [];
      const view = {
        query: async (sql: string, values: unknown[]) => {
          expect(sql.trim()).toMatch(/^SELECT\b/);
          const result = await client.query(sql, values);
          calls.push({ sql, values, rows: result.rows.length });
          return result;
        },
      } as Pick<PoolClient, "query">;
      if (inspect) await inspect(view, calls);
      else
        await expect(
          readPostgresModelAssuranceRecordOnClient(
            view,
            f.record.scope,
            f.kind,
            modelAssuranceRecordId(f.kind, f.record),
          ),
        ).rejects.toBeInstanceOf(ModelAssuranceRepositoryContractError);
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT retained_original");
    }
  });
  await expect(
    new PostgresModelAssuranceRepository(pool("api")).find(
      f.record.scope,
      f.kind,
      modelAssuranceRecordId(f.kind, f.record),
    ),
  ).resolves.toEqual(f.record);
}

describe("model-assurance physical integrity on actual PostgreSQL", () => {
  it.each(["absent", "project", "environment", "digest"] as const)(
    "rejects %s child registry damage without changing the original",
    async (mode) => {
      await damaged(fixture("model_evaluator_profile"), async (client, values) => {
        const table = "public.proofstack_evaluation_record_registry";
        if (mode === "absent")
          expect(
            (
              await client.query(
                `DELETE FROM ${table} WHERE tenant_id=$1 AND record_kind=$2 AND record_id=$3`,
                [...values],
              )
            ).rowCount,
          ).toBe(1);
        else {
          const column = {
            project: "project_id",
            environment: "environment_id",
            digest: "definition_sha256",
          }[mode];
          const replacement =
            mode === "digest" ? "f".repeat(64) : mode === "project" ? "prj_other" : "env_other";
          expect(
            (
              await client.query(
                `UPDATE ${table} SET ${column}=$4 WHERE tenant_id=$1 AND record_kind=$2 AND record_id=$3`,
                [...values, replacement],
              )
            ).rowCount,
          ).toBe(1);
        }
      });
    },
  );

  it.each(["absent", "project", "environment", "digest"] as const)(
    "rejects %s parent registry damage",
    async (mode) => {
      const f = fixture("model_assisted_evaluator");
      const ref = modelAssuranceStorageReferences(
        f.kind,
        modelAssuranceRecordId(f.kind, f.record),
        f.record,
      )[0];
      if (!ref) throw new Error("Missing exact parent");
      await damaged(f, async (client, values) => {
        const params = [values[0], ref.recordKind, ref.recordId];
        const table = "public.proofstack_evaluation_record_registry";
        if (mode === "absent")
          expect(
            (
              await client.query(
                `DELETE FROM ${table} WHERE tenant_id=$1 AND record_kind=$2 AND record_id=$3`,
                params,
              )
            ).rowCount,
          ).toBe(1);
        else {
          const column = {
            project: "project_id",
            environment: "environment_id",
            digest: "definition_sha256",
          }[mode];
          const replacement =
            mode === "digest" ? "f".repeat(64) : mode === "project" ? "prj_other" : "env_other";
          expect(
            (
              await client.query(
                `UPDATE ${table} SET ${column}=$4 WHERE tenant_id=$1 AND record_kind=$2 AND record_id=$3`,
                [...params, replacement],
              )
            ).rowCount,
          ).toBe(1);
        }
      });
    },
  );

  it.each([
    "missing",
    "gap",
    "scope",
    "child_digest",
    "parent_digest",
    "duplicate",
    "reordered",
  ] as const)("rejects %s physical edges", async (mode) => {
    const f = fixture(
      mode === "duplicate" || mode === "reordered"
        ? "blinded_evaluation_plan"
        : "model_assisted_evaluator",
    );
    await damaged(f, async (client, values) => {
      const table = "public.proofstack_evaluation_lineage";
      const where = "tenant_id=$1 AND child_record_kind=$2 AND child_record_id=$3";
      if (mode === "missing")
        expect(
          (
            await client.query(`DELETE FROM ${table} WHERE ${where} AND edge_position=0`, [
              ...values,
            ])
          ).rowCount,
        ).toBe(1);
      else if (mode === "reordered") {
        for (const [from, to] of [
          [0, 4095],
          [1, 0],
          [4095, 1],
        ])
          expect(
            (
              await client.query(
                `UPDATE ${table} SET edge_position=$5 WHERE ${where} AND edge_position=$4`,
                [...values, from, to],
              )
            ).rowCount,
          ).toBe(1);
      } else if (mode === "duplicate") {
        expect(
          (
            await client.query(
              `UPDATE ${table} SET (parent_record_kind,parent_record_id,parent_definition_sha256)=(SELECT parent_record_kind,parent_record_id,parent_definition_sha256 FROM ${table} WHERE ${where} AND edge_position=0) WHERE ${where} AND edge_position=1`,
              [...values],
            )
          ).rowCount,
        ).toBe(1);
      } else {
        const column = {
          gap: "edge_position",
          scope: "project_id",
          child_digest: "child_definition_sha256",
          parent_digest: "parent_definition_sha256",
        }[mode];
        const replacement = mode === "gap" ? 9 : mode === "scope" ? "prj_other" : "f".repeat(64);
        expect(
          (
            await client.query(
              `UPDATE ${table} SET ${column}=$4 WHERE ${where} AND edge_position=0`,
              [...values, replacement],
            )
          ).rowCount,
        ).toBe(1);
      }
    });
  });

  it.each([0, 2])(
    "rejects stored count %s before any physical registry/edge query",
    async (count) => {
      const f = fixture("model_assisted_evaluator");
      await damaged(
        f,
        async (client, values) => {
          expect(
            (
              await client.query(
                "UPDATE public.proofstack_model_assurance_records SET lineage_count=$4 WHERE tenant_id=$1 AND record_kind=$2 AND record_id=$3",
                [...values, count],
              )
            ).rowCount,
          ).toBe(1);
        },
        async (view, calls) => {
          await expect(
            readPostgresModelAssuranceRecordOnClient(
              view,
              f.record.scope,
              f.kind,
              modelAssuranceRecordId(f.kind, f.record),
            ),
          ).rejects.toBeInstanceOf(ModelAssuranceRepositoryContractError);
          expect(calls).toHaveLength(1);
          expect(calls[0]?.sql).toContain("FROM public.proofstack_model_assurance_records");
        },
      );
    },
  );
  it("uses one overflow sentinel for a zero-reference body with forty unexpected edges", async () => {
    const f = fixture("model_evaluator_profile");
    const parent = fixture("model_assisted_evaluator");
    await damaged(
      f,
      async (client, values) => {
        const result = await client.query(
          `INSERT INTO public.proofstack_evaluation_lineage
         (tenant_id,project_id,environment_id,child_record_kind,child_record_id,
          child_definition_sha256,edge_position,parent_record_kind,parent_record_id,parent_definition_sha256)
         SELECT $1,$4,$5,$2,$3,$6,positions.edge_position,$7,$8,$9
         FROM generate_series(0,39) AS positions(edge_position)`,
          [
            ...values,
            f.record.scope.projectId,
            f.record.scope.environmentId,
            f.record.definitionSha256,
            parent.kind,
            modelAssuranceRecordId(parent.kind, parent.record),
            parent.record.definitionSha256,
          ],
        );
        expect(result.rowCount).toBe(40);
      },
      async (view, calls) => {
        await expect(
          readPostgresModelAssuranceRecordOnClient(
            view,
            f.record.scope,
            f.kind,
            modelAssuranceRecordId(f.kind, f.record),
          ),
        ).rejects.toBeInstanceOf(ModelAssuranceRepositoryContractError);
        const edges = calls.find((call) =>
          call.sql.includes("FROM public.proofstack_evaluation_lineage"),
        );
        expect(edges?.values.at(-1)).toBe(1);
        expect(edges?.rows).toBe(1);
      },
    );
  });

  it("keeps damaged physical state opaque outside all three exact scope dimensions", async () => {
    const f = fixture("model_evaluator_profile");
    const id = modelAssuranceRecordId(f.kind, f.record);
    await damaged(
      f,
      async (client, values) => {
        expect(
          (
            await client.query(
              "DELETE FROM public.proofstack_evaluation_record_registry WHERE tenant_id=$1 AND record_kind=$2 AND record_id=$3",
              [...values],
            )
          ).rowCount,
        ).toBe(1);
      },
      async (view, calls) => {
        await expect(
          readPostgresModelAssuranceRecordOnClient(view, f.record.scope, f.kind, id),
        ).rejects.toBeInstanceOf(ModelAssuranceRepositoryContractError);
        for (const scope of [
          { ...f.record.scope, tenantId: "ten_other" },
          { ...f.record.scope, projectId: "prj_other" },
          { ...f.record.scope, environmentId: "env_other" },
        ]) {
          const before = calls.length;
          await expect(
            readPostgresModelAssuranceRecordOnClient(view, scope, f.kind, id),
          ).resolves.toBeNull();
          expect(calls.length - before).toBe(1);
        }
      },
    );
  });

  it.each(["child_matches", "parent_matches", "position_matches"] as const)(
    "requires boolean %s instead of a truthy backend string",
    async (column) => {
      const f = fixture("model_assisted_evaluator");
      await withExactScopeTransaction(pool("api"), f.record.scope, async (client) => {
        let projected = false;
        const view = {
          query: (sql: string, values: unknown[]) => {
            if (sql.includes("FROM public.proofstack_evaluation_lineage")) {
              const expression =
                column === "position_matches"
                  ? "inspected.edge_position = inspected.expected_position"
                  : column === "parent_matches"
                    ? "(parent.record_id IS NOT NULL AND parent.schema_version = $7)"
                    : "(edge.project_id = $4 AND edge.environment_id = $5\n          AND edge.child_definition_sha256 = $6)";
              expect(sql).toContain(`${expression} AS ${column}`);
              projected = true;
              return client.query(
                sql.replace(
                  `${expression} AS ${column}`,
                  `CASE WHEN ${expression} THEN 'true'::text ELSE 'false'::text END AS ${column}`,
                ),
                values,
              );
            }
            return client.query(sql, values);
          },
        } as Pick<PoolClient, "query">;
        await expect(
          readPostgresModelAssuranceRecordOnClient(
            view,
            f.record.scope,
            f.kind,
            modelAssuranceRecordId(f.kind, f.record),
          ),
        ).rejects.toBeInstanceOf(ModelAssuranceRepositoryContractError);
        expect(projected).toBe(true);
      });
    },
  );

  it("retains canonical intent when mutable outbox delivery metadata changes", async () => {
    const f = fixture("model_evaluator_profile");
    await withExactScopeTransaction(admin, f.record.scope, async (client) => {
      await client.query("SAVEPOINT retained_delivery");
      try {
        // The ordinary immutable-intent trigger stays enabled for this delivery update.
        expect(
          (
            await client.query(
              "UPDATE public.proofstack_outbox SET attempt_count=attempt_count+1, available_at=available_at+interval '1 second', published_at='2026-09-02T12:00:00.000Z'::timestamptz, last_error='temporary' WHERE tenant_id=$1 AND aggregate_type=$2 AND aggregate_id=$3",
              [
                f.record.scope.tenantId,
                `model_assurance_${f.kind}`,
                modelAssuranceRecordId(f.kind, f.record),
              ],
            )
          ).rowCount,
        ).toBe(1);
        await client.query(`SET LOCAL ROLE "${credentials.api.name}"`);
        await expect(
          readPostgresModelAssuranceRecordOnClient(
            client,
            f.record.scope,
            f.kind,
            modelAssuranceRecordId(f.kind, f.record),
          ),
        ).resolves.toEqual(f.record);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT retained_delivery");
      }
    });
  });

  it("matches all deployed root selections and full-tuple DISTINCT on a complete field matrix", async () => {
    const names = [
      "assessmentId",
      "criterionSetVersionId",
      "oracleVersionId",
      "qualificationReportId",
      "observationId",
      "blindedPlanVersionId",
      "resultId",
      "calibrationReportId",
      "protocolVersionId",
      "reviewId",
      "declarationId",
      "independenceDeclarationId",
      "critiqueId",
      "evaluatorVersionId",
      "assessmentExtensionId",
      "modelProfileVersionId",
      "reportId",
      "suiteVersionId",
    ];
    const ids = Object.fromEntries(names.map((name) => [name, `rec_${name.toLowerCase()}`]));
    const first = { ...ids, definitionSha256: "a".repeat(64) };
    const body = { nodes: [first, first, { ...ids, definitionSha256: "b".repeat(64) }] };
    let count = 0;
    const seen = new Set<string>();
    for (const kind of new Set(records.map((f) => f.kind))) {
      const sql = await admin.query(
        "SELECT * FROM public.proofstack_model_assurance_record_references($1,$2,$3::jsonb)",
        [kind, "rec_root", JSON.stringify(body)],
      );
      const actual = modelAssuranceStorageReferences(kind, "rec_root", body)
        .map((r) => JSON.stringify([r.recordKind, r.recordId, r.definitionSha256]))
        .sort();
      expect(actual).toEqual(
        sql.rows
          .map((r) =>
            JSON.stringify([r.parent_record_kind, r.parent_record_id, r.parent_definition_sha256]),
          )
          .sort(),
      );
      count += sql.rows.length;
      for (const row of sql.rows) seen.add(row.parent_record_kind);
    }
    // Independently counted from the original SQL's root selections: 57 times two digests.
    expect(count).toBe(114);
    expect(seen.size).toBe(17);
    expect(seen.has("model_assurance_assessment")).toBe(false);
  });

  it("matches independent deployed SQL extraction for every retained kind", async () => {
    expect(new Set(records.map((f) => f.kind)).size).toBe(13);
    for (const f of records) {
      const id = modelAssuranceRecordId(f.kind, f.record);
      const sql = await admin.query(
        "SELECT * FROM public.proofstack_model_assurance_record_references($1,$2,$3::jsonb)",
        [f.kind, id, JSON.stringify(f.record)],
      );
      const actual = modelAssuranceStorageReferences(f.kind, id, f.record)
        .map((r) => JSON.stringify([r.recordKind, r.recordId, r.definitionSha256]))
        .sort();
      expect(actual).toEqual(
        sql.rows
          .map((r) =>
            JSON.stringify([r.parent_record_kind, r.parent_record_id, r.parent_definition_sha256]),
          )
          .sort(),
      );
      await expect(
        new PostgresModelAssuranceRepository(pool("api")).find(f.record.scope, f.kind, id),
      ).resolves.toEqual(f.record);
    }
    await expect(
      pool("api").query(
        "SELECT * FROM public.proofstack_model_assurance_record_references($1,$2,$3::jsonb)",
        ["model_evaluator_profile", "mdl_denied", "{}"],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
