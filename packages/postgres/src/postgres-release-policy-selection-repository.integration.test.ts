import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { encodeReleasePolicySelectionDefinition, type EvidenceScope } from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
  ReleasePolicySelectionRepositoryError,
} from "@proofstack/core";
import {
  releasePolicySelectionRepositoryConformanceCases,
  releasePolicySelectionRepositoryFixture,
  selectionVersion,
} from "@proofstack/core/testing";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import {
  PostgresReleasePolicySelectionRepository,
  readPostgresReleaseSelectionTargetOnClient,
  readPostgresReleasePolicySelectionOnClient,
} from "./postgres-release-policy-selection-repository.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const repository = new PostgresReleasePolicySelectionRepository(pool);
const key = randomUUID().replaceAll("-", "").slice(0, 10);
let counter = 0;
function fixture() {
  counter += 1;
  return releasePolicySelectionRepositoryFixture(`ns_${key}_${counter}`);
}
const meter = () =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 100000,
    maxAcquisitionRecordBytes: 64 * 1024 * 1024,
    maxApprovalRecords: 4096,
  });
async function begin(
  client: PoolClient,
  scope: EvidenceScope,
  isolation: "READ COMMITTED" | "REPEATABLE READ" = "READ COMMITTED",
) {
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await client.query(
    "SELECT set_config('proofstack.tenant_id',$1,true),set_config('proofstack.project_id',$2,true),set_config('proofstack.environment_id',$3,true)",
    [scope.tenantId, scope.projectId, scope.environmentId],
  );
}
async function close(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}
beforeAll(async () => {
  expect((await pool.query("SELECT current_database() AS name")).rows[0]?.name).toBe(
    "proofstack_test",
  );
  await migrateDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});

