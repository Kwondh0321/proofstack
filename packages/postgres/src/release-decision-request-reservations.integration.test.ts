import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  encodeReleaseDecisionInputDefinition,
  policyEvaluationTimestampOrderKey,
  PolicyEvaluationRequestSchema,
  type EvidenceScope,
  type PolicyEvaluationRequest,
  type PolicyEvaluationRequestDefinition,
} from "@proofstack/contracts";
import {
  digestPolicyEvaluationRequestDefinition,
  PolicyEvaluationRequestConflictError,
} from "@proofstack/core";
import {
  decisionInputVersion,
  releaseDecisionInputRepositoryFixture,
} from "@proofstack/core/testing";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresPolicyEvaluationJobControlRepository } from "./postgres-policy-evaluation-job-control-repository.js";
import { PostgresReleaseDecisionInputRepository } from "./postgres-release-decision-input-repository.js";

const databaseUrl = process.env["PROOFSTACK_TEST_DATABASE_URL"];
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 500 });
const inputs = new PostgresReleaseDecisionInputRepository(pool);
const jobs = new PostgresPolicyEvaluationJobControlRepository(pool);
const key = randomUUID().replaceAll("-", "").slice(0, 8);
const fixture = (name: string) => releaseDecisionInputRepositoryFixture(`res_${key}_${name}`);
function request(graph: ReturnType<typeof fixture>, definition: PolicyEvaluationRequestDefinition) {
  return PolicyEvaluationRequestSchema.parse({
    ...definition,
    schemaVersion: "0.1",
    scope: graph.request.scope,
    definitionSha256: digestPolicyEvaluationRequestDefinition(graph.request.scope, definition),
    createdAt: new Date().toISOString(),
    createdByPrincipalId: "workload_reservation_test",
  });
}
function first(graph: ReturnType<typeof fixture>) {
  const planned = graph.request.evaluations[0];
  if (!planned) throw new Error("Missing complete selected policy fixture");
  return planned.request;
}
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
async function store(client: PoolClient, graph: ReturnType<typeof fixture>) {
  const { schemaVersion: _version, definitionSha256: _hash, ...definition } = graph.request;
  return client.query("SELECT public.proofstack_store_release_decision_input($1::jsonb,$2)", [
    JSON.stringify(graph),
    Buffer.from(
      encodeReleaseDecisionInputDefinition({ scope: graph.request.scope, definition }),
    ).toString("utf8"),
  ]);
}
async function directRequest(client: PoolClient, value: PolicyEvaluationRequest) {
  return client.query(
    `INSERT INTO public.proofstack_policy_evaluation_requests
    VALUES($1,$2,$3,$4,$5,$6::text::timestamptz,$6,$7,$8::jsonb)`,
    [
      value.scope.tenantId,
      value.scope.projectId,
      value.scope.environmentId,
      value.evaluationRequestId,
      value.definitionSha256,
      value.createdAt,
      value.createdByPrincipalId,
      JSON.stringify(value),
    ],
  );
}
async function receipts(graph: ReturnType<typeof fixture>) {
  return (
    await pool.query(
      `SELECT request_id,reservation_profile,reserved_at_lexical,reserved_at_key::text
    FROM public.proofstack_release_decision_input_plans
    WHERE tenant_id=$1 AND input_id=$2 ORDER BY ordinal`,
      [graph.request.scope.tenantId, graph.request.decisionInputRequestId],
    )
  ).rows;
}
async function absent(graph: ReturnType<typeof fixture>) {
  expect(
    await inputs.findReleaseDecisionInput(
      graph.request.scope,
      graph.request.decisionInputRequestId,
    ),
  ).toBeNull();
  expect(await receipts(graph)).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer AS count FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_type='release_decision_input' AND aggregate_id=$2",
        [graph.request.scope.tenantId, graph.request.decisionInputRequestId],
      )
    ).rows,
  ).toEqual([{ count: 0 }]);
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

