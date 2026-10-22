import { describe, expect, it } from "vitest";
import { MemoryPolicyEvaluationJobRepository } from "./memory-policy-evaluation-job-repository.js";
import { policyJobRepositoryConformanceCases } from "./policy-evaluation-job-repository-conformance.js";
import { policyJobConformanceRequest } from "./policy-evaluation-job-repository-conformance.js";
import { addPolicyEvaluationMilliseconds } from "../policy/policy-evaluation-scheduler-time.js";
import { policySnapshotRepositoryFixture } from "./policy-snapshot-repository-fixture.js";
describe("atomic memory policy job repository shared conformance", () => {
  for (const testCase of policyJobRepositoryConformanceCases)
    it(testCase.name, async () => {
      let now = "2026-09-07T12:00:00.123456Z";
      const repository = new MemoryPolicyEvaluationJobRepository({ now: () => now });
      await testCase.run({
        repository,
        setTime: async (value) => {
          now = value;
        },
      });
    });
});
async function active() {
  let now = "2026-09-07T12:00:01.000001Z";
  const repository = new MemoryPolicyEvaluationJobRepository({ now: () => now });
  const request = policyJobConformanceRequest();
  await repository.createJob({ request, jobId: "job_expiry" });
  const snapshot = await repository.claimJob({
    scope: request.scope,
    jobId: "job_expiry",
    workerId: "worker_expiry",
    attemptId: "attempt_first",
    leaseId: "lease_first",
  });
  return {
    repository,
    snapshot,
    setTime: (value: string) => {
      now = value;
    },
  };
}
describe("store-owned policy lease reclamation", () => {
  it("preserves a completed original seal, result, paid reservations and request indexes in an independent fork", async () => {
    const f = policySnapshotRepositoryFixture();
    let now = f.request.createdAt;
    const repository = new MemoryPolicyEvaluationJobRepository({ now: () => now });
    await repository.createJob({ request: f.request, jobId: f.jobId });
    const claimed = await repository.claimJob({
      scope: f.scope,
      jobId: f.jobId,
      workerId: f.workerId,
      attemptId: "attempt_fork_seal",
      leaseId: "lease_fork_seal",
    });
    const fence = claimed.job.currentLease!.mutationFence;
    now = f.publicationAt;
    const sealed = await repository.publishSnapshot({
      scope: f.scope,
      fence,
      pageSet: f.pageSet,
      principalId: f.workerId,
    });
    await repository.startComputation({ scope: f.scope, fence });
    const reservation = {
      scope: f.scope,
      fence,
      reservationId: "reservation_fork_rules",
      delta: {
        reads: 0,
        records: 0,
        recordBytes: 0,
        references: 0,
        referenceBytes: 0,
        artifactReadBytes: 0,
        ruleEvaluations: f.inputs.rules.ruleCount,
      },
    };
    await repository.reserveWork(reservation);
    const paid = repository.fork();
    expect((await paid.reserveWork(reservation)).created).toBe(false);
    const result = await paid.publishResult({
      scope: f.scope,
      fence,
      evaluationId: f.evaluationId,
      pageSet: f.pageSet,
    });
    expect(result.snapshot.job.status).toBe("completed");
    expect((await repository.findJob(f.scope, f.jobId))?.job.status).toBe("running");
    expect(await repository.findResult(f.scope, f.jobId, f.pageSet)).toBeNull();
    const completed = paid.fork();
    const expected = {
      scope: f.scope,
      job: { jobId: f.jobId, definitionSha256: sealed.job.job.definitionSha256 },
      request: sealed.job.job.request,
      snapshot: sealed.job.job.snapshot!,
    };
    expect(await completed.findSnapshot(expected)).toEqual(sealed.snapshot);
    expect(await completed.findResult(f.scope, f.jobId, f.pageSet)).toEqual(result.evaluation);
    expect(await completed.findJobForRequest(f.scope, sealed.job.job.request)).toEqual(
      result.snapshot,
    );
    expect(
      (await completed.createJob({ request: f.request, jobId: "job_other_fork_retry" })).created,
    ).toBe(false);
    // Changing the fork's owner index cannot damage the original retained result.
    (completed as unknown as { snapshotOwners: Map<string, string> }).snapshotOwners.clear();
    await expect(completed.findSnapshot(expected)).rejects.toBeDefined();
    expect(await paid.findSnapshot(expected)).toEqual(sealed.snapshot);
    now = addPolicyEvaluationMilliseconds(now, 1);
    expect(await paid.findResult(f.scope, f.jobId, f.pageSet)).toEqual(result.evaluation);
  });
  it("isolates tentative cancellation, histories and request ownership from the retained job", async () => {
    const { repository, snapshot } = await active(),
      next = repository.fork();
    const request = {
      evaluationRequestId: snapshot.request.evaluationRequestId,
      definitionSha256: snapshot.request.definitionSha256,
    };
    expect(await next.findJobForRequest(snapshot.job.scope, request)).toEqual(snapshot);
    expect(await next.findOutboxIntents(snapshot.job.scope, snapshot.job.jobId)).toEqual(
      await repository.findOutboxIntents(snapshot.job.scope, snapshot.job.jobId),
    );
    const cancelled = await next.cancelJob({
      scope: snapshot.job.scope,
      jobId: snapshot.job.jobId,
      cancellationId: "cancel_tentative_branch",
      principalId: "operator_tentative",
      reason: "incident_response",
    });
    expect(cancelled.job.status).toBe("cancelled");
    expect(await repository.findJob(snapshot.job.scope, snapshot.job.jobId)).toEqual(snapshot);
    const again = next.fork();
    expect(await again.findJobForRequest(snapshot.job.scope, request)).toEqual(cancelled);
    const head = await again.findHistoryHead(snapshot.job.scope, snapshot.job.jobId);
    if (!head) throw new Error("Missing retained tentative history");
    expect(await again.readHistoryPage(head, 0)).toEqual(await next.readHistoryPage(head, 0));
    const record = (
      again as unknown as { records: Map<string, { snapshot: { job: { stateVersion: number } } }> }
    ).records
      .values()
      .next().value;
    if (!record) throw new Error("Missing forked job graph");
    record.snapshot.job.stateVersion += 1;
    await expect(again.findJob(snapshot.job.scope, snapshot.job.jobId)).rejects.toBeDefined();
    expect(await next.findJob(snapshot.job.scope, snapshot.job.jobId)).toEqual(cancelled);
    expect(await repository.findJob(snapshot.job.scope, snapshot.job.jobId)).toEqual(snapshot);
  });
  it("rejects early reclaim without changing the live worker", async () => {
    const { repository, snapshot } = await active();
    await expect(
      repository.reclaimJob({ scope: snapshot.job.scope, jobId: snapshot.job.jobId }),
    ).rejects.toThrow();
    expect(await repository.findJob(snapshot.job.scope, snapshot.job.jobId)).toEqual(snapshot);
  });
  it("reclaims exactly at expiry and preserves original spent work and request", async () => {
    const { repository, snapshot, setTime } = await active();
    const fence = snapshot.job.currentLease!.mutationFence;
    const used = await repository.reserveUsage({
      scope: snapshot.job.scope,
      fence,
      delta: { ...snapshot.usage, records: 1, recordBytes: 256 },
    });
    setTime(snapshot.job.currentLease!.expiresAt);
    const reclaimed = await repository.reclaimJob({
      scope: snapshot.job.scope,
      jobId: snapshot.job.jobId,
    });
    expect(reclaimed.job.status).toBe("retry_ready");
    expect(reclaimed.attempts[0]!.closure).toEqual({
      status: "interrupted",
      reason: "lease_expired",
      committedAt: snapshot.job.currentLease!.expiresAt,
    });
    expect(reclaimed.usage).toEqual(used.usage);
    expect(reclaimed.request).toEqual(snapshot.request);
    await expect(repository.heartbeatJob({ scope: snapshot.job.scope, fence })).rejects.toThrow();
    setTime(reclaimed.job.retryAt!);
    const next = await repository.claimJob({
      scope: snapshot.job.scope,
      jobId: snapshot.job.jobId,
      workerId: "worker_next",
      attemptId: "attempt_second",
      leaseId: "lease_second",
    });
    expect(next.job.lastFencingToken).toBe(2);
    expect(next.attempts[1]!.usageAtStart).toEqual(used.usage);
    await expect(
      repository.reserveUsage({
        scope: snapshot.job.scope,
        fence,
        delta: { ...snapshot.usage, records: 1 },
      }),
    ).rejects.toThrow();
  });
  it("times out an unclaimed job without fabricating an attempt", async () => {
    const request = policyJobConformanceRequest();
    let now = request.createdAt;
    const repository = new MemoryPolicyEvaluationJobRepository({ now: () => now });
    const created = await repository.createJob({ request, jobId: "job_queued_timeout" });
    now = created.snapshot.job.deadlineAt;
    const timed = await repository.reclaimJob({
      scope: request.scope,
      jobId: "job_queued_timeout",
    });
    expect(timed.job.status).toBe("timed_out");
    expect(timed.job.terminal!.attemptId).toBeNull();
    expect(timed.attempts).toEqual([]);
    now = addPolicyEvaluationMilliseconds(now, 1);
    expect(
      await repository.reclaimJob({ scope: request.scope, jobId: "job_queued_timeout" }),
    ).toEqual(timed);
  });
  it("times out active work at the original job deadline with spent usage retained", async () => {
    const { repository, snapshot, setTime } = await active();
    setTime(snapshot.job.deadlineAt);
    const timed = await repository.reclaimJob({
      scope: snapshot.job.scope,
      jobId: snapshot.job.jobId,
    });
    expect(timed.job.status).toBe("timed_out");
    expect(timed.attempts[0]!.closure?.status).toBe("timed_out");
    expect(timed.request.evaluationTime).toBe(snapshot.request.evaluationTime);
    expect(timed.job.deadlineAt).toBe(snapshot.job.deadlineAt);
  });
  it("serializes cancellation before heartbeat and rejects the old fence", async () => {
    const { repository, snapshot, setTime } = await active();
    setTime(addPolicyEvaluationMilliseconds(snapshot.job.updatedAt, 5000));
    const results = await Promise.allSettled([
      repository.cancelJob({
        scope: snapshot.job.scope,
        jobId: snapshot.job.jobId,
        cancellationId: "cancel_race",
        principalId: "operator_race",
        reason: "incident_response",
      }),
      repository.heartbeatJob({
        scope: snapshot.job.scope,
        fence: snapshot.job.currentLease!.mutationFence,
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    const retained = await repository.findJob(snapshot.job.scope, snapshot.job.jobId);
    expect(retained!.job.status).toBe("cancelled");
    expect(retained!.attempts[0]!.closure?.status).toBe("cancelled");
  });
});
