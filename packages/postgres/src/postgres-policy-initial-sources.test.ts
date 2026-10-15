import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type {
  EvidenceScope,
  PolicyEvaluationJobSnapshot,
  PolicyEvaluationWorkerMutationFence,
} from "@proofstack/contracts";
import type { PolicyEvaluationJobHistoryEntry } from "@proofstack/contracts";
import {
  MemoryPolicyEvaluationJobRepository,
  policyJobConformanceRequest,
} from "@proofstack/core/testing";
import { PostgresPolicyEvaluationJobReader } from "./postgres-policy-evaluation-job-base.js";
import type { PolicyTransactionPool } from "./bounded-policy-transaction.js";
import { createPostgresPolicyInitialSources } from "./postgres-policy-initial-sources.js";

afterEach(() => vi.restoreAllMocks());
/** Protected visibility only. This models transport faults; native tests prove SQL/roles/wire. */
interface TransportAccess {
  transact<T>(
    scope: EvidenceScope,
    work: (client: PoolClient, scope: EvidenceScope) => Promise<T>,
    options?: { requireWire?: boolean },
  ): Promise<T>;
  admitWorkerBudget(
    client: PoolClient,
    graph: PolicyEvaluationJobSnapshot,
    fence?: PolicyEvaluationWorkerMutationFence,
  ): Promise<void>;
  lastOnClient(
    client: PoolClient,
    scope: EvidenceScope,
    graph: PolicyEvaluationJobSnapshot,
  ): Promise<PolicyEvaluationJobHistoryEntry>;
  verifyIntents(client: PoolClient, graph: PolicyEvaluationJobSnapshot): Promise<void>;
}
async function fixture() {
  const request = policyJobConformanceRequest();
  const scope = request.scope;
  const memory = new MemoryPolicyEvaluationJobRepository({ now: () => request.createdAt });
  await memory.createJob({ request, jobId: "job_initial_sources" });
  const claimed = await memory.claimJob({
    scope,
    jobId: "job_initial_sources",
    workerId: "worker_initial",
    attemptId: "attempt_initial",
    leaseId: "lease_initial",
  });
  const fence = claimed.job.currentLease!.mutationFence;
  const allowanceId = "allowance_initial_sources";
  let graph = (await memory.reserveAcquisition({ scope, fence, allowanceId })).snapshot;
  const head = (await memory.findHistoryHead(scope, fence.jobId))!;
  const entry = (await memory.readHistoryPage(head, 0)).entries.at(-1)!;
  const queries: string[] = [];
  const queryCalls: { text: string; values?: readonly unknown[] }[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      queries.push(text);
      queryCalls.push({ text, ...(values ? { values: structuredClone(values) } : {}) });
      if (text.includes("prepare_policy_evaluation_job_mutation"))
        return { rows: [{ value: graph }] };
      if (text.includes("proofstack_read_replay_job_snapshot"))
        return { rows: [{ snapshot: null }] };
      const flags = [...text.matchAll(/AS (retained_[a-z_]+)/g)].map((match) => [match[1], false]);
      return { rows: flags.length ? [Object.fromEntries(flags)] : [] };
    }),
  } as unknown as PoolClient;
  const access = PostgresPolicyEvaluationJobReader.prototype as unknown as TransportAccess;
  const transact = vi
    .spyOn(access, "transact")
    .mockImplementation(
      async <T>(
        input: EvidenceScope,
        work: (client: PoolClient, scope: EvidenceScope) => Promise<T>,
        options?: { requireWire?: boolean },
      ) => {
        expect(options).toEqual({ requireWire: true });
        return work(client, input);
      },
    );
  const budget = vi
    .spyOn(access, "admitWorkerBudget")
    .mockImplementation(async (_client, owned, expected) => {
      expect(owned).toEqual(graph);
      expect(expected).toEqual(fence);
    });
  const history = vi.spyOn(access, "lastOnClient").mockResolvedValue(entry);
  const intents = vi.spyOn(access, "verifyIntents").mockResolvedValue(undefined);
  const identity = structuredClone({ scope, fence, allowanceId });
  const sources = createPostgresPolicyInitialSources({} as PolicyTransactionPool, identity);
  return {
    sources,
    memory,
    scope,
    fence,
    identity,
    graph: () => graph,
    replace: (value: PolicyEvaluationJobSnapshot) => {
      graph = value;
    },
    queries,
    queryCalls,
    transact,
    budget,
    history,
    intents,
  };
}

