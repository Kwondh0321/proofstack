import { readFileSync } from "node:fs";
import {
  EvidenceScopeSchema,
  type EvidenceScope,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationJobHistoryEntry,
  type PolicyEvaluationSnapshot,
  type PolicyEvaluationSnapshotInputs,
} from "@proofstack/contracts";
import {
  assemblePolicyEvaluationSnapshot,
  claimPolicyEvaluationJob,
  sealPolicyEvaluationJob,
  startPolicyEvaluationComputation,
  reservePolicyEvaluationUsage,
  completePolicyEvaluationJob,
  createPolicyEvaluationJobHistoryEntry,
  replayPolicyEvaluationJobHistoryEntry,
} from "@proofstack/core";
import { MemoryPolicyEvaluationJobRepository } from "@proofstack/core/testing";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type { PolicyTransactionPool } from "./bounded-policy-transaction.js";
import { PostgresPolicyEvaluationResultRepository } from "./postgres-policy-evaluation-result-repository.js";

/** Fault-injecting transport model. Actual SQL, commit, grants and RLS have separate native tests. */
async function fixture(paidRules = 7) {
  const inputs = JSON.parse(
    readFileSync(
      new URL(
        "../../contracts/vectors/policy-evaluation-snapshot-inputs-v2.fixture.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as PolicyEvaluationSnapshotInputs;
  // Keep a live synthetic request window; the retained source vector's request is one hour old.
  inputs.request.createdAt = inputs.capturedAt;
  const pageSet = assemblePolicyEvaluationSnapshot({ snapshotId: "snapshot_adapter", inputs });
  const scope = inputs.request.scope;
  const clock = { now: () => inputs.capturedAt };
  const memory = new MemoryPolicyEvaluationJobRepository(clock);
  const queued = (await memory.createJob({ request: inputs.request, jobId: "job_adapter" }))
    .snapshot;
  let graph = queued;
  let entry = createPolicyEvaluationJobHistoryEntry({
    previous: null,
    previousEntry: null,
    next: queued,
    operation: { kind: "created" },
  });
  const transition = (
    next: PolicyEvaluationJobSnapshot,
    operation: PolicyEvaluationJobHistoryEntry["definition"]["operation"],
  ) => {
    entry = createPolicyEvaluationJobHistoryEntry({
      previous: graph,
      previousEntry: entry,
      next,
      operation,
    });
    graph = next;
  };
  const claimed = claimPolicyEvaluationJob({
    snapshot: graph,
    now: "2026-10-01T02:00:00.001Z",
    recoveryEpoch: 0,
    attemptId: "attempt_adapter",
    workerId: "worker_adapter",
    leaseId: "lease_adapter",
  });
  const fence = claimed.job.currentLease!.mutationFence;
  transition(claimed, { kind: "claim", fence });
  const reference = {
    snapshotId: pageSet.definition.snapshotId,
    definitionSha256: pageSet.definitionSha256,
  };
  const common = { fence, recoveryEpoch: 0 };
  const sealedAt = "2026-10-01T02:00:00.002Z";
  transition(
    sealPolicyEvaluationJob({
      ...common,
      snapshot: graph,
      now: sealedAt,
      sealedSnapshot: reference,
    }),
    { kind: "seal", fence, snapshot: reference },
  );
  transition(
    startPolicyEvaluationComputation({
      ...common,
      snapshot: graph,
      now: "2026-10-01T02:00:00.003Z",
    }),
    { kind: "start_computation", fence },
  );
  if (paidRules) {
    const delta = {
      reads: 0,
      records: 0,
      recordBytes: 0,
      references: 0,
      referenceBytes: 0,
      artifactReadBytes: 0,
      ruleEvaluations: paidRules,
    };
    transition(
      reservePolicyEvaluationUsage({
        ...common,
        snapshot: graph,
        now: "2026-10-01T02:00:00.004Z",
        delta,
      }),
      { kind: "reserve", fence, delta, reservationId: "reservation_adapter" },
    );
  }
  let original: unknown = {
    ...pageSet.definition,
    ...fence,
    scope,
    schemaVersion: "0.1",
    definitionSha256: pageSet.definitionSha256,
    sealedAt,
    recordedAt: sealedAt,
    sealedByPrincipalId: fence.workerId,
  } satisfies PolicyEvaluationSnapshot;
  let stored: unknown = null;
  let missing = false;
  let mutateReceipt: ((receipt: unknown) => unknown) | undefined;
  let mutateGraph:
    | ((value: PolicyEvaluationJobSnapshot) => PolicyEvaluationJobSnapshot)
    | undefined;
  const calls: string[] = [];
  let admissions = 0;
  const fakeClient = {} as PoolClient;
  class FaultTransport extends PostgresPolicyEvaluationResultRepository {
    protected override async transact<T>(
      input: EvidenceScope,
      work: (client: PoolClient, exact: EvidenceScope) => Promise<T>,
    ) {
      const previous = { graph, entry, stored };
      try {
        return await work(fakeClient, EvidenceScopeSchema.parse(input));
      } catch (error) {
        ({ graph, entry, stored } = previous);
        throw error;
      }
    }
    protected override async lastOnClient() {
      return entry;
    }
    protected override async verifyIntents() {}
    protected override async admitWorkerBudget() {
      admissions++;
    }
    protected override async append(
      ...args: Parameters<PostgresPolicyEvaluationResultRepository["append"]>
    ) {
      const [, previous, previousEntry, next, operation] = args;
      const appended = createPolicyEvaluationJobHistoryEntry({
        previous,
        previousEntry,
        next,
        operation,
      });
      if (previous) replayPolicyEvaluationJobHistoryEntry(previous, appended);
      entry = appended;
      return appended;
    }
    protected override async one(_client: PoolClient, sql: string, values: readonly unknown[]) {
      calls.push(sql);
      if (
        sql.includes("prepare_policy_evaluation_job_mutation") ||
        sql.includes("read_policy_evaluation_job")
      )
        return missing ? null : mutateGraph ? mutateGraph(structuredClone(graph)) : graph;
      if (sql.includes("read_policy_snapshot")) return original;
      if (sql.includes("read_policy_evaluation_result")) return stored;
      if (sql.includes("publish_policy_evaluation_result")) {
        if (stored) {
          const receipt = {
            created: false,
            evaluation: stored,
            job: mutateGraph ? mutateGraph(structuredClone(graph)) : graph,
          };
          return mutateReceipt ? mutateReceipt(receipt) : receipt;
        }
        const definition = JSON.parse(String(values[1])).definition;
        const recordedAt = "2026-10-01T02:00:00.005678Z";
        stored = {
          ...definition,
          scope,
          schemaVersion: "0.1",
          ...fence,
          definitionSha256: values[2],
          recordedAt,
          recordedByPrincipalId: fence.workerId,
        };
        graph = completePolicyEvaluationJob({
          ...common,
          snapshot: graph,
          now: recordedAt,
          result: { evaluationId: definition.evaluationId, definitionSha256: String(values[2]) },
          ruleCount: definition.ruleCount,
        });
        const receipt = { created: true, evaluation: stored, job: graph };
        return mutateReceipt ? mutateReceipt(receipt) : receipt;
      }
      throw new Error("Unexpected test transport query");
    }
  }
  const repository = new FaultTransport({} as PolicyTransactionPool);
  return {
    repository,
    scope,
    pageSet,
    command: { scope, fence, evaluationId: "evaluation_adapter", pageSet },
    calls,
    graph: () => graph,
    entry: () => entry,
    admissions: () => admissions,
    setOriginal: (value: unknown) => {
      original = value;
    },
    setStored: (value: unknown) => {
      stored = value;
    },
    setGraph: (value: PolicyEvaluationJobSnapshot) => {
      graph = value;
    },
    setMissing: () => {
      missing = true;
    },
    receipt: (change: (receipt: unknown) => unknown) => {
      mutateReceipt = change;
    },
    graphReceipt: (change: (value: PolicyEvaluationJobSnapshot) => PolicyEvaluationJobSnapshot) => {
      mutateGraph = change;
    },
  };
}

describe("policy result adapter response integrity", () => {
  it("derives the result from original sealed pages, closes one attempt and preserves exact retry receipts", async () => {
    const f = await fixture();
    const first = await f.repository.publishResult(f.command);
    expect(first.created).toBe(true);
    expect(first.snapshot.job.status).toBe("completed");
    expect(f.entry().definition.operation.kind).toBe("complete");
    expect(await f.repository.findResult(f.scope, f.command.fence.jobId, f.pageSet)).toEqual(
      first.evaluation,
    );
    expect(await f.repository.publishResult(f.command)).toEqual({ ...first, created: false });
    expect(f.admissions()).toBe(1);
  });
  it.each([0, 6])(
    "rejects only %s prepaid rules before the fixed publication call",
    async (paid) => {
      const f = await fixture(paid);
      await expect(f.repository.publishResult(f.command)).rejects.toThrow(
        "prepaid whole rule work",
      );
      expect(f.calls.some((sql) => sql.includes("publish_policy_evaluation_result"))).toBe(false);
    },
  );
  it.each([
    null,
    [],
    false,
    { created: "true", evaluation: {}, job: {} },
    { created: true, evaluation: {}, job: {}, extra: true },
  ])("rejects malformed publication receipt %j", async (value) => {
    const f = await fixture();
    f.receipt(() => value);
    await expect(f.repository.publishResult(f.command)).rejects.toThrow(
      "Invalid policy result publication receipt",
    );
    expect(f.graph().job.status).toBe("running");
  });
  it("rejects a changed native graph before appending completion history", async () => {
    const f = await fixture();
    const before = f.entry();
    f.receipt((value) => {
      const copy = structuredClone(value) as { job: PolicyEvaluationJobSnapshot };
      copy.job.job.updatedAt = "2026-10-01T02:00:00.005679Z";
      return copy;
    });
    await expect(f.repository.publishResult(f.command)).rejects.toThrow(
      "differs from owning transition",
    );
    expect(f.entry()).toEqual(before);
  });
  it("rejects a retry response which changes the original graph", async () => {
    const f = await fixture();
    await f.repository.publishResult(f.command);
    f.receipt((value) => {
      const copy = structuredClone(value) as { job: PolicyEvaluationJobSnapshot };
      copy.job.job.updatedAt = "2026-10-01T02:00:00.005679Z";
      return copy;
    });
    await expect(f.repository.publishResult(f.command)).rejects.toThrow(
      "retry changed original graph",
    );
  });
  it("rejects a substituted native result receipt and missing original seal", async () => {
    const f = await fixture();
    f.receipt((value) => {
      const copy = structuredClone(value) as { evaluation: { recordedByPrincipalId: string } };
      copy.evaluation.recordedByPrincipalId = "worker_substituted";
      return copy;
    });
    await expect(f.repository.publishResult(f.command)).rejects.toThrow();
    f.setOriginal(null);
    await expect(f.repository.publishResult(f.command)).rejects.toThrow();
  });
  it("rejects missing and altered completed result records on authoritative reads", async () => {
    const f = await fixture();
    const original = await f.repository.publishResult(f.command);
    f.setStored(null);
    await expect(
      f.repository.findResult(f.scope, f.command.fence.jobId, f.pageSet),
    ).rejects.toThrow();
    f.setStored({ ...original.evaluation, recordedAt: "2026-10-01T02:00:00.005679Z" });
    await expect(
      f.repository.findResult(f.scope, f.command.fence.jobId, f.pageSet),
    ).rejects.toThrow();
  });
  it("returns null for an absent job and for an uncompleted job", async () => {
    const f = await fixture();
    expect(await f.repository.findResult(f.scope, f.command.fence.jobId, f.pageSet)).toBeNull();
    f.setMissing();
    expect(await f.repository.findResult(f.scope, f.command.fence.jobId, f.pageSet)).toBeNull();
  });
  it("rejects a completed graph with a substituted original attempt closure receipt", async () => {
    const f = await fixture();
    await f.repository.publishResult(f.command);
    f.graphReceipt((value) => {
      const attempt = value.attempts.at(-1);
      if (!attempt?.closure) throw new Error("Missing closed deciding attempt");
      attempt.closure.committedAt = "2026-10-01T02:00:00.005677Z";
      return value;
    });
    await expect(
      f.repository.findResult(f.scope, f.command.fence.jobId, f.pageSet),
    ).rejects.toThrow("deciding closed attempt");
  });
  it("rejects substituted pages before performing the publication query", async () => {
    const f = await fixture();
    const pageSet = structuredClone(f.pageSet);
    pageSet.pages.pop();
    await expect(f.repository.publishResult({ ...f.command, pageSet })).rejects.toThrow();
    expect(f.calls.some((sql) => sql.includes("publish_policy_evaluation_result"))).toBe(false);
  });
});
