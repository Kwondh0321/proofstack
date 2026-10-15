import { MemoryPolicyEvaluationJobRepository } from "./memory-policy-evaluation-job-repository.js";
import { policySnapshotRepositoryFixture } from "./policy-snapshot-repository-fixture.js";
import type { PolicySnapshotResultRepositoryHarness } from "./policy-snapshot-result-repository-conformance.js";

/** One real memory repository per shared case; captured material is published through its writer. */
export function createMemoryPolicySnapshotResultHarness(): PolicySnapshotResultRepositoryHarness {
  const f = policySnapshotRepositoryFixture();
  let now = f.request.createdAt;
  const repository = new MemoryPolicyEvaluationJobRepository({ now: () => now });
  return {
    control: repository,
    worker: repository,
    snapshots: repository,
    results: repository,
    async waitForRetry(retryAt) {
      now = retryAt;
    },
    async seed() {
      await repository.createJob({ request: f.request, jobId: f.jobId });
      const claimed = await repository.claimJob({
        scope: f.scope,
        jobId: f.jobId,
        workerId: f.workerId,
        attemptId: "attempt_shared_conformance",
        leaseId: "lease_shared_conformance",
      });
      const fence = claimed.job.currentLease!.mutationFence;
      now = f.publicationAt;
      const sealed = await repository.publishSnapshot({
        scope: f.scope,
        fence,
        pageSet: f.pageSet,
        principalId: f.workerId,
      });
      return {
        scope: f.scope,
        jobId: f.jobId,
        fence,
        pageSet: f.pageSet,
        snapshot: sealed.snapshot,
        evaluationId: f.evaluationId,
        expected: {
          scope: f.scope,
          job: { jobId: f.jobId, definitionSha256: sealed.job.job.definitionSha256 },
          request: sealed.job.job.request,
          snapshot: sealed.job.job.snapshot!,
        },
      };
    },
  };
}