describe("fixed initial policy source transport", () => {
  it("refuses an ordinary physical client before any SQL through the real transaction owner", async () => {
    const f = await fixture();
    vi.restoreAllMocks();
    const query = vi.fn(async () => {
      throw new Error("Unexpected source SQL");
    });
    const destroy = vi.fn(),
      end = vi.fn(async () => undefined),
      release = vi.fn();
    const pool = {
      options: { connectionTimeoutMillis: 500, max: 1 },
      waitingCount: 0,
      connect: vi.fn(async () => ({ query, end, release, connection: { stream: { destroy } } })),
    } as unknown as PolicyTransactionPool;
    const sources = createPostgresPolicyInitialSources(pool, f.identity);
    await expect(sources.catalog.find(f.scope, "artifact_one")).rejects.toMatchObject({
      code: "wire_pool_required",
    });
    expect(query).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("forwards every fixed owning source through its exact credit, native window and history admission", async () => {
    const f = await fixture();
    const { repositories: r } = f.sources;
    const { listCriterionSetStatuses, ...evaluation } = r.evidence.evaluation;
    const reads: (() => Promise<unknown>)[] = [
      () =>
        r.logicalRoots.evaluation.findEvaluationLogicalRoot(f.scope, "criterion_set", "record_one"),
      () =>
        r.logicalRoots.comparison.findComparisonLogicalRoot(
          f.scope,
          "comparison_definition",
          "record_one",
        ),
      () => r.logicalRoots.releaseCandidate.findReleaseCandidateLogicalRoot(f.scope, "record_one"),
      () => r.logicalRoots.releasePolicy.findReleasePolicyLogicalRoot(f.scope, "record_one"),
      () => r.logicalRoots.datasets.findDatasetLogicalRoot(f.scope, "record_one"),
      () => r.logicalRoots.datasets.findFixtureLogicalRoot(f.scope, "record_one"),
      () =>
        r.logicalRoots.datasets.findRecordedInteractionFixtureLogicalRoot(f.scope, "record_one"),
      ...Object.values(evaluation).map((read) => () => read(f.scope, "record_one")),
      () => listCriterionSetStatuses(f.scope, { maxRecords: 10, maxRecordBytes: 100000 }),
      () => r.evidence.modelAssurance.find(f.scope, "calibration_report", "record_one"),
      ...Object.values(r.control.comparison).map((read) => () => read(f.scope, "record_one")),
      () => r.control.releaseCandidate.findReleaseCandidate(f.scope, "record_one"),
      () => r.control.releasePolicy.findReleasePolicy(f.scope, "record_one"),
      () => r.control.releasePolicy.listReleasePolicyLifecycleEvents(f.scope, "record_one"),
      () =>
        r.control.installationBinding.resolve({
          scope: f.scope,
          reference: {
            bindingVersionId: "binding_one",
            definitionSha256: "1".repeat(64),
            installationId: "installation_one",
          },
        }),
      ...Object.values(r.datasets).map((read) => () => read(f.scope, "record_one")),
      ...Object.values(r.replayDefinitions).map((read) => () => read(f.scope, "record_one")),
      () => r.replayResults.findJob(f.scope, "record_one"),
      () => r.runtimeDefinitions.findRuntimeProfile(f.scope, "runtime_one", "1.0.0"),
      () => r.runtimeDefinitions.findIsolationProfile(f.scope, "isolation_one", "1.0.0"),
      () => r.runtimeDefinitions.findRuntimeAdapter(f.scope, "adapter_one"),
      () =>
        r.implementationRegistrations.findEvaluationImplementationRegistration(
          f.scope,
          "implementation_one",
          "version_one",
        ),
      () => r.qualificationPolicies.findQualificationPolicy(f.scope, "policy_one", "version_one"),
      () => r.endpointProfiles.findEndpointProfile(f.scope, "endpoint_one", "V1.0+RC-1"),
      () => r.protocolDefinitions.findProtocolDefinition(f.scope, "protocol_one"),
      () =>
        r.protocolDefinitions.listProtocolDefinitions(f.scope, {
          family: "worker_protocol",
          descriptor: { name: "protocol:worker", version: "V1+RC" },
        }),
      () =>
        f.sources.evidence.resolveExactEvents(f.scope, "5bf92f3577b34da6a3ce929d0e0e4736", [
          "event_one",
        ]),
      () => f.sources.catalog.find(f.scope, "artifact_one"),
      () => f.sources.fixtureContent.findRecordedInteractionFixtureContent(f.scope, "fixture_one"),
    ];
    for (const read of reads) await read();
    expect(f.transact).toHaveBeenCalledTimes(reads.length);
    expect(f.budget).toHaveBeenCalledTimes(reads.length);
    expect(f.history).toHaveBeenCalledTimes(reads.length);
    expect(f.intents).toHaveBeenCalledTimes(reads.length);
    expect(f.queries.some((query) => /INSERT|UPDATE|DELETE|try_lock_policy/.test(query))).toBe(
      false,
    );
    expect(Object.keys(f.sources).sort()).toEqual([
      "catalog",
      "evidence",
      "fixtureContent",
      "repositories",
    ]);
  });
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects %s escape before checkout",
    async (field) => {
      const f = await fixture();
      await expect(
        f.sources.catalog.find({ ...f.scope, [field]: "outside_scope" }, "artifact_one"),
      ).rejects.toThrow("scope differs");
      expect(f.transact).not.toHaveBeenCalled();
      expect(f.queries).toEqual([]);
    },
  );
  it("copies the server identity rather than following later scope/fence/credit mutation", async () => {
    const f = await fixture();
    f.identity.scope.projectId = "changed_project";
    f.identity.fence.workerId = "changed_worker";
    f.identity.allowanceId = "changed_credit";
    await expect(f.sources.catalog.find(f.scope, "artifact_one")).resolves.toBeNull();
  });
  it("retains the admitted exact scope and event order when caller arrays mutate during checkout", async () => {
    const f = await fixture();
    const scope = { ...f.scope },
      ids = ["event_second", "event_first"];
    f.budget.mockImplementationOnce(async () => {
      scope.projectId = "mutated_project";
      ids.reverse();
    });
    await expect(
      f.sources.evidence.resolveExactEvents(scope, "5bf92f3577b34da6a3ce929d0e0e4736", ids),
    ).resolves.toBeNull();
    const query = f.queryCalls.find(({ text }) => text.includes("proofstack_evidence_events"));
    expect(query?.values).toEqual([
      f.scope.tenantId,
      f.scope.projectId,
      f.scope.environmentId,
      "5bf92f3577b34da6a3ce929d0e0e4736",
      ["event_second", "event_first"],
    ]);
  });
  it.each(["no_credit", "other_credit", "other_credit_fence"] as const)(
    "refuses %s before source reads",
    async (fault) => {
      const f = await fixture();
      let graph = structuredClone(f.graph());
      if (fault === "no_credit") {
        graph = await f.memory.settleAcquisition({
          scope: f.scope,
          fence: f.fence,
          allowanceId: f.identity.allowanceId,
          usage: { reads: 0, records: 0, references: 0, recordBytes: 0, referenceBytes: 0 },
        });
      } else if (fault === "other_credit")
        graph.acquisitionAllowance!.allowanceId = "allowance_other";
      else graph.acquisitionAllowance!.mutationFence.workerId = "worker_other";
      f.replace(graph);
      await expect(f.sources.catalog.find(f.scope, "artifact_one")).rejects.toThrow();
      expect(f.queries).toHaveLength(1);
      expect(f.history).not.toHaveBeenCalled();
    },
  );
  it.each(["budget", "history", "intents"] as const)(
    "fails closed on %s admission before source SQL",
    async (fault) => {
      const f = await fixture();
      f[fault].mockRejectedValueOnce(new Error("admission_failed"));
      await expect(f.sources.catalog.find(f.scope, "artifact_one")).rejects.toThrow(
        "admission_failed",
      );
      expect(f.queries).toHaveLength(1);
    },
  );
});
