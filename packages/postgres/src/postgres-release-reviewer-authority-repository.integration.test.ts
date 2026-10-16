import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  encodeReleaseReviewerAuthorityDefinition,
  type EvidenceScope,
} from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
  releaseReviewerAuthorityReference,
} from "@proofstack/core";
import {
  releaseReviewerAuthorityRepositoryConformanceCases,
  releaseReviewerAuthorityRepositoryFixture,
  authorityVersion,
} from "@proofstack/core/testing";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import {
  PostgresReleaseReviewerAuthorityRepository,
  readPostgresReleaseReviewerTargetOnClient,
} from "./postgres-release-reviewer-authority-repository.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const repository = new PostgresReleaseReviewerAuthorityRepository(pool);
const key = randomUUID().replaceAll("-", "").slice(0, 8);
let count = 0;
const fixture = () => releaseReviewerAuthorityRepositoryFixture(`r_${key}_${++count}`);
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
  expect(
    (
      await pool.query(
        "SELECT current_database() AS name,current_setting('server_version') AS version",
      )
    ).rows,
  ).toEqual([{ name: "proofstack_test", version: "16.15" }]);
  await migrateDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});

describe("normalized native reviewer declaration / unchanged shared conformance", () => {
  for (const example of releaseReviewerAuthorityRepositoryConformanceCases)
    it(example.name, () =>
      example.run((namespace) => ({
        repository,
        fixture: releaseReviewerAuthorityRepositoryFixture(`r_${key}_${namespace}`),
      })),
    );
  it("keeps exact caller backend/XID/savepoint and never turns stored synthetic provenance into expertise", async () => {
    const f = fixture();
    await repository.publishReleaseReviewerAuthority(f.original);
    const client = await pool.connect();
    try {
      await begin(client, f.scope);
      await client.query("SAVEPOINT owner");
      const before = (
        await client.query("SELECT pg_backend_pid() AS pid,txid_current()::text AS xid")
      ).rows;
      const result = await readPostgresReleaseReviewerTargetOnClient(
        client,
        f.scope,
        f.target,
        meter(),
      );
      expect(result).toEqual({ root: f.original, records: [f.original], lifecycle: [] });
      expect(result.root?.assurance).toBe(f.original.assurance);
      expect(
        (await client.query("SELECT pg_backend_pid() AS pid,txid_current()::text AS xid")).rows,
      ).toEqual(before);
      await client.query("ROLLBACK TO SAVEPOINT owner");
    } finally {
      await close(client);
    }
  });
  it.each([
    "proofstack_release_reviewer_memberships",
    "proofstack_release_reviewer_declarations",
    "proofstack_release_reviewer_basis",
  ])(
    "refuses damaged %s instead of returning favorable incomplete reviewer authority",
    async (table) => {
      const f = fixture();
      await repository.publishReleaseReviewerAuthority(f.original);
      const client = await pool.connect();
      try {
        await begin(client, f.scope);
        await client.query("SET LOCAL session_replication_role='replica'");
        await client.query(`DELETE FROM public.${table} WHERE tenant_id=$1 AND version_id=$2`, [
          f.scope.tenantId,
          f.original.authorityVersionId,
        ]);
        const budget = meter();
        await expect(
          readPostgresReleaseReviewerTargetOnClient(client, f.scope, f.target, budget),
        ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
        expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
      } finally {
        await close(client);
      }
      expect(
        await repository.findReleaseReviewerAuthority(f.scope, f.original.authorityVersionId),
      ).toEqual(f.original);
    },
  );
});

describe("native reviewer guard and complete normalized graph", () => {
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects substituted native %s context and taints the owning cut",
    async (field) => {
      const f = fixture(),
        client = await pool.connect(),
        budget = meter();
      try {
        await begin(client, f.scope);
        await expect(
          readPostgresReleaseReviewerTargetOnClient(
            client,
            { ...f.scope, [field]: "scope_foreign" },
            f.target,
            budget,
          ),
        ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
        expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
      } finally {
        await close(client);
      }
    },
  );
  it("refuses a stale REPEATABLE READ source snapshot", async () => {
    const f = fixture(),
      client = await pool.connect();
    try {
      await begin(client, f.scope, "REPEATABLE READ");
      await expect(
        readPostgresReleaseReviewerTargetOnClient(client, f.scope, f.target, meter()),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    } finally {
      await close(client);
    }
  });
  it("refuses a contended reader without returning a favorable partial census", async () => {
    const f = fixture(),
      reader = await pool.connect(),
      writer = await pool.connect();
    try {
      await begin(writer, f.scope);
      await writer.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-reviewer.v1',$1::text)::text,0))",
        [f.scope.tenantId],
      );
      await begin(reader, f.scope);
      const budget = meter();
      await expect(
        readPostgresReleaseReviewerTargetOnClient(reader, f.scope, f.target, budget),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    } finally {
      await close(reader);
      await close(writer);
    }
  });
  it("retains every competing/future version across fixed pages with its original root and revocation", async () => {
    const f = fixture();
    await repository.publishReleaseReviewerAuthority(f.original);
    const records = [f.original];
    for (let i = 0; i < 33; i++) {
      const row = authorityVersion(
        f.original,
        {
          authorityVersionId: `version_reviewer_pages_${key}_${i.toString().padStart(2, "0")}`,
          predecessor: releaseReviewerAuthorityReference(f.original),
        },
        f.original.publishedAt,
      );
      await repository.publishReleaseReviewerAuthority(row);
      records.push(row);
    }
    await repository.publishReleaseReviewerAuthorityLifecycleEvent(f.revocation);
    expect(await repository.readReleaseReviewerAuthorityTarget(f.scope, f.target, meter())).toEqual(
      {
        root: f.original,
        records: records.sort((a, b) => (a.authorityVersionId < b.authorityVersionId ? -1 : 1)),
        lifecycle: [f.revocation],
      },
    );
  });
  it.each(["absent", "revocation"] as const)(
    "holds %s source authority stable through the caller's transaction",
    async (kind) => {
      const f = fixture();
      if (kind === "revocation") await repository.publishReleaseReviewerAuthority(f.original);
      const reader = await pool.connect();
      let writing: Promise<unknown> | undefined;
      try {
        await begin(reader, f.scope);
        const before = await readPostgresReleaseReviewerTargetOnClient(
          reader,
          f.scope,
          f.target,
          meter(),
        );
        expect(before).toEqual(
          kind === "absent"
            ? { root: null, records: [], lifecycle: [] }
            : { root: f.original, records: [f.original], lifecycle: [] },
        );
        writing =
          kind === "absent"
            ? repository.publishReleaseReviewerAuthority(f.original)
            : repository.publishReleaseReviewerAuthorityLifecycleEvent(f.revocation);
        void writing.catch(() => undefined);
        let blocked = false;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          blocked =
            (
              await pool.query(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%proofstack_store_release_reviewer_%') AS blocked",
              )
            ).rows[0]?.blocked === true;
          if (blocked) break;
          await delay(10);
        }
        expect(blocked).toBe(true);
        expect(
          await readPostgresReleaseReviewerTargetOnClient(reader, f.scope, f.target, meter()),
        ).toEqual(before);
        await reader.query("ROLLBACK");
        await writing;
        const after = await repository.readReleaseReviewerAuthorityTarget(
          f.scope,
          f.target,
          meter(),
        );
        expect(after.root).toEqual(f.original);
        expect(after.lifecycle).toEqual(kind === "absent" ? [] : [f.revocation]);
      } finally {
        await close(reader);
        if (writing) await writing;
      }
    },
  );
  it("forces RLS for a fixture table owner and keeps all private reviewer records out of foreign scope", async () => {
    const f = fixture(),
      role = `ps_reviewer_rls_${key}`;
    f.scope = { ...f.scope, tenantId: `tenant_reviewer_rls_${key}` };
    f.original = authorityVersion(f.original, { scope: f.scope }, f.original.publishedAt);
    await repository.publishReleaseReviewerAuthority(f.original);
    const tables = [
      "proofstack_release_reviewer_roots",
      "proofstack_release_reviewer_authorities",
      "proofstack_release_reviewer_memberships",
      "proofstack_release_reviewer_declarations",
      "proofstack_release_reviewer_basis",
      "proofstack_release_reviewer_lifecycle",
    ];
    await pool.query(
      `CREATE ROLE "${role}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    const client = await pool.connect();
    try {
      await begin(client, f.scope);
      await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      for (const table of tables)
        await client.query(`ALTER TABLE public.${table} OWNER TO "${role}"`);
      await client.query(`SET LOCAL ROLE "${role}"`);
      expect(
        (
          await client.query(
            "SELECT count(*)::integer AS count FROM public.proofstack_release_reviewer_authorities",
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
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
            "SELECT count(*)::integer AS count FROM public.proofstack_release_reviewer_authorities",
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      await close(client);
      await pool.query(`DROP OWNED BY "${role}"`);
      await pool.query(`DROP ROLE "${role}"`);
    }
  });
  it.each([
    "proofstack_release_reviewer_memberships",
    "proofstack_release_reviewer_declarations",
    "proofstack_release_reviewer_basis",
  ])("rejects deferred ordinal gaps in %s and rolls back the whole graph", async (table) => {
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
      encodeReleaseReviewerAuthorityDefinition({ scope: f.scope, definition }),
    ).toString("utf8");
    try {
      await begin(client, f.scope);
      await client.query(`ALTER TABLE public.${table} DISABLE TRIGGER ${table}_append_only`);
      await client.query(
        "SELECT public.proofstack_store_release_reviewer_authority($1::jsonb,$2)",
        [JSON.stringify(f.original), canonical],
      );
      // A privileged corruption fixture; guards and deferred completeness remain enabled.
      await client.query(
        `UPDATE public.${table} SET ordinal=ordinal+10 WHERE tenant_id=$1 AND version_id=$2`,
        [f.scope.tenantId, f.original.authorityVersionId],
      );
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({
        code: "23514",
      });
    } finally {
      await close(client);
    }
    expect(
      await repository.findReleaseReviewerAuthority(f.scope, f.original.authorityVersionId),
    ).toBeNull();
  });
});
