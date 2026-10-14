import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  policyAcquisitionRepositoryConformanceCases,
  policyJobConformanceRequest,
} from "@proofstack/core/testing";
import {
  buildPolicyEvaluationJobOutboxIntents as buildIntents,
  createPolicyEvaluationJobHistoryEntry as createEntry,
  digestPolicyEvaluationRequestDefinition,
  encodePolicyEvaluationJobGraph,
} from "@proofstack/core";
import { encodePolicyEvaluationJobHistoryEntry } from "@proofstack/contracts";
import { migrateDatabase } from "./migration-runner.js";
import {
  DEFAULT_RUNTIME_ROLE_NAMES,
  provisionRuntimeRoles,
  type RuntimeRoleProvisioningOptions,
} from "./runtime-roles.js";
import { PostgresPolicyEvaluationJobControlRepository } from "./postgres-policy-evaluation-job-control-repository.js";
import { PostgresPolicyEvaluationJobWorkerRepository } from "./postgres-policy-evaluation-job-worker-repository.js";
import { PostgresPolicyAcquisitionRepository } from "./postgres-policy-acquisition-repository.js";

const databaseUrl = process.env["PROOFSTACK_TEST_DATABASE_URL"];
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const key = randomUUID().replaceAll("-", "").slice(0, 10);
const credentials = Object.fromEntries(
  Object.keys(DEFAULT_RUNTIME_ROLE_NAMES).map((kind) => [
    kind,
    {
      name: `ps_acq_${kind.toLowerCase()}_${key}`,
      password: `proofstack-acquisition-test-${kind}-${key}`,
    },
  ]),
) as unknown as RuntimeRoleProvisioningOptions;
const admin = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 500 });
const pools: Pool[] = [];
function rolePool(kind: "policyEvaluationControl" | "policyEvaluator") {
  const role = credentials[kind];
  if (!role) throw new Error("Missing test role");
  const url = new URL(databaseUrl as string);
  url.username = role.name;
  url.password = role.password;
  const pool = new Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 500 });
  pools.push(pool);
  return pool;
}
const controlPool = rolePool("policyEvaluationControl"),
  workerPool = rolePool("policyEvaluator");
