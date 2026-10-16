import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  encodeReleaseDecisionInputDefinition,
  policyEvaluationTimestampOrderKey,
  type EvidenceScope,
} from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "@proofstack/core";
import {
  releaseDecisionInputRepositoryConformanceCases,
  releaseDecisionInputRepositoryFixture,
  decisionInputVersion,
} from "@proofstack/core/testing";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import {
  PostgresReleaseDecisionInputRepository,
  readPostgresReleaseDecisionInputOnClient,
} from "./postgres-release-decision-input-repository.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 8 }),
  repository = new PostgresReleaseDecisionInputRepository(pool);
const key = randomUUID().replaceAll("-", "").slice(0, 8);
const fixture = (namespace: string) =>
  releaseDecisionInputRepositoryFixture(`i_${key}_${namespace}`, {
    tenantId: `tenant_di_${key}_${namespace}`,
    projectId: `project_di_${key}`,
    environmentId: `env_di_${key}`,
  });
const meter = () =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 100000,
    maxAcquisitionRecordBytes: 64 * 1024 * 1024,
    maxApprovalRecords: 0,
  });
async function begin(client: PoolClient, scope: EvidenceScope, isolation = "READ COMMITTED") {
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
describe("native original decision input / unchanged shared repository conformance", () => {
  for (const example of releaseDecisionInputRepositoryConformanceCases)
    it(example.name, () => example.run((namespace) => ({ repository, graph: fixture(namespace) })));
  it("retains its caller backend/XID/savepoint and original native precision", async () => {
    const graph = fixture("provided");
    await repository.publishReleaseDecisionInput(graph);
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(
        "SELECT set_config('proofstack.tenant_id',$1,true),set_config('proofstack.project_id',$2,true),set_config('proofstack.environment_id',$3,true)",
        [
          graph.request.scope.tenantId,
          graph.request.scope.projectId,
          graph.request.scope.environmentId,
        ],
      );
      await client.query("SAVEPOINT owner");
      const before = (
        await client.query("SELECT pg_backend_pid() AS pid,txid_current()::text AS xid")
      ).rows;
      expect(
        await readPostgresReleaseDecisionInputOnClient(
          client,
          graph.request.scope,
          graph.request.decisionInputRequestId,
          new ReleaseDecisionVerificationBudget({
            maxAcquisitionRecords: 100000,
            maxAcquisitionRecordBytes: 64 * 1024 * 1024,
            maxApprovalRecords: 0,
          }),
        ),
      ).toEqual(graph);
      expect(
        (await client.query("SELECT pg_backend_pid() AS pid,txid_current()::text AS xid")).rows,
      ).toEqual(before);
      await client.query("ROLLBACK TO SAVEPOINT owner");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("retains full-precision original cut keys rather than reconstructing them from Date", async () => {
    const original = fixture("precision"),
      graph = {
        ...original,
        request: decisionInputVersion(original.request, {
          createdAt: "2026-10-15T12:00:00.000000000000000000000000001Z",
          expiresAt: "2026-10-15T12:05:00.000000000000000000000000002Z",
        }),
      };
    await repository.publishReleaseDecisionInput(graph);
    expect(
      await repository.findReleaseDecisionInput(
        graph.request.scope,
        graph.request.decisionInputRequestId,
      ),
    ).toEqual(graph);
    expect(
      (
        await pool.query(
          "SELECT created_at_key::text,expires_at_key::text FROM public.proofstack_release_decision_inputs WHERE tenant_id=$1 AND input_id=$2",
          [graph.request.scope.tenantId, graph.request.decisionInputRequestId],
        )
      ).rows,
    ).toEqual([
      {
        created_at_key: policyEvaluationTimestampOrderKey(graph.request.createdAt).toString(),
        expires_at_key: policyEvaluationTimestampOrderKey(graph.request.expiresAt).toString(),
      },
    ]);
  });
  it("guards absence creation until its caller ends the transaction", async () => {
    const graph = fixture("absence_guard"),
      reader = await pool.connect();
    let writing: Promise<unknown> | undefined;
    try {
      await begin(reader, graph.request.scope);
      expect(
        await readPostgresReleaseDecisionInputOnClient(
          reader,
          graph.request.scope,
          graph.request.decisionInputRequestId,
          meter(),
        ),
      ).toBeNull();
      writing = repository.publishReleaseDecisionInput(graph);
      void writing.catch(() => undefined);
      let blocked = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        blocked =
          (
            await pool.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%proofstack_store_release_decision_input%') AS blocked",
            )
          ).rows[0]?.blocked === true;
        if (blocked) break;
        await delay(10);
      }
      expect(blocked).toBe(true);
      expect(
        await readPostgresReleaseDecisionInputOnClient(
          reader,
          graph.request.scope,
          graph.request.decisionInputRequestId,
          meter(),
        ),
      ).toBeNull();
      await reader.query("ROLLBACK");
      await writing;
      expect(
        await repository.findReleaseDecisionInput(
          graph.request.scope,
          graph.request.decisionInputRequestId,
        ),
      ).toEqual(graph);
    } finally {
      await close(reader);
      if (writing) await writing;
    }
  });
  it("rejects nonmatching scope and stale isolation before trusting an absence", async () => {
    const graph = fixture("scope_isolation"),
      client = await pool.connect();
    try {
      await begin(client, graph.request.scope, "REPEATABLE READ");
      await expect(
        readPostgresReleaseDecisionInputOnClient(
          client,
          graph.request.scope,
          graph.request.decisionInputRequestId,
        ),
      ).rejects.toMatchObject({ code: "0A000" });
      await client.query("ROLLBACK");
      await begin(client, graph.request.scope);
      await expect(
        readPostgresReleaseDecisionInputOnClient(
          client,
          { ...graph.request.scope, environmentId: "env_wrong" },
          graph.request.decisionInputRequestId,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await close(client);
    }
  });
  it("rejects a contended guard without releasing a successful partial graph", async () => {
    const graph = fixture("contended"),
      writer = await pool.connect();
    try {
      await begin(writer, graph.request.scope);
      await writer.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-decision-input.v1',$1::text)::text,0))",
        [graph.request.scope.tenantId],
      );
      const budget = meter();
      await expect(
        repository.findReleaseDecisionInput(
          graph.request.scope,
          graph.request.decisionInputRequestId,
          budget,
        ),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(() => budget.snapshot()).toThrow();
    } finally {
      await close(writer);
    }
  });
  it.each(["proofstack_release_decision_input_sources", "proofstack_release_decision_input_plans"])(
    "rejects damaged %s and preserves a failed original meter",
    async (table) => {
      const graph = fixture(`damage_${table.endsWith("plans") ? "plans" : "sources"}`),
        client = await pool.connect();
      await repository.publishReleaseDecisionInput(graph);
      try {
        await begin(client, graph.request.scope);
        await client.query("SET LOCAL session_replication_role='replica'");
        await client.query(`DELETE FROM public.${table} WHERE tenant_id=$1 AND input_id=$2`, [
          graph.request.scope.tenantId,
          graph.request.decisionInputRequestId,
        ]);
        const budget = meter();
        await expect(
          readPostgresReleaseDecisionInputOnClient(
            client,
            graph.request.scope,
            graph.request.decisionInputRequestId,
            budget,
          ),
        ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
        expect(() => budget.snapshot()).toThrow();
      } finally {
        await close(client);
      }
      expect(
        await repository.findReleaseDecisionInput(
          graph.request.scope,
          graph.request.decisionInputRequestId,
        ),
      ).toEqual(graph);
    },
  );
  it("rejects a deferred plan ordinal gap and rolls back every source and intent", async () => {
    const graph = fixture("ordinal_gap"),
      client = await pool.connect();
    const { schemaVersion: _version, definitionSha256: _hash, ...definition } = graph.request;
    const canonical = Buffer.from(
      encodeReleaseDecisionInputDefinition({ scope: graph.request.scope, definition }),
    ).toString("utf8");
    try {
      await begin(client, graph.request.scope);
      await client.query(
        "ALTER TABLE public.proofstack_release_decision_input_plans DISABLE TRIGGER proofstack_release_decision_input_plans_append_only",
      );
      await client.query("SELECT public.proofstack_store_release_decision_input($1::jsonb,$2)", [
        JSON.stringify(graph),
        canonical,
      ]);
      await client.query(
        "UPDATE public.proofstack_release_decision_input_plans SET ordinal=ordinal+10 WHERE tenant_id=$1 AND input_id=$2",
        [graph.request.scope.tenantId, graph.request.decisionInputRequestId],
      );
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({
        code: "23514",
      });
    } finally {
      await close(client);
    }
    expect(
      await repository.findReleaseDecisionInput(
        graph.request.scope,
        graph.request.decisionInputRequestId,
      ),
    ).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_type='release_decision_input' AND aggregate_id=$2",
          [graph.request.scope.tenantId, graph.request.decisionInputRequestId],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });
  it("forces exact-scope RLS even for every nonempty input table's owner", async () => {
    const graph = fixture("rls"),
      role = `ps_input_rls_${key}`,
      tables = [
        "proofstack_release_decision_inputs",
        "proofstack_release_decision_input_sources",
        "proofstack_release_decision_input_plans",
      ];
    await repository.publishReleaseDecisionInput(graph);
    await pool.query(
      `CREATE ROLE "${role}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    const client = await pool.connect();
    try {
      await begin(client, graph.request.scope);
      await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      for (const table of tables)
        await client.query(`ALTER TABLE public.${table} OWNER TO "${role}"`);
      await client.query(`SET LOCAL ROLE "${role}"`);
      for (const table of tables)
        expect(
          Number(
            (await client.query(`SELECT count(*) AS count FROM public.${table}`)).rows[0]?.count,
          ),
        ).toBeGreaterThan(0);
      for (const field of ["tenant_id", "project_id", "environment_id"]) {
        await client.query("SAVEPOINT scope_check");
        await client.query("SELECT set_config($1,'scope_foreign',true)", [`proofstack.${field}`]);
        for (const table of tables)
          expect(
            (await client.query(`SELECT count(*)::integer AS count FROM public.${table}`)).rows,
          ).toEqual([{ count: 0 }]);
        await client.query("ROLLBACK TO SAVEPOINT scope_check");
      }
      await client.query("SELECT set_config('proofstack.tenant_id','',true)");
      for (const table of tables)
        expect(
          (await client.query(`SELECT count(*)::integer AS count FROM public.${table}`)).rows,
        ).toEqual([{ count: 0 }]);
    } finally {
      await close(client);
      await pool.query(`DROP OWNED BY "${role}"`);
      await pool.query(`DROP ROLE "${role}"`);
    }
  });
});
