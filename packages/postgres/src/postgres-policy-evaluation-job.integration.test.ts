import { randomUUID } from "node:crypto";
import { digestPolicyEvaluationRequestDefinition } from "@proofstack/core";
import {
  createPolicyJobRepositoryConformanceCases,
  policyJobConformanceRequest,
} from "@proofstack/core/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresPolicyEvaluationJobControlRepository } from "./postgres-policy-evaluation-job-control-repository.js";
import { PostgresPolicyEvaluationJobRecovery } from "./postgres-policy-evaluation-job-recovery.js";
import { PostgresPolicyEvaluationJobWorkerRepository } from "./postgres-policy-evaluation-job-worker-repository.js";
import {
  DEFAULT_RUNTIME_ROLE_NAMES,
  provisionRuntimeRoles,
  type RuntimeRoleCredentials,
  type RuntimeRoleProvisioningOptions,
} from "./runtime-roles.js";

const databaseUrl = process.env["PROOFSTACK_TEST_DATABASE_URL"];
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const key = randomUUID().replaceAll("-", "").slice(0, 12);
const credentials = Object.fromEntries(
  Object.keys(DEFAULT_RUNTIME_ROLE_NAMES).map((kind) => [
    kind,
    { name: `ps_pj_${kind.toLowerCase()}_${key}`, password: `proofstack-test-${kind}-${key}` },
  ]),
) as Record<keyof typeof DEFAULT_RUNTIME_ROLE_NAMES, RuntimeRoleCredentials>;
const admin = new Pool({ connectionString: databaseUrl, max: 4 });
function poolFor(kind: keyof typeof credentials) {
  const url = new URL(databaseUrl as string);
  url.username = credentials[kind].name;
  url.password = credentials[kind].password;
  return new Pool({ connectionString: url.toString(), max: 4 });
}
const controlPool = poolFor("policyEvaluationControl");
const workerPool = poolFor("policyEvaluator");
const apiPool = poolFor("api");
const control = new PostgresPolicyEvaluationJobControlRepository(controlPool);
const worker = new PostgresPolicyEvaluationJobWorkerRepository(workerPool);
function scope(suffix: string) {
  return {
    tenantId: `ten_pj_${key}_${suffix}`,
    projectId: `prj_pj_${key}`,
    environmentId: `env_pj_${key}`,
  };
}
function shortLeaseRequest(exact: ReturnType<typeof scope>) {
  const request = policyJobConformanceRequest(exact);
  request.limits.heartbeatIntervalMilliseconds = 100;
  request.limits.leaseDurationMilliseconds = 1000;
  const {
    createdAt: _at,
    createdByPrincipalId: _by,
    definitionSha256: _sha,
    schemaVersion: _version,
    scope: _scope,
    ...definition
  } = request;
  request.definitionSha256 = digestPolicyEvaluationRequestDefinition(exact, definition);
  return request;
}
beforeAll(async () => {
  expect((await admin.query("SELECT current_database() AS name")).rows[0]?.name).toBe(
    "proofstack_test",
  );
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, credentials satisfies RuntimeRoleProvisioningOptions);
});
afterAll(async () => {
  await controlPool.end();
  await workerPool.end();
  await apiPool.end();
  for (const { name } of Object.values(credentials)) {
    await admin.query(`DROP OWNED BY "${name}"`);
    await admin.query(`DROP ROLE "${name}"`);
  }
  await admin.end();
});
describe("native scoped policy job state/history and separate roles", () => {
  for (let caseIndex = 0; caseIndex < 11; caseIndex++) {
    const cases = createPolicyJobRepositoryConformanceCases(
      (exact = scope(`shared_${caseIndex}`)) => policyJobConformanceRequest(exact),
    );
    const testCase = cases[caseIndex]!;
    it(`shared conformance: ${testCase.name}`, async () => {
      const initial = performance.now();
      await testCase.run({
        repository: {
          createJob: (command) => control.createJob(command),
          findJob: (exact, id) => control.findJob(exact, id),
          findHistoryHead: (exact, id) => control.findHistoryHead(exact, id),
          readHistoryPage: (head, index) => control.readHistoryPage(head, index),
          claimJob: (command) => worker.claimJob(command),
          heartbeatJob: (command) => worker.heartbeatJob(command),
          reserveUsage: (command) => worker.reserveUsage(command),
          reserveWork: (command) => worker.reserveWork(command),
          interruptJob: (command) => worker.interruptJob(command),
          reclaimJob: (command) => worker.reclaimJob(command),
          cancelJob: (command) => control.cancelJob(command),
        },
        setTime: async (value) => {
          // Genuine elapsed barriers relative to the shared fixture's schedule. Database now
          // remains authoritative and is never overridden by synthetic September timestamps.
          const target = Date.parse(value) - Date.parse("2026-09-07T12:00:00.000Z");
          const remaining = target - (performance.now() - initial);
          if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        },
      });
    });
  }
  it("creates server receipts and exact idempotent request/job/history/outbox", async () => {
    const exact = scope("create");
    const request = policyJobConformanceRequest(exact);
    const first = await control.createJob({ request, jobId: "job_native" });
    expect(first.created).toBe(true);
    expect(first.snapshot.request.definitionSha256).toBe(request.definitionSha256);
    expect(first.snapshot.request.createdAt).not.toBe(request.createdAt);
    const retry = await control.createJob({ request, jobId: "job_retry_ignored" });
    expect(retry.created).toBe(false);
    expect(retry.snapshot).toEqual(first.snapshot);
    expect(await control.findJob(exact, "job_native")).toEqual(first.snapshot);
    const head = (await control.findHistoryHead(exact, "job_native"))!;
    expect(head.sequence).toBe(0);
    expect((await control.readHistoryPage(head, 0)).entries[0]!.definition.operation.kind).toBe(
      "created",
    );
  });
  it("claims, charges once, cancels atomically and rejects stale worker activity", async () => {
    const exact = scope("work");
    await control.createJob({ request: policyJobConformanceRequest(exact), jobId: "job_native" });
    const claimed = await worker.claimJob({
      scope: exact,
      jobId: "job_native",
      workerId: "worker_native",
      attemptId: "attempt_native",
      leaseId: "lease_native",
    });
    const fence = claimed.job.currentLease!.mutationFence;
    const command = {
      scope: exact,
      fence,
      reservationId: "reservation_native",
      delta: { ...claimed.usage, reads: 1, recordBytes: 128 },
    };
    const first = await worker.reserveWork(command);
    const retry = await worker.reserveWork(command);
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.reservation).toEqual(first.reservation);
    expect(retry.snapshot.usage.reads).toBe(1);
    const cancelled = await control.cancelJob({
      scope: exact,
      jobId: "job_native",
      cancellationId: "cancel_native",
      principalId: "operator_native",
      reason: "operator_requested",
    });
    expect(cancelled.job.status).toBe("cancelled");
    expect(cancelled.attempts[0]!.closure?.status).toBe("cancelled");
    expect((await control.findHistoryHead(exact, "job_native"))!.sequence).toBe(3);
    await expect(worker.heartbeatJob({ scope: exact, fence })).rejects.toThrow();
  });
  it("preserves scope opacity and denies cross-role operations and direct table writes", async () => {
    const exact = scope("isolate");
    await control.createJob({ request: policyJobConformanceRequest(exact), jobId: "job_native" });
    expect(
      await control.findJob({ ...exact, tenantId: "tenant_outside" }, "job_native"),
    ).toBeNull();
    await expect(
      new PostgresPolicyEvaluationJobWorkerRepository(controlPool).claimJob({
        scope: exact,
        jobId: "job_native",
        workerId: "worker_native",
        attemptId: "attempt_native",
        leaseId: "lease_native",
      }),
    ).rejects.toThrow();
    await expect(
      new PostgresPolicyEvaluationJobControlRepository(workerPool).createJob({
        request: policyJobConformanceRequest(scope("forged")),
        jobId: "job_forged",
      }),
    ).rejects.toThrow();
    await expect(
      workerPool.query("UPDATE public.proofstack_policy_evaluation_jobs SET status='completed'"),
    ).rejects.toThrow();
    await expect(
      new PostgresPolicyEvaluationJobControlRepository(apiPool).findJob(exact, "job_native"),
    ).rejects.toThrow();
  });
  it("keeps tenant-wide outbox subjects distinct for the same logical job in two exact scopes", async () => {
    const firstScope = scope("outbox");
    const secondScope = { ...firstScope, environmentId: "env_native_other" };
    const first = await control.createJob({
      request: policyJobConformanceRequest(firstScope),
      jobId: "job_same_logical",
    });
    const second = await control.createJob({
      request: policyJobConformanceRequest(secondScope),
      jobId: "job_same_logical",
    });
    expect(first.snapshot.job.definitionSha256).not.toBe(second.snapshot.job.definitionSha256);
    expect(await control.findJob(firstScope, "job_same_logical")).toEqual(first.snapshot);
    expect(await control.findJob(secondScope, "job_same_logical")).toEqual(second.snapshot);
    const rows = await admin.query(
      "SELECT aggregate_id,payload FROM public.proofstack_outbox WHERE tenant_id=$1 AND event_type='policy.evaluation.job.created'",
      [firstScope.tenantId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(new Set(rows.rows.map((row) => row.aggregate_id)).size).toBe(2);
  });
  it("admits one concurrent claim, enforces heartbeat cadence and reclaims an actually expired native lease", async () => {
    const exact = scope("race");
    await control.createJob({ request: shortLeaseRequest(exact), jobId: "job_native_race" });
    const claims = await Promise.allSettled(
      [0, 1].map((index) =>
        worker.claimJob({
          scope: exact,
          jobId: "job_native_race",
          workerId: `worker_race_${index}`,
          attemptId: `attempt_race_${index}`,
          leaseId: `lease_race_${index}`,
        }),
      ),
    );
    expect(claims.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((value) => value.status === "rejected")).toHaveLength(1);
    const winner = claims.find((value) => value.status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw new Error("No claim winner");
    const fence = winner.value.job.currentLease!.mutationFence;
    await expect(worker.heartbeatJob({ scope: exact, fence })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 110));
    const heartbeat = await worker.heartbeatJob({ scope: exact, fence });
    expect(heartbeat.job.currentLease!.heartbeatAt).not.toBe(
      winner.value.job.currentLease!.heartbeatAt,
    );
    await new Promise((resolve) => setTimeout(resolve, 1010));
    await expect(
      worker.reserveWork({
        scope: exact,
        fence,
        reservationId: "reservation_expired",
        delta: { ...winner.value.usage, reads: 1 },
      }),
    ).rejects.toThrow();
    const reclaimed = await worker.reclaimJob({ scope: exact, jobId: "job_native_race" });
    expect(reclaimed.job.status).toBe("retry_ready");
    expect(reclaimed.attempts[0]!.closure).toMatchObject({
      status: "interrupted",
      reason: "lease_expired",
    });
    expect(reclaimed.usage.reads).toBe(0);
  });
  it("rejects absent required JSON fields and frozen-root edits in the database", async () => {
    const exact = scope("constraints");
    const created = (
      await control.createJob({
        request: policyJobConformanceRequest(exact),
        jobId: "job_native_constraints",
      })
    ).snapshot;
    await expect(
      admin.query(
        `INSERT INTO public.proofstack_policy_evaluation_requests SELECT tenant_id,project_id,environment_id,request_id||'_bad',definition_sha256,created_at,created_at_lexical,created_by_principal_id,jsonb_set(request,'{evaluationRequestId}',to_jsonb(request_id||'_bad'))-'createdAt' FROM public.proofstack_policy_evaluation_requests WHERE tenant_id=$1`,
        [exact.tenantId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      admin.query(
        "UPDATE public.proofstack_policy_evaluation_jobs SET deadline_at=deadline_at+interval '1 second' WHERE tenant_id=$1",
        [exact.tenantId],
      ),
    ).rejects.toThrow("immutable input");
    expect(await control.findJob(exact, created.job.jobId)).toEqual(created);
  });
  it("fails wholly while the migration runner owns its session lock", async () => {
    const exact = scope("migration_lock");
    const created = (
      await control.createJob({
        request: policyJobConformanceRequest(exact),
        jobId: "job_migration_lock",
      })
    ).snapshot;
    const migration = await admin.connect();
    try {
      await migration.query("SELECT pg_advisory_lock(1347579483,1)");
      await expect(
        worker.claimJob({
          scope: exact,
          jobId: created.job.jobId,
          workerId: "worker_test",
          attemptId: "attempt_test",
          leaseId: "lease_test",
        }),
      ).rejects.toThrow("migration guard");
    } finally {
      await migration.query("SELECT pg_advisory_unlock(1347579483,1)");
      migration.release();
    }
    expect(await control.findJob(exact, created.job.jobId)).toEqual(created);
  });
  it("repairs restored queued and active jobs at a forward store epoch and rejects the old fence", async () => {
    const exact = scope("recover");
    const queued = (
      await control.createJob({
        request: policyJobConformanceRequest(exact),
        jobId: "job_recover_queued",
      })
    ).snapshot;
    const activeScope = scope("recover_active");
    await control.createJob({
      request: policyJobConformanceRequest(activeScope),
      jobId: "job_recover_active",
    });
    const active = await worker.claimJob({
      scope: activeScope,
      jobId: "job_recover_active",
      workerId: "worker_old",
      attemptId: "attempt_old",
      leaseId: "lease_old",
    });
    const charged = await worker.reserveUsage({
      scope: activeScope,
      fence: active.job.currentLease!.mutationFence,
      delta: { ...active.usage, reads: 1, recordBytes: 128 },
    });
    const terminalScope = scope("recover_terminal");
    await control.createJob({
      request: policyJobConformanceRequest(terminalScope),
      jobId: "job_recover_terminal",
    });
    const terminal = await control.cancelJob({
      scope: terminalScope,
      jobId: "job_recover_terminal",
      cancellationId: "cancel_original",
      principalId: "operator_native",
      reason: "operator_requested",
    });
    const epochReceipt = await admin.query(
      "SELECT * FROM public.proofstack_begin_replay_recovery()",
    );
    const epoch = Number(epochReceipt.rows[0]!.next_recovery_epoch);
    await expect(
      worker.heartbeatJob({ scope: activeScope, fence: active.job.currentLease!.mutationFence }),
    ).rejects.toThrow();
    await expect(
      workerPool.query(
        "SELECT public.proofstack_recover_policy_evaluation_job('job_recover_active')",
      ),
    ).rejects.toThrow();
    const repair = new PostgresPolicyEvaluationJobRecovery(admin);
    expect((await repair.recoverAllAtCurrentEpoch()).recoveredJobs).toBeGreaterThanOrEqual(2);
    const recoveredQueued = (await control.findJob(exact, queued.job.jobId))!;
    expect(recoveredQueued.job).toMatchObject({
      status: "queued",
      recoveryEpoch: epoch,
      stateVersion: 2,
      currentLease: null,
    });
    expect(recoveredQueued.request).toEqual(queued.request);
    const recoveredActive = (await control.findJob(activeScope, active.job.jobId))!;
    expect(recoveredActive.job).toMatchObject({
      status: "retry_ready",
      recoveryEpoch: epoch,
      currentLease: null,
    });
    expect(recoveredActive.attempts[0]!.closure).toMatchObject({
      status: "interrupted",
      reason: "worker_interrupted",
    });
    expect(recoveredActive.usage).toEqual(charged.usage);
    expect(recoveredActive.request).toEqual(charged.request);
    expect(await control.findJob(terminalScope, terminal.job.jobId)).toEqual(terminal);
    const head = (await control.findHistoryHead(activeScope, active.job.jobId))!;
    expect((await control.readHistoryPage(head, 0)).entries.at(-1)!.definition.operation).toEqual({
      kind: "recovery",
      recoveryEpoch: epoch,
    });
    expect(await repair.recoverAllAtCurrentEpoch()).toEqual({ recoveredJobs: 0 });
    await expect(
      worker.heartbeatJob({ scope: activeScope, fence: active.job.currentLease!.mutationFence }),
    ).rejects.toThrow();
  });
});
