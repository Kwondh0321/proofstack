import { describe, expect, it } from "vitest";
import { PolicyEvaluationUsageSchema } from "@proofstack/contracts";
import { MemoryPolicyEvaluationJobRepository } from "./memory-policy-evaluation-job-repository.js";
import { policySnapshotRepositoryFixture } from "./policy-snapshot-repository-fixture.js";
import { readCompletePolicyEvaluationSnapshot } from "../policy/policy-evaluation-snapshot-repository.js";
import { addPolicyEvaluationMilliseconds } from "../policy/policy-evaluation-scheduler-time.js";
import { policySnapshotResultRepositoryConformanceCases } from "./policy-snapshot-result-repository-conformance.js";
import { createMemoryPolicySnapshotResultHarness } from "./memory-policy-snapshot-result-harness.js";

async function start(
  index = 0,
  repository?: MemoryPolicyEvaluationJobRepository,
  clock?: { now: string },
) {
  const f = policySnapshotRepositoryFixture(index);
  const current = clock ?? { now: f.request.createdAt };
  current.now = f.request.createdAt;
  const clockSource = { now: () => current.now };
  const jobs = repository ?? new MemoryPolicyEvaluationJobRepository(clockSource);
  await jobs.createJob({ request: f.request, jobId: f.jobId });
  const claimed = await jobs.claimJob({
    scope: f.scope,
    jobId: f.jobId,
    workerId: f.workerId,
    attemptId: "attempt_conformance",
    leaseId: "lease_conformance",
  });
  const fence = claimed.job.currentLease!.mutationFence;
  current.now = f.publicationAt;
  const command = { scope: f.scope, fence, pageSet: f.pageSet, principalId: f.workerId };
  const sealed = await jobs.publishSnapshot(command);
  const expected = {
    scope: f.scope,
    job: { jobId: f.jobId, definitionSha256: sealed.job.job.definitionSha256 },
    request: sealed.job.job.request,
    snapshot: sealed.job.job.snapshot!,
  };
  return { ...f, jobs, current, clockSource, fence, claimed, sealed, expected, command };
}
async function complete(f: Awaited<ReturnType<typeof start>>, paid = true) {
  f.current.now = addPolicyEvaluationMilliseconds(f.publicationAt, 1);
  await f.jobs.startComputation({ scope: f.scope, fence: f.fence });
  if (paid)
    await f.jobs.reserveWork({
      scope: f.scope,
      fence: f.fence,
      reservationId: "reservation_rules_conformance",
      delta: PolicyEvaluationUsageSchema.parse({
        reads: 0,
        records: 0,
        references: 0,
        recordBytes: 0,
        referenceBytes: 0,
        artifactReadBytes: 0,
        ruleEvaluations: f.inputs.rules.ruleCount,
      }),
    });
  return f.jobs.publishResult({
    scope: f.scope,
    fence: f.fence,
    evaluationId: f.evaluationId,
    pageSet: f.pageSet,
  });
}
describe("memory owning snapshot and result persistence", () => {
  for (const failure of ["wrong_actor", "altered_page", "pending_credit"] as const)
    it(`rolls back every snapshot material/history effect on ${failure}`, async () => {
      const f = policySnapshotRepositoryFixture();
      let now = f.request.createdAt;
      const jobs = new MemoryPolicyEvaluationJobRepository({ now: () => now });
      await jobs.createJob({ request: f.request, jobId: f.jobId });
      const claimed = await jobs.claimJob({
        scope: f.scope,
        jobId: f.jobId,
        workerId: f.workerId,
        attemptId: "attempt_invalid_publication",
        leaseId: "lease_invalid_publication",
      });
      const fence = claimed.job.currentLease!.mutationFence;
      now = f.publicationAt;
      if (failure === "pending_credit")
        await jobs.reserveAcquisition({
          scope: f.scope,
          fence,
          allowanceId: "allowance_unsettled",
        });
      const before = await jobs.findJob(f.scope, f.jobId);
      const head = await jobs.findHistoryHead(f.scope, f.jobId);
      const intents = await jobs.findOutboxIntents(f.scope, f.jobId);
      const pageSet = structuredClone(f.pageSet);
      if (failure === "altered_page") pageSet.pages[0]!.frames[0]!.dataBase64url = "e30";
      await expect(
        jobs.publishSnapshot({
          scope: f.scope,
          fence,
          pageSet,
          principalId: failure === "wrong_actor" ? "worker_other" : f.workerId,
        }),
      ).rejects.toThrow();
      expect(await jobs.findJob(f.scope, f.jobId)).toEqual(before);
      expect(await jobs.findHistoryHead(f.scope, f.jobId)).toEqual(head);
      expect(await jobs.findOutboxIntents(f.scope, f.jobId)).toEqual(intents);
      expect(
        await jobs.findSnapshot({
          scope: f.scope,
          job: { jobId: f.jobId, definitionSha256: claimed.job.definitionSha256 },
          request: claimed.job.request,
          snapshot: {
            snapshotId: f.pageSet.definition.snapshotId,
            definitionSha256: f.pageSet.definitionSha256,
          },
        }),
      ).toBeNull();
    });
  it("refuses snapshot commit if the original lease expires after input validation", async () => {
    const f = policySnapshotRepositoryFixture();
    let cut = f.request.createdAt;
    const clock = { now: () => cut };
    const jobs = new MemoryPolicyEvaluationJobRepository(clock);
    await jobs.createJob({ request: f.request, jobId: f.jobId });
    const claimed = await jobs.claimJob({
      scope: f.scope,
      jobId: f.jobId,
      workerId: f.workerId,
      attemptId: "attempt_expiring_seal",
      leaseId: "lease_expiring_seal",
    });
    const fence = claimed.job.currentLease!.mutationFence;
    const head = await jobs.findHistoryHead(f.scope, f.jobId);
    cut = f.publicationAt;
    let reads = 0;
    clock.now = () => (++reads <= 2 ? cut : claimed.job.currentLease!.expiresAt);
    await expect(
      jobs.publishSnapshot({ scope: f.scope, fence, pageSet: f.pageSet, principalId: f.workerId }),
    ).rejects.toThrow();
    expect(await jobs.findJob(f.scope, f.jobId)).toEqual(claimed);
    expect(await jobs.findHistoryHead(f.scope, f.jobId)).toEqual(head);
    expect(
      await jobs.findSnapshot({
        scope: f.scope,
        job: { jobId: f.jobId, definitionSha256: claimed.job.definitionSha256 },
        request: claimed.job.request,
        snapshot: {
          snapshotId: f.pageSet.definition.snapshotId,
          definitionSha256: f.pageSet.definitionSha256,
        },
      }),
    ).toBeNull();
  });
  for (const mode of ["expiry", "backward_clock"] as const)
    it(`keeps paid work but rolls back result/job/history on final ${mode}`, async () => {
      const f = await start();
      f.current.now = addPolicyEvaluationMilliseconds(f.publicationAt, 1);
      await f.jobs.startComputation({ scope: f.scope, fence: f.fence });
      await f.jobs.reserveWork({
        scope: f.scope,
        fence: f.fence,
        reservationId: "reservation_expiring_result",
        delta: {
          reads: 0,
          records: 0,
          references: 0,
          recordBytes: 0,
          referenceBytes: 0,
          artifactReadBytes: 0,
          ruleEvaluations: f.inputs.rules.ruleCount,
        },
      });
      const before = (await f.jobs.findJob(f.scope, f.jobId))!,
        head = await f.jobs.findHistoryHead(f.scope, f.jobId);
      const began = addPolicyEvaluationMilliseconds(f.publicationAt, 2);
      const ended =
        mode === "expiry"
          ? before.job.currentLease!.expiresAt
          : addPolicyEvaluationMilliseconds(f.publicationAt, 1);
      let reads = 0;
      f.clockSource.now = () => (++reads <= 2 ? began : ended);
      await expect(
        f.jobs.publishResult({
          scope: f.scope,
          fence: f.fence,
          evaluationId: f.evaluationId,
          pageSet: f.pageSet,
        }),
      ).rejects.toThrow();
      expect(await f.jobs.findJob(f.scope, f.jobId)).toEqual(before);
      expect(await f.jobs.findHistoryHead(f.scope, f.jobId)).toEqual(head);
      expect((await f.jobs.findJob(f.scope, f.jobId))?.usage.ruleEvaluations).toBe(
        f.inputs.rules.ruleCount,
      );
      expect(await f.jobs.findResult(f.scope, f.jobId, f.pageSet)).toBeNull();
    });
  for (const testcase of policySnapshotResultRepositoryConformanceCases)
    it(`shared: ${testcase.name}`, async () =>
      testcase.run(createMemoryPolicySnapshotResultHarness()));
  it("stores every original page with its same-attempt job/history atomically", async () => {
    const f = await start();
    const original = await readCompletePolicyEvaluationSnapshot(f.jobs, f.expected);
    expect(original).toEqual({ snapshot: f.sealed.snapshot, pageSet: f.pageSet });
    expect(original?.pageSet.pages).toHaveLength(3);
    const head = (await f.jobs.findHistoryHead(f.scope, f.jobId))!;
    const page = await f.jobs.readHistoryPage(head, 0);
    expect(page.entries.at(-1)?.definition.operation.kind).toBe("seal");
    expect(page.entries.at(-1)?.definition.graphSha256).toBe(head.graphSha256);
  });
  it("computes from retained original inputs and atomically closes result/job/history/outbox", async () => {
    const f = await start();
    const result = await complete(f);
    expect(result.created).toBe(true);
    expect(result.snapshot.job.status).toBe("completed");
    expect(result.snapshot.job.currentLease).toBeNull();
    expect(result.evaluation.ruleCount).toBe(f.inputs.rules.ruleCount);
    expect(await f.jobs.findResult(f.scope, f.jobId, f.pageSet)).toEqual(result.evaluation);
    const intents = (await f.jobs.findOutboxIntents(f.scope, f.jobId))!;
    expect(intents.map((value) => value.eventType)).toEqual([
      "policy.evaluation.job.created",
      "policy.evaluation.job.terminal",
    ]);
    const head = (await f.jobs.findHistoryHead(f.scope, f.jobId))!;
    expect((await f.jobs.readHistoryPage(head, 0)).entries.at(-1)?.definition.operation.kind).toBe(
      "complete",
    );
  });
  it("exact result retry retains original receipts without another lease or terminal intent", async () => {
    const f = await start();
    const result = await complete(f);
    const head = await f.jobs.findHistoryHead(f.scope, f.jobId);
    f.current.now = addPolicyEvaluationMilliseconds(f.publicationAt, 100000);
    const retry = await f.jobs.publishResult({
      scope: f.scope,
      fence: f.fence,
      evaluationId: f.evaluationId,
      pageSet: f.pageSet,
    });
    expect(retry).toEqual({ ...result, created: false });
    expect(await f.jobs.findHistoryHead(f.scope, f.jobId)).toEqual(head);
    await expect(
      f.jobs.publishResult({
        scope: f.scope,
        fence: { ...f.fence, workerId: "worker_other" },
        evaluationId: f.evaluationId,
        pageSet: f.pageSet,
      }),
    ).rejects.toThrow();
  });
  it("unpaid work leaves the running job and canonical intent wholly unchanged", async () => {
    const f = await start();
    await f.jobs.startComputation({ scope: f.scope, fence: f.fence });
    const before = await f.jobs.findJob(f.scope, f.jobId),
      head = await f.jobs.findHistoryHead(f.scope, f.jobId);
    await expect(
      f.jobs.publishResult({
        scope: f.scope,
        fence: f.fence,
        evaluationId: f.evaluationId,
        pageSet: f.pageSet,
      }),
    ).rejects.toThrow();
    expect(await f.jobs.findJob(f.scope, f.jobId)).toEqual(before);
    expect(await f.jobs.findHistoryHead(f.scope, f.jobId)).toEqual(head);
    expect(await f.jobs.findResult(f.scope, f.jobId, f.pageSet)).toBeNull();
  });
  it("retains immutable pages after cancellation and returns copies to readers", async () => {
    const f = await start();
    const root = await f.jobs.findSnapshot(f.expected);
    root!.sealedByPrincipalId = "changed_client_copy";
    const page = (await f.jobs.readSnapshotPage(f.expected, 0))!;
    page.frames[0]!.dataBase64url = "e30";
    await f.jobs.cancelJob({
      scope: f.scope,
      jobId: f.jobId,
      cancellationId: "cancellation_conformance",
      principalId: "operator_conformance",
      reason: "operator_requested",
    });
    expect(await readCompletePolicyEvaluationSnapshot(f.jobs, f.expected)).toEqual({
      snapshot: f.sealed.snapshot,
      pageSet: f.pageSet,
    });
    await expect(complete(f)).rejects.toThrow();
  });
  it("does not replace absent exact refs or accept substituted pages", async () => {
    const f = await start();
    expect(
      await f.jobs.findSnapshot({
        ...f.expected,
        snapshot: { ...f.expected.snapshot, snapshotId: "snapshot_absent" },
      }),
    ).toBeNull();
    await expect(f.jobs.readSnapshotPage(f.expected, 3)).rejects.toThrow();
    const forged = structuredClone(f.pageSet);
    forged.pages[0]!.frames[0]!.dataBase64url = "e30";
    await expect(
      f.jobs.publishResult({
        scope: f.scope,
        fence: f.fence,
        evaluationId: f.evaluationId,
        pageSet: forged,
      }),
    ).rejects.toThrow();
    expect(await f.jobs.findResult(f.scope, f.jobId, f.pageSet)).toBeNull();
  });
  it("isolates identical job, snapshot and result IDs across three captured tenant scopes", async () => {
    const current = { now: "2026-10-15T00:00:00.000Z" };
    const jobs = new MemoryPolicyEvaluationJobRepository({ now: () => current.now });
    const fixtures = [];
    for (let index = 0; index < 3; index++) {
      const f = await start(index, jobs, current);
      const result = await complete(f);
      fixtures.push({ f, result });
    }
    expect(new Set(fixtures.map(({ f }) => f.scope.tenantId)).size).toBe(3);
    expect(new Set(fixtures.map(({ f }) => f.expected.snapshot.definitionSha256)).size).toBe(3);
    for (const { f, result } of fixtures) {
      expect(await readCompletePolicyEvaluationSnapshot(jobs, f.expected)).toEqual({
        snapshot: f.sealed.snapshot,
        pageSet: f.pageSet,
      });
      expect(await jobs.findResult(f.scope, f.jobId, f.pageSet)).toEqual(result.evaluation);
    }
  });
});
