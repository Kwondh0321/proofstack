import { describe, expect, it } from "vitest";
import {
  serializeEvaluationCanonicalJson,
  POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE,
} from "@proofstack/contracts";
import { MemoryPolicyEvaluationJobRepository } from "./memory-policy-evaluation-job-repository.js";
import { policyJobConformanceRequest } from "./policy-evaluation-job-repository-conformance.js";
import {
  digestPolicyEvaluationJobGraph,
  validatePolicyEvaluationJobHistoryPage,
} from "../policy/policy-evaluation-job-history.js";
import { encodePolicyEvaluationJobHistoryEntry } from "@proofstack/contracts";
import { createHash } from "node:crypto";
import { MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES } from "@proofstack/contracts";
import { createPolicyEvaluationJobHistoryEntry } from "../policy/policy-evaluation-job-history.js";
import { digestPolicyEvaluationRequestDefinition } from "../policy/policy-evaluation-request-record-validation.js";

async function harness() {
  let now = "2026-09-07T12:00:00.123456Z";
  const repository = new MemoryPolicyEvaluationJobRepository({ now: () => now });
  const request = policyJobConformanceRequest();
  const scope = request.scope;
  const jobId = "job_history";
  const created = await repository.createJob({ request, jobId });
  return {
    repository,
    scope,
    jobId,
    created,
    setTime: (value: string) => {
      now = value;
    },
  };
}
describe("atomic memory policy graph/history/outbox", () => {
  it("uses the last history slot for terminal state and outbox without executing another reservation", async () => {
    const h = await harness();
    const claimed = await h.repository.claimJob({
      scope: h.scope,
      jobId: h.jobId,
      workerId: "worker_history",
      attemptId: "attempt_history",
      leaseId: "lease_history",
    });
    const records = Reflect.get(h.repository, "records") as Map<
      string,
      {
        snapshot: typeof claimed;
        latest: import("@proofstack/contracts").PolicyEvaluationJobHistoryEntry;
        pages: Record<number, import("@proofstack/contracts").PolicyEvaluationJobHistoryEntry[]>;
      }
    >;
    const stored = records.values().next().value!;
    // Seed a complete final page at the fixed boundary; this is synthetic state, not a claim
    // that this unit test ran a hundred thousand real worker/I/O actions.
    let previous = structuredClone(claimed);
    previous.job.stateVersion =
      MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES - POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE;
    previous.usage.artifactReadBytes = previous.job.stateVersion - 2;
    let tail = structuredClone(stored.latest);
    tail.definition.sequence = previous.job.stateVersion - 1;
    tail.definition.stateVersion = previous.job.stateVersion;
    tail.definition.graphSha256 = digestPolicyEvaluationJobGraph(previous);
    tail.entrySha256 = createHash("sha256")
      .update(encodePolicyEvaluationJobHistoryEntry(tail.definition))
      .digest("hex");
    const entries: (typeof tail)[] = [];
    for (let index = 0; index < POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE - 1; index++) {
      const next = structuredClone(previous);
      next.job.stateVersion++;
      next.usage.artifactReadBytes++;
      tail = createPolicyEvaluationJobHistoryEntry({
        previous,
        previousEntry: tail,
        next,
        operation: {
          kind: "reserve",
          fence: claimed.job.currentLease!.mutationFence,
          reservationId: `reservation_boundary_${index}`,
          delta: { ...claimed.usage, artifactReadBytes: 1 },
        },
      });
      entries.push(tail);
      previous = next;
    }
    Reflect.set(stored, "snapshot", previous);
    Reflect.set(stored, "latest", tail);
    Reflect.set(stored, "pages", { ...stored.pages, [999]: entries });
    const result = await h.repository.reserveWork({
      scope: h.scope,
      fence: claimed.job.currentLease!.mutationFence,
      reservationId: "reservation_will_not_start",
      delta: { ...claimed.usage, artifactReadBytes: 1 },
    });
    expect(result.created).toBe(false);
    expect(result.reservation).toBeNull();
    expect(result.snapshot.job.status).toBe("budget_exhausted");
    expect(result.snapshot.usage).toEqual(previous.usage);
    expect(result.snapshot.attempts).toHaveLength(1);
    const head = (await h.repository.findHistoryHead(h.scope, h.jobId))!;
    expect(head.sequence).toBe(MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES - 1);
    const finalPage = await h.repository.readHistoryPage(head, 999);
    expect(finalPage.entries.at(-1)!.definition.operation.kind).toBe("history_limit");
    expect(
      (await h.repository.findOutboxIntents(h.scope, h.jobId))!.at(-1)!.payload["status"],
    ).toBe("budget_exhausted");
  });
  it("keeps equal reservation IDs independent across exact jobs", async () => {
    const h = await harness();
    const request = policyJobConformanceRequest();
    request.evaluationRequestId = "request_other_job";
    const {
      createdAt: _at,
      createdByPrincipalId: _by,
      definitionSha256: _sha,
      scope: _scope,
      schemaVersion: _version,
      ...definition
    } = request;
    request.definitionSha256 = digestPolicyEvaluationRequestDefinition(h.scope, definition);
    await h.repository.createJob({ request, jobId: "job_other" });
    for (const jobId of [h.jobId, "job_other"]) {
      const claimed = await h.repository.claimJob({
        scope: h.scope,
        jobId,
        workerId: "worker_history",
        attemptId: "attempt_history",
        leaseId: "lease_history",
      });
      const result = await h.repository.reserveWork({
        scope: h.scope,
        fence: claimed.job.currentLease!.mutationFence,
        reservationId: "reservation_same",
        delta: { ...claimed.usage, reads: 1 },
      });
      expect(result.created).toBe(true);
      expect(result.snapshot.usage.reads).toBe(1);
    }
  });
  it.each(["scope", "tail"])(
    "rejects substituted stored history %s before returning job state",
    async (kind) => {
      const h = await harness();
      const records = Reflect.get(h.repository, "records") as Map<
        string,
        {
          latest: import("@proofstack/contracts").PolicyEvaluationJobHistoryEntry;
          pages: Record<number, unknown[]>;
        }
      >;
      const stored = records.values().next().value!;
      if (kind === "scope") {
        const latest = structuredClone(stored.latest);
        latest.definition.scope.tenantId = "tenant_other";
        latest.entrySha256 = createHash("sha256")
          .update(encodePolicyEvaluationJobHistoryEntry(latest.definition))
          .digest("hex");
        Reflect.set(stored, "latest", latest);
      } else Reflect.set(stored, "pages", {});
      await expect(h.repository.findJob(h.scope, h.jobId)).rejects.toThrow("Stored history head");
    },
  );
  it("concurrent identical reservations charge once and identify a single new work occurrence", async () => {
    const h = await harness();
    const claimed = await h.repository.claimJob({
      scope: h.scope,
      jobId: h.jobId,
      workerId: "worker_history",
      attemptId: "attempt_history",
      leaseId: "lease_history",
    });
    const command = {
      scope: h.scope,
      fence: claimed.job.currentLease!.mutationFence,
      reservationId: "reservation_retried",
      delta: { ...claimed.usage, reads: 1, records: 1, artifactReadBytes: 10 },
    };
    const results = await Promise.all([
      h.repository.reserveWork(command),
      h.repository.reserveWork(command),
    ]);
    expect(results.map((result) => result.created)).toEqual([true, false]);
    expect(results[1]!.reservation).toEqual(results[0]!.reservation);
    expect(results[1]!.snapshot.usage).toEqual(command.delta);
    expect((await h.repository.findHistoryHead(h.scope, h.jobId))!.sequence).toBe(2);
    const another = await h.repository.reserveWork({
      ...command,
      reservationId: "reservation_actual_repeat",
    });
    expect(another.created).toBe(true);
    expect(another.snapshot.usage.reads).toBe(2);
    expect(another.snapshot.usage.artifactReadBytes).toBe(20);
  });
  it("changed reservation work conflicts wholly and old receipts cannot revive an expired fence", async () => {
    const h = await harness();
    const claimed = await h.repository.claimJob({
      scope: h.scope,
      jobId: h.jobId,
      workerId: "worker_history",
      attemptId: "attempt_history",
      leaseId: "lease_history",
    });
    const command = {
      scope: h.scope,
      fence: claimed.job.currentLease!.mutationFence,
      reservationId: "reservation_retried",
      delta: { ...claimed.usage, reads: 1 },
    };
    const first = await h.repository.reserveWork(command);
    const head = await h.repository.findHistoryHead(h.scope, h.jobId);
    await expect(
      h.repository.reserveWork({ ...command, delta: { ...command.delta, records: 1 } }),
    ).rejects.toThrow();
    expect(await h.repository.findHistoryHead(h.scope, h.jobId)).toEqual(head);
    expect(await h.repository.findJob(h.scope, h.jobId)).toEqual(first.snapshot);
    h.setTime(claimed.job.currentLease!.expiresAt);
    await expect(h.repository.reserveWork(command)).rejects.toThrow();
    expect(await h.repository.findHistoryHead(h.scope, h.jobId)).toEqual(head);
  });
  it("creates a detached history head and one canonical creation intent", async () => {
    const h = await harness();
    const head = await h.repository.findHistoryHead(h.scope, h.jobId);
    expect(head!.sequence).toBe(0);
    expect(head!.graphSha256).toBe(digestPolicyEvaluationJobGraph(h.created.snapshot));
    const page = await h.repository.readHistoryPage(head!, 0);
    expect(page.entries[0]!.definition.operation).toEqual({ kind: "created" });
    page.entries[0]!.definition.graphSha256 = "0".repeat(64);
    expect((await h.repository.readHistoryPage(head!, 0)).entries[0]!.definition.graphSha256).toBe(
      head!.graphSha256,
    );
    const intents = await h.repository.findOutboxIntents(h.scope, h.jobId);
    expect(intents).toHaveLength(1);
    expect(intents![0]!.eventType).toBe("policy.evaluation.job.created");
    expect(intents![0]!.createdAt).toBe(h.created.snapshot.job.createdAt);
    expect(
      await h.repository.findHistoryHead({ ...h.scope, tenantId: "tenant_other" }, h.jobId),
    ).toBeNull();
  });
  it("retains old exact heads after fixed-page growth and rejects head/row substitutions", async () => {
    const h = await harness();
    const firstHead = (await h.repository.findHistoryHead(h.scope, h.jobId))!;
    h.setTime("2026-09-07T12:00:01.123456Z");
    const claimed = await h.repository.claimJob({
      scope: h.scope,
      jobId: h.jobId,
      workerId: "worker_history",
      attemptId: "attempt_history",
      leaseId: "lease_history",
    });
    const fence = claimed.job.currentLease!.mutationFence;
    for (let index = 0; index < POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE; index++)
      await h.repository.reserveUsage({
        scope: h.scope,
        fence,
        delta: { ...claimed.usage, reads: 1 },
      });
    const head = (await h.repository.findHistoryHead(h.scope, h.jobId))!;
    expect(head.sequence).toBe(101);
    const first = await h.repository.readHistoryPage(head, 0);
    const last = await h.repository.readHistoryPage(head, 1);
    expect(first.entries).toHaveLength(100);
    expect(last.entries).toHaveLength(2);
    expect(last.entries[0]!.definition.predecessorEntrySha256).toBe(
      first.entries.at(-1)!.entrySha256,
    );
    expect(last.entries.at(-1)!.entrySha256).toBe(head.entrySha256);
    expect((await h.repository.readHistoryPage(firstHead, 0)).entries).toHaveLength(1);
    expect(validatePolicyEvaluationJobHistoryPage({ expected: head, page: first })).toEqual(first);
    const changed = structuredClone(first);
    changed.entries[1]!.entrySha256 = "0".repeat(64);
    expect(() =>
      validatePolicyEvaluationJobHistoryPage({ expected: head, page: changed }),
    ).toThrow();
    await expect(
      h.repository.readHistoryPage({ ...head, graphSha256: "0".repeat(64) }, 0),
    ).rejects.toThrow();
    await expect(h.repository.readHistoryPage(head, 2)).rejects.toThrow();
  });
  it("whole rejected reservation changes no graph, history head or canonical intent", async () => {
    const h = await harness();
    const claimed = await h.repository.claimJob({
      scope: h.scope,
      jobId: h.jobId,
      workerId: "worker_history",
      attemptId: "attempt_history",
      leaseId: "lease_history",
    });
    const before = {
      graph: await h.repository.findJob(h.scope, h.jobId),
      head: await h.repository.findHistoryHead(h.scope, h.jobId),
      outbox: await h.repository.findOutboxIntents(h.scope, h.jobId),
    };
    await expect(
      h.repository.reserveUsage({
        scope: h.scope,
        fence: claimed.job.currentLease!.mutationFence,
        delta: { ...claimed.usage, records: claimed.request.limits.maxAcquisitionRecords + 1 },
      }),
    ).rejects.toThrow();
    expect({
      graph: await h.repository.findJob(h.scope, h.jobId),
      head: await h.repository.findHistoryHead(h.scope, h.jobId),
      outbox: await h.repository.findOutboxIntents(h.scope, h.jobId),
    }).toEqual(before);
  });
  it("concurrent cancellation commits one transition, original intent and terminal outbox", async () => {
    const h = await harness();
    const base = {
      scope: h.scope,
      jobId: h.jobId,
      principalId: "operator_history",
      reason: "operator_requested" as const,
    };
    const snapshots = await Promise.all([
      h.repository.cancelJob({ ...base, cancellationId: "cancel_first" }),
      h.repository.cancelJob({ ...base, cancellationId: "cancel_second" }),
    ]);
    expect(snapshots[1]).toEqual(snapshots[0]);
    const head = (await h.repository.findHistoryHead(h.scope, h.jobId))!;
    expect(head.sequence).toBe(1);
    const page = await h.repository.readHistoryPage(head, 0);
    expect(page.entries[1]!.definition.operation.kind).toBe("cancel");
    const intents = await h.repository.findOutboxIntents(h.scope, h.jobId);
    expect(intents!.map((entry) => entry.eventType)).toEqual([
      "policy.evaluation.job.created",
      "policy.evaluation.job.cancellation-requested",
      "policy.evaluation.job.terminal",
    ]);
    expect(intents![1]!.payload["cancellationId"]).toBe("cancel_first");
    expect(intents![2]!.payload["status"]).toBe("cancelled");
    expect(serializeEvaluationCanonicalJson(intents)).not.toContain("plaintext");
  });
  it("rejects missing canonical intent on authoritative reads and request retry", async () => {
    const h = await harness();
    const records = Reflect.get(h.repository, "records") as Map<string, object>;
    const record = records.values().next().value!;
    Reflect.set(record, "outbox", []);
    await expect(h.repository.findJob(h.scope, h.jobId)).rejects.toThrow("canonical atomic outbox");
    await expect(
      h.repository.createJob({ request: h.created.snapshot.request, jobId: "job_retry" }),
    ).rejects.toThrow("canonical atomic outbox");
  });
});
