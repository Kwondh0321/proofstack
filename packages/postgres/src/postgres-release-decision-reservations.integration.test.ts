import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { EvidenceScope } from "@proofstack/contracts";
import { ReleaseDecisionVerificationBudget } from "@proofstack/core";
import { releaseDecisionInputRepositoryFixture } from "@proofstack/core/testing";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresReleaseDecisionInputRepository } from "./postgres-release-decision-input-repository.js";
import { readPostgresReleaseDecisionReservationsOnClient } from "./postgres-release-decision-reservations.js";

const databaseUrl = process.env["PROOFSTACK_TEST_DATABASE_URL"];
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 500 });
const inputs = new PostgresReleaseDecisionInputRepository(pool);
const key = randomUUID().replaceAll("-", "").slice(0, 8);
const fixture = (name: string) =>
  releaseDecisionInputRepositoryFixture(`ro_${key}_${name}`, {
    tenantId: `tenant_ro_${key}_${name}`,
    projectId: `project_ro_${key}`,
    environmentId: `env_ro_${key}`,
  });
const reference = (graph: ReturnType<typeof fixture>) => ({
  decisionInputRequestId: graph.request.decisionInputRequestId,
  definitionSha256: graph.request.definitionSha256,
});
const meter = (graph: ReturnType<typeof fixture>) =>
  new ReleaseDecisionVerificationBudget(graph.request.verificationLimits);
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

it("retains the caller backend, XID and savepoint with complete native time keys", async () => {
  const graph = fixture("owner");
  await inputs.publishReleaseDecisionInput(graph);
  const client = await pool.connect();
  try {
    await begin(client, graph.request.scope);
    await client.query("SAVEPOINT owner");
    const before = (
      await client.query("SELECT pg_backend_pid() AS pid,txid_current()::text AS xid")
    ).rows;
    const budget = meter(graph);
    const result = await readPostgresReleaseDecisionReservationsOnClient(
      client,
      graph.request.scope,
      reference(graph),
      budget,
    );
    expect(result?.state).toBe("reservations_observed");
    expect(result?.graph).toEqual(graph);
    const native = (
      await client.query(
        "SELECT reserved_at_lexical,reserved_at_key::text FROM public.proofstack_release_decision_input_plans WHERE tenant_id=$1 AND input_id=$2 ORDER BY ordinal",
        [graph.request.scope.tenantId, graph.request.decisionInputRequestId],
      )
    ).rows;
    expect(result?.reservations.map((r) => [r.reservedAt, r.reservedAtKey])).toEqual(
      native.map((r) => [r["reserved_at_lexical"], r["reserved_at_key"]]),
    );
    expect(budget.snapshot().records).toBe(16);
    expect(
      (await client.query("SELECT pg_backend_pid() AS pid,txid_current()::text AS xid")).rows,
    ).toEqual(before);
    await client.query("ROLLBACK TO SAVEPOINT owner");
  } finally {
    await close(client);
  }
});

it.each(["present", "absent"])(
  "retains the actual %s input guard after returning",
  async (state) => {
    const graph = fixture(`guard_${state}`);
    if (state === "present") await inputs.publishReleaseDecisionInput(graph);
    const reader = await pool.connect();
    let writing: Promise<unknown> | undefined;
    try {
      await begin(reader, graph.request.scope);
      const result = await readPostgresReleaseDecisionReservationsOnClient(
        reader,
        graph.request.scope,
        reference(graph),
        meter(graph),
      );
      if (state === "present") expect(result?.graph).toEqual(graph);
      else expect(result).toBeNull();
      const second =
        state === "absent"
          ? graph
          : releaseDecisionInputRepositoryFixture(`ro_${key}_writer`, graph.request.scope);
      writing = inputs.publishReleaseDecisionInput(second);
      const tracked = writing.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        blocked =
          (
            await pool.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%proofstack_store_release_decision_input%') AS blocked",
            )
          ).rows[0]?.["blocked"] === true;
        if (blocked) break;
        await delay(10);
      }
      expect(blocked).toBe(true);
      await reader.query("ROLLBACK");
      expect(await tracked).toMatchObject({ ok: true, value: { created: true } });
    } finally {
      await close(reader);
      await writing?.catch(() => {});
    }
  },
);

it.each(["REPEATABLE READ", "SERIALIZABLE"])(
  "rejects detached/stale %s observations",
  async (isolation) => {
    const graph = fixture(isolation === "SERIALIZABLE" ? "serial" : "repeatable"),
      client = await pool.connect();
    const budget = meter(graph);
    try {
      await begin(client, graph.request.scope, isolation);
      await expect(
        readPostgresReleaseDecisionReservationsOnClient(
          client,
          graph.request.scope,
          reference(graph),
          budget,
        ),
      ).rejects.toMatchObject({ reason: "source_read_failed", cause: { code: "0A000" } });
      expect(() => budget.snapshot()).toThrow();
    } finally {
      await close(client);
    }
  },
);

it("rejects a foreign transaction scope before disclosing even original absence", async () => {
  const graph = fixture("foreign"),
    client = await pool.connect(),
    budget = meter(graph);
  try {
    await begin(client, { ...graph.request.scope, projectId: "project_foreign" });
    await expect(
      readPostgresReleaseDecisionReservationsOnClient(
        client,
        graph.request.scope,
        reference(graph),
        budget,
      ),
    ).rejects.toMatchObject({ reason: "source_read_failed", cause: { code: "42501" } });
  } finally {
    await close(client);
  }
});

it("permanently taints the same acquisition after a caught native observation budget failure", async () => {
  const graph = fixture("budget");
  await inputs.publishReleaseDecisionInput(graph);
  const client = await pool.connect();
  try {
    await begin(client, graph.request.scope);
    const budget = new ReleaseDecisionVerificationBudget({
      ...graph.request.verificationLimits,
      maxAcquisitionRecords: 13,
    });
    await expect(
      readPostgresReleaseDecisionReservationsOnClient(
        client,
        graph.request.scope,
        reference(graph),
        budget,
      ),
    ).rejects.toMatchObject({ reason: "record_limit" });
    await expect(
      readPostgresReleaseDecisionReservationsOnClient(
        client,
        graph.request.scope,
        reference(graph),
        budget,
      ),
    ).rejects.toMatchObject({ reason: "record_limit" });
    expect(() => budget.snapshot()).toThrow();
  } finally {
    await close(client);
  }
});

it.each(["present", "absent"])(
  "rejects autocommit %s reads after their transaction guards have ended",
  async (state) => {
    const graph = fixture(`autocommit_${state}`);
    if (state === "present") await inputs.publishReleaseDecisionInput(graph);
    const client = await pool.connect(),
      budget = meter(graph);
    try {
      await client.query(
        "SELECT set_config('proofstack.tenant_id',$1,false),set_config('proofstack.project_id',$2,false),set_config('proofstack.environment_id',$3,false)",
        [
          graph.request.scope.tenantId,
          graph.request.scope.projectId,
          graph.request.scope.environmentId,
        ],
      );
      await expect(
        readPostgresReleaseDecisionReservationsOnClient(
          client,
          graph.request.scope,
          reference(graph),
          budget,
        ),
      ).rejects.toMatchObject({
        reason: "source_read_failed",
        cause: { code: "release_decision_input_repository_invalid" },
      });
      expect(() => budget.snapshot()).toThrow();
    } finally {
      await client.query(
        "SELECT set_config('proofstack.tenant_id','',false),set_config('proofstack.project_id','',false),set_config('proofstack.environment_id','',false)",
      );
      client.release();
    }
  },
);
