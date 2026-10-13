import { describe, expect, it } from "vitest";
import { MemoryPolicyEvaluationJobRepository } from "./memory-policy-evaluation-job-repository.js";
import { policyJobRepositoryConformanceCases } from "./policy-evaluation-job-repository-conformance.js";
import { policyJobConformanceRequest } from "./policy-evaluation-job-repository-conformance.js";
import { addPolicyEvaluationMilliseconds } from "../policy/policy-evaluation-scheduler-time.js";
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
