import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  EvidenceScopeSchema,
  type EvidenceScope,
  type PolicyEvaluationJobSnapshot,
} from "@proofstack/contracts";
import {
  reservePolicyEvaluationAcquisition,
  settlePolicyEvaluationAcquisition,
  createPolicyEvaluationJobHistoryEntry,
  replayPolicyEvaluationJobHistoryEntry,
} from "@proofstack/core";
import {
  MemoryPolicyEvaluationJobRepository,
  policyJobConformanceRequest,
} from "@proofstack/core/testing";
import { PostgresPolicyAcquisitionRepository } from "./postgres-policy-acquisition-repository.js";
import type { PolicyTransactionPool } from "./bounded-policy-transaction.js";

/** Inject transport corruption; native integration tests own SQL, grants, expiry and commit evidence. */
async function fixture() {
  const request = policyJobConformanceRequest();
  const memory = new MemoryPolicyEvaluationJobRepository({ now: () => request.createdAt });
  const scope = request.scope;
  await memory.createJob({ request, jobId: "job_acquisition_adapter" });
  let graph = await memory.claimJob({
    scope,
    jobId: "job_acquisition_adapter",
    workerId: "worker_adapter",
    attemptId: "attempt_adapter",
    leaseId: "lease_adapter",
  });
  const fence = graph.job.currentLease!.mutationFence;
  const head = (await memory.findHistoryHead(scope, fence.jobId))!;
  let entry = (await memory.readHistoryPage(head, 0)).entries.at(-1)!;
  let corrupt: (value: unknown) => unknown = (value) => value;
  let corruptGraph: (value: PolicyEvaluationJobSnapshot) => PolicyEvaluationJobSnapshot = (value) =>
    value;
  const calls: string[] = [];
  const client = {} as PoolClient;
  class Transport extends PostgresPolicyAcquisitionRepository {
    protected override async transact<T>(
      input: EvidenceScope,
      work: (client: PoolClient, scope: EvidenceScope) => Promise<T>,
    ) {
      const original = { graph, entry };
      try {
        return await work(client, EvidenceScopeSchema.parse(input));
      } catch (error) {
        ({ graph, entry } = original);
        throw error;
      }
    }
    protected override async lastOnClient() {
      return entry;
    }
    protected override async verifyIntents() {}
    protected override async admitWorkerBudget() {}
    protected override async append(
      ...args: Parameters<PostgresPolicyAcquisitionRepository["append"]>
    ) {
      const [, previous, previousEntry, next, operation] = args;
      entry = createPolicyEvaluationJobHistoryEntry({ previous, previousEntry, next, operation });
      if (previous) replayPolicyEvaluationJobHistoryEntry(previous, entry);
      return entry;
    }
    protected override async one(_client: PoolClient, sql: string, values: readonly unknown[]) {
      calls.push(sql);
      if (sql.includes("prepare_policy_evaluation_job_mutation"))
        return corruptGraph(structuredClone(graph));
      const allowanceId = String(values[1]);
      const common = {
        snapshot: graph,
        fence,
        allowanceId,
        recoveryEpoch: 0,
        now: graph.job.updatedAt,
      };
      if (sql.includes("reserve_policy_acquisition")) {
        const created = graph.acquisitionAllowance == null;
        if (created) graph = reservePolicyEvaluationAcquisition(common);
        return corrupt({ created, snapshot: graph, allowance: graph.acquisitionAllowance });
      }
      if (sql.includes("settle_policy_acquisition")) {
        graph = settlePolicyEvaluationAcquisition({
          ...common,
          usage: JSON.parse(String(values[2])),
        });
        return corrupt(graph);
      }
      throw new Error("Unexpected transport query");
    }
  }
  return {
    repository: new Transport({} as PolicyTransactionPool),
    scope,
    fence,
    calls,
    graph: () => graph,
    entry: () => entry,
    corrupt: (fn: typeof corrupt) => {
      corrupt = fn;
    },
    corruptGraph: (fn: typeof corruptGraph) => {
      corruptGraph = fn;
    },
  };
}
describe("acquisition adapter receipt integrity", () => {
  it("keeps exact duplicate credit and settles only one owning observed occurrence", async () => {
    const f = await fixture();
    const command = { scope: f.scope, fence: f.fence, allowanceId: "allowance_adapter" };
    const first = await f.repository.reserveAcquisition(command);
    expect(first.created).toBe(true);
    expect(await f.repository.reserveAcquisition(command)).toEqual({ ...first, created: false });
    expect(f.entry().definition.operation.kind).toBe("reserve_acquisition");
    const usage = { reads: 1, records: 1, references: 1, recordBytes: 4, referenceBytes: 2 };
    const settled = await f.repository.settleAcquisition({ ...command, usage });
    expect(settled.usage).toMatchObject(usage);
    expect(f.entry().definition.operation.kind).toBe("settle_acquisition");
  });
  it("burns unknown credit and records a terminal owning transition", async () => {
    const f = await fixture();
    const command = { scope: f.scope, fence: f.fence, allowanceId: "allowance_adapter" };
    await f.repository.reserveAcquisition(command);
    const next = await f.repository.settleAcquisition({ ...command, usage: null });
    expect(next.job.status).toBe("budget_exhausted");
    expect(next.usage.reads).toBe(next.request.limits.maxAcquisitionRecords);
  });
  it.each([
    null,
    [],
    {},
    { created: 1, snapshot: {}, allowance: {} },
    { created: true, snapshot: {}, allowance: {}, extra: 1 },
  ])("rolls back malformed credit acknowledgement %j", async (receipt) => {
    const f = await fixture();
    const before = f.graph();
    f.corrupt(() => receipt);
    await expect(
      f.repository.reserveAcquisition({
        scope: f.scope,
        fence: f.fence,
        allowanceId: "allowance_adapter",
      }),
    ).rejects.toThrow();
    expect(f.graph()).toEqual(before);
  });
  it("rejects a substituted valid credit id before acknowledging metadata I/O", async () => {
    const f = await fixture();
    const before = f.graph();
    f.corrupt((value) => {
      const receipt = value as Record<string, unknown>;
      return {
        ...receipt,
        allowance: { ...(receipt["allowance"] as object), allowanceId: "allowance_other" },
      };
    });
    await expect(
      f.repository.reserveAcquisition({
        scope: f.scope,
        fence: f.fence,
        allowanceId: "allowance_adapter",
      }),
    ).rejects.toThrow();
    expect(f.graph()).toEqual(before);
  });
  it("rejects a changed valid graph on duplicate acknowledgement", async () => {
    const f = await fixture();
    const command = { scope: f.scope, fence: f.fence, allowanceId: "allowance_adapter" };
    await f.repository.reserveAcquisition(command);
    const before = f.graph();
    f.corrupt((value) => {
      const receipt = value as { snapshot: PolicyEvaluationJobSnapshot };
      return {
        ...receipt,
        snapshot: {
          ...receipt.snapshot,
          usage: { ...receipt.snapshot.usage, artifactReadBytes: 1 },
        },
      };
    });
    await expect(f.repository.reserveAcquisition(command)).rejects.toThrow();
    expect(f.graph()).toEqual(before);
  });
  it("rejects a valid settlement graph with a substituted independent fee", async () => {
    const f = await fixture();
    const command = { scope: f.scope, fence: f.fence, allowanceId: "allowance_adapter" };
    await f.repository.reserveAcquisition(command);
    const before = f.graph();
    f.corrupt((value) => {
      const graph = value as PolicyEvaluationJobSnapshot;
      return { ...graph, usage: { ...graph.usage, artifactReadBytes: 1 } };
    });
    await expect(
      f.repository.settleAcquisition({
        ...command,
        usage: { reads: 1, records: 0, references: 0, recordBytes: 0, referenceBytes: 0 },
      }),
    ).rejects.toThrow();
    expect(f.graph()).toEqual(before);
  });
  it("validates identifiers and meters before touching a dependency", async () => {
    const f = await fixture();
    await expect(
      f.repository.reserveAcquisition({ scope: f.scope, fence: f.fence, allowanceId: "bad" + "!" }),
    ).rejects.toThrow();
    await expect(
      f.repository.settleAcquisition({
        scope: f.scope,
        fence: f.fence,
        allowanceId: "allowance_adapter",
        usage: { reads: -1, records: 0, references: 0, recordBytes: 0, referenceBytes: 0 },
      }),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
});