describe("normalized native target-owned selection / unchanged shared contract", () => {
  for (const example of releasePolicySelectionRepositoryConformanceCases)
    it(example.name, () =>
      example.run((namespace) => ({
        repository,
        fixture: releasePolicySelectionRepositoryFixture(`s_${key}_${namespace}`),
      })),
    );

  it("reads every fixed page and terminal history without a favorable prefix", async () => {
    const f = fixture();
    await repository.publishReleasePolicySelection(f.original);
    const records = [f.original];
    for (let i = 0; i < 33; i++) {
      const row = selectionVersion(
        f.original,
        {
          selectionVersionId: `version_pages_${key}_${i.toString().padStart(2, "0")}`,
          predecessor: {
            selectionId: f.original.selectionId,
            selectionVersionId: f.original.selectionVersionId,
            definitionSha256: f.original.definitionSha256,
            installationId: f.original.installationId,
            gateTargetId: f.original.gateTargetId,
          },
        },
        f.original.publishedAt,
      );
      records.push(row);
      await repository.publishReleasePolicySelection(row);
    }
    await repository.publishReleasePolicySelectionLifecycleEvent(f.withdrawal);
    const result = await repository.readReleasePolicySelectionTarget(f.scope, f.target, meter());
    expect(result.records).toEqual(
      records.sort((a, b) => (a.selectionVersionId < b.selectionVersionId ? -1 : 1)),
    );
    expect(result.lifecycle).toEqual([f.withdrawal]);
  });
  it("keeps the same backend/XID/savepoint and leaves guards held for its owning caller", async () => {
    const f = fixture();
    await repository.publishReleasePolicySelection(f.original);
    const client = await pool.connect();
    try {
      await begin(client, f.scope);
      await client.query("SAVEPOINT owner");
      const identity = (
        await client.query("SELECT pg_backend_pid() AS pid,txid_current()::text AS xid")
      ).rows;
      expect(
        (await readPostgresReleaseSelectionTargetOnClient(client, f.scope, f.target, meter())).root,
      ).toEqual(f.original);
      expect(
        await readPostgresReleasePolicySelectionOnClient(
          client,
          f.scope,
          f.original.selectionVersionId,
        ),
      ).toEqual(f.original);
      expect(
        (await client.query("SELECT pg_backend_pid() AS pid,txid_current()::text AS xid")).rows,
      ).toEqual(identity);
      await client.query("ROLLBACK TO SAVEPOINT owner");
    } finally {
      await close(client);
    }
  });
  it("guards absent target creation and observes the committed owner only after a new cut", async () => {
    const f = fixture(),
      reader = await pool.connect();
    let writing: Promise<unknown> | undefined;
    try {
      await begin(reader, f.scope);
      expect(
        await readPostgresReleaseSelectionTargetOnClient(reader, f.scope, f.target, meter()),
      ).toEqual({ root: null, records: [], lifecycle: [] });
      writing = repository.publishReleasePolicySelection(f.original);
      void writing.catch(() => undefined);
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked =
          (
            await pool.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%proofstack_store_release_policy_selection%') AS blocked",
            )
          ).rows[0]?.blocked === true;
        if (blocked) break;
        await delay(10);
      }
      expect(blocked).toBe(true);
      expect(
        await readPostgresReleaseSelectionTargetOnClient(reader, f.scope, f.target, meter()),
      ).toEqual({ root: null, records: [], lifecycle: [] });
      await reader.query("ROLLBACK");
      await writing;
      expect(
        (await repository.readReleasePolicySelectionTarget(f.scope, f.target, meter())).root,
      ).toEqual(f.original);
    } finally {
      await close(reader);
      if (writing) await writing;
    }
  });
  it("rolls back a whole graph when its canonical outbox identity is already occupied", async () => {
    const f = fixture(),
      client = await pool.connect();
    try {
      await begin(client, f.scope);
      await client.query(
        "INSERT INTO public.proofstack_outbox(tenant_id,event_type,aggregate_type,aggregate_id,schema_version,payload,created_at) VALUES($1,'release.selection.published','release_policy_selection',$2,'0.1',$3::jsonb,$4)",
        [
          f.scope.tenantId,
          f.original.selectionVersionId,
          JSON.stringify({ unexpected: "retained conflicting intent" }),
          f.original.publishedAt,
        ],
      );
      await client.query("COMMIT");
    } finally {
      await close(client);
    }
    await expect(repository.publishReleasePolicySelection(f.original)).rejects.toBeInstanceOf(
      ReleasePolicySelectionRepositoryError,
    );
    expect(
      await repository.findReleasePolicySelection(f.scope, f.original.selectionVersionId),
    ).toBeNull();
    expect(await repository.readReleasePolicySelectionTarget(f.scope, f.target, meter())).toEqual({
      root: null,
      records: [],
      lifecycle: [],
    });
  });
  it("rejects damaged normalized projections and taints a caught full-source failure", async () => {
    const f = fixture();
    await repository.publishReleasePolicySelection(f.original);
    const client = await pool.connect();
    try {
      await begin(client, f.scope);
      await client.query("SET LOCAL session_replication_role='replica'");
      await client.query(
        "DELETE FROM public.proofstack_release_selection_publishers WHERE tenant_id=$1 AND version_id=$2",
        [f.scope.tenantId, f.original.selectionVersionId],
      );
      const budget = meter();
      await expect(
        readPostgresReleaseSelectionTargetOnClient(client, f.scope, f.target, budget),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    } finally {
      await close(client);
    }
    expect(
      await repository.findReleasePolicySelection(f.scope, f.original.selectionVersionId),
    ).toEqual(f.original);
  });
  it("holds terminal history stable until its caller rolls back", async () => {
    const f = fixture();
    await repository.publishReleasePolicySelection(f.original);
    const reader = await pool.connect();
    let writing: Promise<unknown> | undefined;
    try {
      await begin(reader, f.scope);
      expect(
        (await readPostgresReleaseSelectionTargetOnClient(reader, f.scope, f.target, meter()))
          .lifecycle,
      ).toEqual([]);
      writing = repository.publishReleasePolicySelectionLifecycleEvent(f.withdrawal);
      void writing.catch(() => undefined);
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked =
          (
            await pool.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%proofstack_store_release_selection_lifecycle%') AS blocked",
            )
          ).rows[0]?.blocked === true;
        if (blocked) break;
        await delay(10);
      }
      expect(blocked).toBe(true);
      expect(
        (await readPostgresReleaseSelectionTargetOnClient(reader, f.scope, f.target, meter()))
          .lifecycle,
      ).toEqual([]);
      await reader.query("ROLLBACK");
      await writing;
      expect(
        (await repository.readReleasePolicySelectionTarget(f.scope, f.target, meter())).lifecycle,
      ).toEqual([f.withdrawal]);
    } finally {
      await close(reader);
      if (writing) await writing;
    }
  });
  it("rejects a contended writer or foreign/native isolation context without a partial inventory", async () => {
    const f = fixture(),
      writer = await pool.connect(),
      reader = await pool.connect();
    try {
      await begin(writer, f.scope);
      await writer.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-selection.v1',$1::text)::text,0))",
        [f.scope.tenantId],
      );
      await begin(reader, f.scope);
      const budget = meter();
      await expect(
        readPostgresReleaseSelectionTargetOnClient(reader, f.scope, f.target, budget),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
      await reader.query("ROLLBACK");
      await writer.query("ROLLBACK");
      await begin(reader, f.scope);
      await expect(
        readPostgresReleaseSelectionTargetOnClient(
          reader,
          { ...f.scope, projectId: "project_foreign" },
          f.target,
          meter(),
        ),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      await reader.query("ROLLBACK");
      await begin(reader, f.scope, "REPEATABLE READ");
      await expect(
        readPostgresReleaseSelectionTargetOnClient(reader, f.scope, f.target, meter()),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    } finally {
      await close(reader);
      await close(writer);
    }
  });
  it("forces exact RLS even for a fixture table owner with explicit read privileges", async () => {
    const f = fixture(),
      role = `ps_selection_rls_${key}`;
    f.scope = { ...f.scope, tenantId: `tenant_selection_rls_${key}` };
    f.original = selectionVersion(f.original, { scope: f.scope }, f.original.publishedAt);
    await repository.publishReleasePolicySelection(f.original);
    const tables = [
      "proofstack_release_selection_roots",
      "proofstack_release_policy_selections",
      "proofstack_release_selection_policies",
      "proofstack_release_selection_publishers",
      "proofstack_release_selection_lifecycle",
    ];
    await pool.query(
      `CREATE ROLE "${role}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    const client = await pool.connect();
    try {
      await begin(client, f.scope);
      await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      for (const table of tables) {
        await client.query(`ALTER TABLE public.${table} OWNER TO "${role}"`);
      }
      await client.query(`SET LOCAL ROLE "${role}"`);
      for (const table of tables) {
        const expected = table.endsWith("lifecycle")
          ? 0
          : table.endsWith("policies")
            ? f.original.policies.length
            : table.endsWith("publishers")
              ? f.original.authorizedPublisherPrincipalIds.length
              : 1;
        expect(
          (
            await client.query(
              `SELECT count(*)::integer AS count FROM public.${table} WHERE tenant_id=$1`,
              [f.scope.tenantId],
            )
          ).rows,
        ).toEqual([{ count: expected }]);
      }
      await client.query("SELECT set_config('proofstack.project_id','project_foreign',true)");
      for (const table of tables)
        expect(
          (await client.query(`SELECT count(*)::integer AS count FROM public.${table}`)).rows,
        ).toEqual([{ count: 0 }]);
      await client.query(
        "SELECT set_config('proofstack.project_id',$1,true),set_config('proofstack.tenant_id','',true)",
        [f.scope.projectId],
      );
      expect(
        (
          await client.query(
            "SELECT count(*)::integer AS count FROM public.proofstack_release_policy_selections",
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      await close(client);
      await pool.query(`DROP OWNED BY "${role}"`);
      await pool.query(`DROP ROLE "${role}"`);
    }
  });
  it.each(["proofstack_release_selection_policies", "proofstack_release_selection_publishers"])(
    "rejects a deferred graph with an ordinal gap in %s",
    async (table) => {
      const f = fixture(),
        client = await pool.connect();
      const {
        schemaVersion: _version,
        definitionSha256: _sha,
        publishedAt: _at,
        publishedByPrincipalId: _by,
        ...definition
      } = f.original;
      const canonical = Buffer.from(
        encodeReleasePolicySelectionDefinition({ scope: f.scope, definition }),
      ).toString("utf8");
      try {
        await begin(client, f.scope);
        // Disable only the append-only trigger before inserts queue deferred graph checks.
        await client.query(`ALTER TABLE public.${table} DISABLE TRIGGER ${table}_append_only`);
        await client.query(
          "SELECT public.proofstack_store_release_policy_selection($1::jsonb,$2)",
          [JSON.stringify(f.original), canonical],
        );
        // A privileged corruption fixture, never a runtime role or product bypass.
        await client.query(
          `UPDATE public.${table} SET ordinal=ordinal+10 WHERE tenant_id=$1 AND version_id=$2`,
          [f.scope.tenantId, f.original.selectionVersionId],
        );
        await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({
          code: "23514",
        });
      } finally {
        await close(client);
      }
      expect(
        await repository.findReleasePolicySelection(f.scope, f.original.selectionVersionId),
      ).toBeNull();
    },
  );
});
