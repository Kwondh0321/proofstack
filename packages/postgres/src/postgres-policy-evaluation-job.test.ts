import { readFileSync } from "node:fs";
import type {
  PolicyEvaluationJobHistoryEntry,
  PolicyEvaluationJobSnapshot,
} from "@proofstack/contracts";
import {
  cancelPolicyEvaluationJob,
  claimPolicyEvaluationJob,
  heartbeatPolicyEvaluationJob,
  interruptPolicyEvaluationJob,
  policyEvaluationJobHistoryHead,
  reclaimPolicyEvaluationJob,
  recoverPolicyEvaluationJob,
  reservePolicyEvaluationUsage,
} from "@proofstack/core";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadBundledMigrations } from "./migrations.js";
import { PostgresPolicyEvaluationJobControlRepository } from "./postgres-policy-evaluation-job-control-repository.js";
import { PostgresPolicyEvaluationJobRecovery } from "./postgres-policy-evaluation-job-recovery.js";
import { PostgresPolicyEvaluationJobWorkerRepository } from "./postgres-policy-evaluation-job-worker-repository.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("../../contracts/vectors/policy-evaluation-job-history-v1.json", import.meta.url),
    "utf8",
  ),
).vectors as { snapshot: PolicyEvaluationJobSnapshot; entry: PolicyEvaluationJobHistoryEntry }[];
const ledger = (await loadBundledMigrations()).map(({ id, checksum }) => ({ id, checksum }));
const scope = vectors[0]!.snapshot.job.scope;
const jobId = vectors[0]!.snapshot.job.jobId;
const cut = "2026-09-07T12:00:07.123456Z";
type Rows = { rows: Record<string, unknown>[] };
function fixture(index = 0) {
  let graph = structuredClone(vectors[index]!.snapshot);
  const entries = vectors.slice(0, index + 1).map((value) => structuredClone(value.entry));
  const release = vi.fn();
  const calls: { text: string; values?: readonly unknown[] }[] = [];
  let now = cut;
  let creating = false;
  let missing = false;
  let recoveryEpoch = 1;
  let reservation: PolicyEvaluationJobHistoryEntry | null = null;
  let override: ((text: string, values?: readonly unknown[]) => Rows | undefined) | undefined;
  const query = vi.fn(async (text: string, values?: readonly unknown[]): Promise<Rows> => {
    calls.push({ text, ...(values ? { values } : {}) });
    const replaced = override?.(text, values);
    if (replaced) return replaced;
    if (text.includes("pg_try_advisory_xact_lock_shared(1347579483"))
      return { rows: [{ acquired: true }] };
    if (text.includes("to_regclass")) return { rows: [{ ledger: "proofstack_schema_migrations" }] };
    if (text.startsWith("SELECT id, checksum")) return { rows: ledger };
    if (text.includes("SELECT tenant_id,project_id"))
      return {
        rows: [
          {
            tenant_id: scope.tenantId,
            project_id: scope.projectId,
            environment_id: scope.environmentId,
            job_id: jobId,
          },
        ],
      };
    if (text.includes("create_policy_evaluation_job"))
      return { rows: [{ created: creating, snapshot: graph }] };
    if (
      text.includes("prepare_policy_evaluation_job_mutation") ||
      text.includes("read_policy_evaluation_job")
    )
      return { rows: [{ value: missing ? null : graph }] };
    if (text.includes("read_policy_evaluation_history_head"))
      return {
        rows: [{ value: missing ? null : policyEvaluationJobHistoryHead(entries.at(-1)!) }],
      };
    if (text.includes("read_policy_evaluation_history_page"))
      return {
        rows: [
          {
            value: {
              head: policyEvaluationJobHistoryHead(entries.at(-1)!),
              pageIndex: 0,
              entries,
            },
          },
        ],
      };
    if (text.includes("policy_evaluation_intent_status")) return { rows: [{ value: "canonical" }] };
    if (text.includes("append_policy_evaluation_job_history")) {
      entries.push(JSON.parse(String(values?.[0])));
      return { rows: [] };
    }
    const common = { snapshot: graph, now, recoveryEpoch: graph.job.recoveryEpoch };
    if (text.includes("public.proofstack_claim_policy_evaluation_job"))
      graph = claimPolicyEvaluationJob({
        ...common,
        workerId: String(values?.[1]),
        attemptId: String(values?.[2]),
        leaseId: String(values?.[3]),
      });
    else if (text.includes("heartbeat_policy_evaluation_job"))
      graph = heartbeatPolicyEvaluationJob({ ...common, fence: JSON.parse(String(values?.[0])) });
    else if (text.includes("interrupt_policy_evaluation_job"))
      graph = interruptPolicyEvaluationJob({
        ...common,
        fence: JSON.parse(String(values?.[0])),
        reason: values?.[1] as "worker_interrupted",
      });
    else if (text.includes("reclaim_policy_evaluation_job"))
      graph = reclaimPolicyEvaluationJob(common);
    else if (text.includes("recover_policy_evaluation_job")) {
      if (graph.job.recoveryEpoch < recoveryEpoch)
        graph = recoverPolicyEvaluationJob({ snapshot: graph, now, recoveryEpoch });
    } else if (text.includes("cancel_policy_evaluation_job"))
      graph = cancelPolicyEvaluationJob({
        snapshot: graph,
        intent: {
          scope,
          jobId,
          cancellationId: String(values?.[1]),
          requestedByPrincipalId: String(values?.[2]),
          reason: values?.[3] as "operator_requested",
          requestedAt: now,
        },
      });
    else if (text.includes("reserve_policy_evaluation_work")) {
      if (reservation) return { rows: [{ created: false, snapshot: graph, reservation }] };
      graph = reservePolicyEvaluationUsage({
        ...common,
        fence: JSON.parse(String(values?.[0])),
        delta: JSON.parse(String(values?.[2])),
      });
      return { rows: [{ created: true, snapshot: graph, reservation: null }] };
    } else return { rows: [] };
    return { rows: [{ value: graph }] };
  });
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pick<
    Pool,
    "connect"
  >;
  return {
    pool,
    calls,
    release,
    query,
    entries,
    control: new PostgresPolicyEvaluationJobControlRepository(pool),
    worker: new PostgresPolicyEvaluationJobWorkerRepository(pool),
    recovery: new PostgresPolicyEvaluationJobRecovery(pool),
    graph: () => graph,
    setGraph: (value: PolicyEvaluationJobSnapshot) => {
      graph = value;
    },
    setNow: (value: string) => {
      now = value;
    },
    setMissing: () => {
      missing = true;
    },
    setCreating: () => {
      creating = true;
      entries.length = 0;
    },
    setReservation: (value: PolicyEvaluationJobHistoryEntry) => {
      reservation = value;
    },
    override: (value: NonNullable<typeof override>) => {
      override = value;
    },
    setRecoveryEpoch: (value: number) => {
      recoveryEpoch = value;
    },
  };
}
describe("native policy job adapter contracts, exact reads and whole transaction cleanup", () => {
  it("reads independent canonical vectors and exact history with explicit scoped READ COMMITTED", async () => {
    const f = fixture(2);
    expect(await f.control.findJob(scope, jobId)).toEqual(vectors[2]!.snapshot);
    const head = (await f.control.findHistoryHead(scope, jobId))!;
    expect((await f.control.readHistoryPage(head, 0)).entries).toEqual(f.entries);
    expect(f.calls[0]!.text).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(
      f.calls
        .filter((value) => value.text.includes("set_config"))
        .map((value) => value.values?.[0]),
    ).toContain(scope.tenantId);
    expect(f.release).toHaveBeenCalledTimes(3);
  });
  it("preserves absent reads without synthesizing a job or history", async () => {
    const f = fixture();
    f.setMissing();
    expect(await f.control.findJob(scope, jobId)).toBeNull();
    expect(await f.control.findHistoryHead(scope, jobId)).toBeNull();
  });
  it.each([false, true])("creates/retries server receipts (created=%s)", async (created) => {
    const f = fixture();
    if (created) f.setCreating();
    expect((await f.control.createJob({ request: f.graph().request, jobId })).created).toBe(
      created,
    );
    expect(
      f.calls.some((value) => value.text.includes("append_policy_evaluation_job_history")),
    ).toBe(created);
  });
  it("validates and appends claim, heartbeat, reservation, interruption and reclaim receipts", async () => {
    const f = fixture();
    const claimed = await f.worker.claimJob({
      scope,
      jobId,
      workerId: "worker_test",
      attemptId: "attempt_test",
      leaseId: "lease_test",
    });
    const fence = claimed.job.currentLease!.mutationFence;
    f.setNow("2026-09-07T12:00:12.123456Z");
    await f.worker.heartbeatJob({ scope, fence });
    const delta = { ...f.graph().usage, reads: 1 };
    const reserved = await f.worker.reserveWork({
      scope,
      fence,
      reservationId: "reservation_test",
      delta,
    });
    f.setReservation(reserved.reservation!);
    expect(
      (await f.worker.reserveWork({ scope, fence, reservationId: "reservation_test", delta }))
        .created,
    ).toBe(false);
    await f.worker.interruptJob({ scope, fence, reason: "worker_interrupted" });
    await expect(f.worker.reclaimJob({ scope, jobId })).rejects.toThrow("state_conflict");
    expect(f.entries.map((value) => value.definition.operation.kind)).toEqual([
      "created",
      "claim",
      "heartbeat",
      "reserve",
      "interrupt",
    ]);
  });
  it("gives each physical reserveUsage call a fresh server nonce", async () => {
    const f = fixture(1);
    const fence = f.graph().job.currentLease!.mutationFence;
    await f.worker.reserveUsage({ scope, fence, delta: { ...f.graph().usage, reads: 1 } });
    await f.worker.reserveUsage({
      scope,
      fence,
      delta: { ...vectors[0]!.snapshot.usage, reads: 1 },
    });
    const rows = f.calls.filter((value) => value.text.includes("reserve_policy_evaluation_work"));
    expect(rows[0]!.values?.[1]).not.toBe(rows[1]!.values?.[1]);
    expect(f.graph().usage.reads).toBe(2);
  });
  it("reclaims expired active work and preserves an unchanged terminal read", async () => {
    const f = fixture(1);
    f.setNow(f.graph().job.currentLease!.expiresAt);
    expect((await f.worker.reclaimJob({ scope, jobId })).job.status).toBe("retry_ready");
    const terminal = await f.control.cancelJob({
      scope,
      jobId,
      cancellationId: "cancel_test",
      principalId: "principal_test",
      reason: "operator_requested",
    });
    expect(await f.worker.reclaimJob({ scope, jobId })).toEqual(terminal);
  });
  it("retains one cancellation and avoids an extra history event on terminal retry", async () => {
    const f = fixture();
    const command = {
      scope,
      jobId,
      cancellationId: "cancel_test",
      principalId: "principal_test",
      reason: "operator_requested" as const,
    };
    const first = await f.control.cancelJob(command);
    f.override((text) =>
      text.includes("cancel_policy_evaluation_job") ? { rows: [{ value: first }] } : undefined,
    );
    expect(await f.control.cancelJob(command)).toEqual(first);
    expect(f.entries).toHaveLength(2);
  });
  it("repairs one/all jobs with a checked migration ledger and appends the exact epoch history", async () => {
    const f = fixture(2);
    expect((await f.recovery.recoverJob(scope, jobId)).job.recoveryEpoch).toBe(1);
    expect(await f.recovery.recoverJob(scope, jobId)).toEqual(f.graph());
    f.setRecoveryEpoch(2);
    expect(await f.recovery.recoverAllAtCurrentEpoch()).toEqual({ recoveredJobs: 1 });
    expect(await f.recovery.recoverAllAtCurrentEpoch()).toEqual({ recoveredJobs: 0 });
    expect(f.entries.at(-1)!.definition.operation).toEqual({ kind: "recovery", recoveryEpoch: 2 });
    expect(f.calls.some((value) => value.text.startsWith("SELECT snapshot FROM"))).toBe(false);
  });
  it.each(["P0002", "23505", "40001", "55000", "22003", "unknown"])(
    "rolls back and preserves/maps native failure %s",
    async (code) => {
      const f = fixture();
      f.override((text) => {
        if (text.includes("read_policy_evaluation_job"))
          throw Object.assign(new Error("native failure"), { code });
        return undefined;
      });
      await expect(f.control.findJob(scope, jobId)).rejects.toThrow();
      expect(f.calls.at(-1)!.text).toBe("ROLLBACK");
      expect(f.release).toHaveBeenCalledExactlyOnceWith();
    },
  );
  it.each(["row_count", "missing_intent", "substituted_head", "missing_head", "wrong_graph"])(
    "rejects %s and never commits",
    async (kind) => {
      const f = fixture();
      f.override((text) => {
        if (kind === "row_count" && text.includes("read_policy_evaluation_job"))
          return { rows: [] };
        if (kind === "missing_intent" && text.includes("intent_status"))
          return { rows: [{ value: "absent" }] };
        if (
          (kind === "substituted_head" || kind === "missing_head") &&
          text.includes("read_policy_evaluation_history_head")
        )
          return {
            rows: [
              {
                value:
                  kind === "missing_head"
                    ? null
                    : {
                        ...policyEvaluationJobHistoryHead(f.entries[0]!),
                        scope: { ...scope, tenantId: "tenant_other" },
                      },
              },
            ],
          };
        if (kind === "wrong_graph" && text.includes("read_policy_evaluation_job"))
          return {
            rows: [
              { value: { ...f.graph(), job: { ...f.graph().job, jobId: "job_substituted" } } },
            ],
          };
        return undefined;
      });
      await expect(f.control.findJob(scope, jobId)).rejects.toThrow();
      expect(f.calls.at(-1)!.text).toBe("ROLLBACK");
    },
  );
  it("rejects a correctly hashed reservation belonging to another original occurrence", async () => {
    const f = fixture(2);
    f.setReservation(f.entries.at(-1)!);
    const original = f.entries.at(-1)!.definition.operation;
    if (original.kind !== "reserve") throw new Error("Independent reservation vector missing");
    await expect(
      f.worker.reserveWork({
        scope,
        fence: original.fence,
        reservationId: "reservation_other",
        delta: original.delta,
      }),
    ).rejects.toThrow("original occurrence");
  });
  it.each([false, true])(
    "destroys the recovery connection exactly once after rollback failure (bulk=%s)",
    async (bulk) => {
      const f = fixture();
      const original = new Error("primary failure"),
        rollback = new Error("rollback failure");
      f.override((text) => {
        if (text === "ROLLBACK") throw rollback;
        if (text.startsWith("SELECT id, checksum")) throw original;
        return undefined;
      });
      const operation = bulk
        ? f.recovery.recoverAllAtCurrentEpoch()
        : f.recovery.recoverJob(scope, jobId);
      await expect(operation).rejects.toMatchObject({
        name: "PostgresTransactionCleanupError",
        cause: original,
        rollbackError: rollback,
      });
      expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    },
  );
  it("refuses bulk recovery before reading oversized restored graphs", async () => {
    const f = fixture();
    f.override((text) =>
      text.startsWith("SELECT tenant_id,project_id")
        ? { rows: Array.from({ length: 100001 }, () => ({})) }
        : undefined,
    );
    await expect(f.recovery.recoverAllAtCurrentEpoch()).rejects.toThrow("job count");
    expect(f.calls.some((value) => value.text.includes("read_policy_evaluation_job"))).toBe(false);
    expect(f.release).toHaveBeenCalledExactlyOnceWith();
  });
  it("destroys an uncertain connection when BEGIN fails without issuing rollback", async () => {
    const f = fixture();
    const failure = new Error("begin failure");
    f.override((text) => {
      if (text.startsWith("BEGIN")) throw failure;
      return undefined;
    });
    await expect(f.recovery.recoverAllAtCurrentEpoch()).rejects.toBe(failure);
    expect(f.calls.some((value) => value.text === "ROLLBACK")).toBe(false);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it.each([false, "true", null])(
    "rejects a missing or non-boolean migration guard %s before reading jobs",
    async (acquired) => {
      const f = fixture();
      f.override((text) =>
        text.includes("pg_try_advisory_xact_lock_shared(1347579483")
          ? { rows: [{ acquired }] }
          : undefined,
      );
      await expect(f.control.findJob(scope, jobId)).rejects.toThrow("migration guard");
      expect(f.calls.some((value) => value.text.includes("read_policy_evaluation_job"))).toBe(
        false,
      );
      expect(f.calls.at(-1)!.text).toBe("ROLLBACK");
    },
  );
});