const control = new PostgresPolicyEvaluationJobControlRepository(controlPool);
const worker = new PostgresPolicyEvaluationJobWorkerRepository(workerPool);
const acquisition = new PostgresPolicyAcquisitionRepository(workerPool);
beforeAll(async () => {
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, credentials);
});
afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  for (const role of Object.values(credentials)) {
    if (role) {
      await admin.query(`DROP OWNED BY "${role.name}"`);
      await admin.query(`DROP ROLE "${role.name}"`);
    }
  }
  await admin.end();
});
describe("native acquisition allowance shared conformance", () => {
  for (const mode of ["reserve", "observed", "uncertain"] as const)
    it(`rejects ${mode} when the native lease expires after mutation but before commit`, async () => {
      const scope = {
        tenantId: `tenant_acquisition_expiry_${key}_${mode}`,
        projectId: `project_acquisition_${key}`,
        environmentId: `environment_acquisition_${key}`,
      };
      const request = policyJobConformanceRequest(scope);
      request.limits.leaseDurationMilliseconds = 2000;
      request.limits.heartbeatIntervalMilliseconds = 500;
      const {
        createdAt: _at,
        createdByPrincipalId: _by,
        definitionSha256: _sha,
        schemaVersion: _version,
        scope: _scope,
        ...definition
      } = request;
      request.definitionSha256 = digestPolicyEvaluationRequestDefinition(scope, definition);
      await control.createJob({ request, jobId: "job_acquisition_expiry" });
      let previous = await worker.claimJob({
        scope,
        jobId: "job_acquisition_expiry",
        workerId: "worker_acquisition",
        attemptId: "attempt_acquisition",
        leaseId: "lease_acquisition",
      });
      const fence = previous.job.currentLease!.mutationFence;
      if (mode !== "reserve")
        previous = (
          await acquisition.reserveAcquisition({ scope, fence, allowanceId: "allowance_expiry" })
        ).snapshot;
      const head = (await worker.findHistoryHead(scope, fence.jobId))!;
      const previousEntry = (await worker.readHistoryPage(head, 0)).entries.at(-1)!;
      const client = await admin.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query(
          "SELECT set_config('proofstack.tenant_id',$1,true),set_config('proofstack.project_id',$2,true),set_config('proofstack.environment_id',$3,true)",
          [scope.tenantId, scope.projectId, scope.environmentId],
        );
        const usage =
          mode === "uncertain"
            ? null
            : { reads: 1, records: 1, references: 0, recordBytes: 2, referenceBytes: 0 };
        const row =
          mode === "reserve"
            ? await client.query(
                "SELECT (public.proofstack_reserve_policy_acquisition($1::jsonb,$2))->'snapshot' AS value",
                [JSON.stringify(fence), "allowance_expiry"],
              )
            : await client.query(
                "SELECT public.proofstack_settle_policy_acquisition($1::jsonb,$2,$3::jsonb) AS value",
                [JSON.stringify(fence), "allowance_expiry", JSON.stringify(usage)],
              );
        const next = row.rows[0]!.value;
        const operation =
          mode === "reserve"
            ? { kind: "reserve_acquisition" as const, fence, allowanceId: "allowance_expiry" }
            : {
                kind: "settle_acquisition" as const,
                fence,
                allowanceId: "allowance_expiry",
                usage,
              };
        const entry = createEntry({ previous, previousEntry, next, operation });
        await client.query(
          "SELECT public.proofstack_append_policy_evaluation_job_history($1::jsonb,$2,$3,$4::jsonb)",
          [
            JSON.stringify(entry),
            Buffer.from(encodePolicyEvaluationJobHistoryEntry(entry.definition)).toString("utf8"),
            Buffer.from(encodePolicyEvaluationJobGraph(next)).toString("utf8"),
            JSON.stringify(buildIntents(previous, next)),
          ],
        );
        await client.query(
          "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)",
          [previous.job.currentLease!.expiresAt],
        );
        await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "55000" });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect(await worker.findJob(scope, fence.jobId)).toEqual(previous);
      expect(await worker.findHistoryHead(scope, fence.jobId)).toEqual(head);
      const rows = await admin.query(
        "SELECT state FROM public.proofstack_policy_acquisition_allowances WHERE tenant_id=$1",
        [scope.tenantId],
      );
      expect(rows.rows).toEqual(mode === "reserve" ? [] : [{ state: "reserved" }]);
    });
  for (const [index, testcase] of policyAcquisitionRepositoryConformanceCases.entries())
    it(testcase.name, async () => {
      await testcase.run({
        control,
        worker,
        acquisition,
        request: (scope) =>
          policyJobConformanceRequest(
            scope ?? {
              tenantId: `tenant_acquisition_${key}_${index}`,
              projectId: `project_acquisition_${key}`,
              environmentId: `environment_acquisition_${key}`,
            },
          ),
      });
    });
  it("grants fenced credit/settlement only to evaluator and keeps validation/burn helpers private", async () => {
    for (const [kind, role] of Object.entries(credentials)) {
      if (!role) throw new Error("Missing role");
      const value = await admin.query(
        "SELECT has_function_privilege($1,'public.proofstack_reserve_policy_acquisition(jsonb,text)','EXECUTE') AS reserve,has_function_privilege($1,'public.proofstack_settle_policy_acquisition(jsonb,text,jsonb)','EXECUTE') AS settle,has_function_privilege($1,'public.proofstack_charge_unknown_policy_acquisition(jsonb)','EXECUTE') AS burn,has_function_privilege($1,'public.proofstack_validate_policy_acquisition_allowance(jsonb,boolean)','EXECUTE') AS validate",
        [role.name],
      );
      expect(value.rows[0]).toEqual({
        reserve: kind === "policyEvaluator",
        settle: kind === "policyEvaluator",
        burn: false,
        validate: false,
      });
    }
  });
});