describe("native decision planning precedes separately authorized C3 enqueue", () => {
  it("rejects a pre-existing request even when its complete definition matches", async () => {
    const graph = fixture("preexisting");
    await jobs.createJob({
      request: request(graph, first(graph)),
      jobId: `job_preexisting_${key}`,
    });
    await expect(inputs.publishReleaseDecisionInput(graph)).rejects.toMatchObject({
      reason: "planned_request_conflict",
    });
    expect(
      await inputs.findReleaseDecisionInput(
        graph.request.scope,
        graph.request.decisionInputRequestId,
      ),
    ).toBeNull();
  });
  it("rejects a later C3 request that substitutes a reserved definition", async () => {
    const graph = fixture("substitution");
    await inputs.publishReleaseDecisionInput(graph);
    const changed = { ...first(graph), evaluationTime: "2026-10-15T12:00:01.000001Z" };
    await expect(
      jobs.createJob({ request: request(graph, changed), jobId: `job_substitution_${key}` }),
    ).rejects.toBeInstanceOf(PolicyEvaluationRequestConflictError);
  });
  it("admits every exact planned definition through separately authorized C3 jobs and preserves first receipts", async () => {
    const graph = fixture("exact");
    await inputs.publishReleaseDecisionInput(graph);
    const original = await receipts(graph);
    expect(original).toHaveLength(graph.request.evaluations.length);
    for (const row of original) {
      expect(row["reservation_profile"]).toBe(1);
      expect(row["reserved_at_key"]).toBe(
        policyEvaluationTimestampOrderKey(row["reserved_at_lexical"]).toString(),
      );
    }
    for (const [i, plan] of graph.request.evaluations.entries()) {
      const value = request(graph, plan.request);
      const created = await jobs.createJob({ request: value, jobId: `job_exact_${key}_${i}` });
      expect(created.created).toBe(true);
      expect(await jobs.createJob({ request: value, jobId: `job_retry_${key}_${i}` })).toEqual({
        ...created,
        created: false,
      });
    }
    const changed = {
      ...graph,
      request: decisionInputVersion(graph.request, {
        publisher: {
          ...graph.request.publisher,
          requestId: "fresh_receipt",
          credentialId: "service_fresh",
        },
      }),
    };
    expect(await inputs.publishReleaseDecisionInput(changed)).toEqual({ created: false, graph });
    expect(await receipts(graph)).toEqual(original);
  });
  it("rolls back earlier reservations, complete sources and intent when a later plan already exists", async () => {
    const graph = fixture("late_conflict"),
      last = graph.request.evaluations.at(-1);
    if (!last) throw new Error("Missing last original plan");
    await jobs.createJob({ request: request(graph, last.request), jobId: `job_last_${key}` });
    await expect(inputs.publishReleaseDecisionInput(graph)).rejects.toMatchObject({
      reason: "planned_request_conflict",
    });
    await absent(graph);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM public.proofstack_release_decision_input_sources WHERE tenant_id=$1 AND input_id=$2",
          [graph.request.scope.tenantId, graph.request.decisionInputRequestId],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });
  it("allows standalone requests without a decision plan", async () => {
    const graph = fixture("standalone");
    expect(
      (
        await jobs.createJob({
          request: request(graph, first(graph)),
          jobId: `job_standalone_${key}`,
        })
      ).created,
    ).toBe(true);
  });
  it.each(["environmentId", "projectId", "tenantId"] as const)(
    "keeps request reservations exact to %s",
    async (field) => {
      const graph = fixture(`scope_${field.toLowerCase()}`);
      await inputs.publishReleaseDecisionInput(graph);
      const other = {
        ...graph,
        request: { ...graph.request, scope: { ...graph.request.scope, [field]: `other_${key}` } },
      };
      expect(
        (
          await jobs.createJob({
            request: request(other, {
              ...first(graph),
              evaluationTime: "2026-10-15T12:00:01.000001Z",
            }),
            jobId: `job_${field.toLowerCase()}_${key}`,
          })
        ).created,
      ).toBe(true);
    },
  );
  it("enforces the full original body on direct writers even with a copied reserved digest", async () => {
    const graph = fixture("direct_body");
    await inputs.publishReleaseDecisionInput(graph);
    const client = await pool.connect();
    try {
      await begin(client, graph.request.scope);
      const changed = {
        ...request(graph, first(graph)),
        evaluationTime: "2026-10-15T12:00:01.000001Z",
      };
      await expect(directRequest(client, changed)).rejects.toMatchObject({ code: "23505" });
    } finally {
      await close(client);
    }
  });
  it("rejects direct request writers outside their actual transaction scope", async () => {
    const graph = fixture("foreign_scope"),
      client = await pool.connect();
    try {
      await begin(client, { ...graph.request.scope, projectId: `foreign_${key}` });
      await expect(directRequest(client, request(graph, first(graph)))).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await close(client);
    }
  });
  it("rejects planning while a direct request writer holds the same absence guard", async () => {
    const graph = fixture("writer_first"),
      client = await pool.connect();
    try {
      await begin(client, graph.request.scope);
      await directRequest(client, request(graph, first(graph)));
      await expect(inputs.publishReleaseDecisionInput(graph)).rejects.toMatchObject({
        code: "55P03",
      });
    } finally {
      await close(client);
    }
    await absent(graph);
    expect((await inputs.publishReleaseDecisionInput(graph)).created).toBe(true);
  });
  it("keeps a direct writer blocked until reservation commit, then rejects substitution", async () => {
    const graph = fixture("planner_first"),
      planner = await pool.connect(),
      writer = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await begin(planner, graph.request.scope);
      await store(planner, graph);
      await begin(writer, graph.request.scope);
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]?.["pid"];
      pending = directRequest(
        writer,
        request(graph, { ...first(graph), evaluationTime: "2026-10-15T12:00:01.000001Z" }),
      );
      const rejected = expect(pending).rejects.toMatchObject({ code: "23505" });
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        blocked =
          (
            await pool.query(
              "SELECT wait_event='advisory' AS blocked FROM pg_stat_activity WHERE pid=$1",
              [pid],
            )
          ).rows[0]?.["blocked"] === true;
        if (blocked) break;
        await delay(10);
      }
      expect(blocked).toBe(true);
      await planner.query("COMMIT");
      await rejected;
    } finally {
      await close(planner);
      await pending?.catch(() => {});
      await close(writer);
    }
    expect(await receipts(graph)).toHaveLength(graph.request.evaluations.length);
  });
  it("releases rolled-back reservations so an ordinary C3 writer can proceed", async () => {
    const graph = fixture("planner_rollback"),
      client = await pool.connect();
    try {
      await begin(client, graph.request.scope);
      await store(client, graph);
    } finally {
      await close(client);
    }
    await absent(graph);
    expect(
      (
        await jobs.createJob({
          request: request(graph, {
            ...first(graph),
            evaluationTime: "2026-10-15T12:00:01.000001Z",
          }),
          jobId: `job_rollback_${key}`,
        })
      ).created,
    ).toBe(true);
  });
  it.each(["REPEATABLE READ", "SERIALIZABLE"])(
    "rejects a stale-snapshot direct writer at %s",
    async (isolation) => {
      const graph = fixture(`isolation_${isolation.replaceAll(" ", "_").toLowerCase()}`),
        client = await pool.connect();
      try {
        await begin(client, graph.request.scope, isolation);
        await expect(directRequest(client, request(graph, first(graph)))).rejects.toMatchObject({
          code: "0A000",
        });
      } finally {
        await close(client);
      }
    },
  );
  it("keeps reservation triggers mandatory, private and fixed-search-path", async () => {
    expect(
      (
        await pool.query(`SELECT tgname,tgenabled FROM pg_trigger WHERE tgname IN
      ('proofstack_release_decision_input_plan_reservation','proofstack_policy_evaluation_request_reservation') ORDER BY tgname`)
      ).rows,
    ).toEqual([
      { tgname: "proofstack_policy_evaluation_request_reservation", tgenabled: "O" },
      { tgname: "proofstack_release_decision_input_plan_reservation", tgenabled: "O" },
    ]);
    const rows = (
      await pool.query(`SELECT p.prosecdef,p.proconfig,EXISTS(SELECT FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p WHERE p.oid IN('public.proofstack_reserve_release_decision_request()'::regprocedure,'public.proofstack_enforce_release_decision_request_reservation()'::regprocedure)`)
    ).rows;
    expect(rows).toEqual(
      Array.from({ length: 2 }, () => ({
        prosecdef: true,
        proconfig: ["search_path=pg_catalog"],
        public_execute: false,
      })),
    );
  });
  it("replaces caller-supplied reservation receipts with the native guarded cut", async () => {
    const graph = fixture("native_receipt"),
      plan = graph.request.evaluations[0];
    if (!plan) throw new Error("Missing original plan");
    const client = await pool.connect();
    try {
      await begin(client, graph.request.scope);
      const before = (
        await client.query(
          "SELECT public.proofstack_policy_evaluation_utc(clock_timestamp()) AS cut",
        )
      ).rows[0]?.["cut"];
      const row = {
        tenant_id: graph.request.scope.tenantId,
        project_id: graph.request.scope.projectId,
        environment_id: graph.request.scope.environmentId,
        input_id: graph.request.decisionInputRequestId,
        input_sha256: graph.request.definitionSha256,
        ordinal: 0,
        request_id: plan.request.evaluationRequestId,
        request_sha256: plan.requestSha256,
        policy_id: plan.request.policy.policyId,
        policy_version_id: plan.request.policy.policyVersionId,
        policy_sha256: plan.request.policy.definitionSha256,
        mode: plan.mode,
        planned: plan,
        reservation_profile: 999,
        reserved_at_lexical: "2020-01-01T00:00:00.000Z",
        reserved_at_key: "0",
      };
      const stored = (
        await client.query(
          `INSERT INTO public.proofstack_release_decision_input_plans
        SELECT * FROM jsonb_populate_record(NULL::public.proofstack_release_decision_input_plans,$1::jsonb)
        RETURNING reservation_profile,reserved_at_lexical,reserved_at_key::text`,
          [JSON.stringify(row)],
        )
      ).rows[0];
      const after = (
        await client.query(
          "SELECT public.proofstack_policy_evaluation_utc(clock_timestamp()) AS cut",
        )
      ).rows[0]?.["cut"];
      expect(stored?.["reservation_profile"]).toBe(1);
      const cut = policyEvaluationTimestampOrderKey(stored?.["reserved_at_lexical"]);
      expect(cut >= policyEvaluationTimestampOrderKey(before)).toBe(true);
      expect(cut <= policyEvaluationTimestampOrderKey(after)).toBe(true);
      expect(stored?.["reserved_at_key"]).toBe(cut.toString());
    } finally {
      await close(client);
    }
    await absent(graph);
  });
});
