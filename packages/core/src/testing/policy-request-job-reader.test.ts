import { describe, expect, it } from "vitest";
import { MemoryPolicyEvaluationJobRepository } from "./memory-policy-evaluation-job-repository.js";
import { createPolicyRequestJobReaderConformanceCases } from "./policy-request-job-reader-conformance.js";
import { policyJobConformanceRequest } from "./policy-evaluation-job-repository-conformance.js";

describe("owning memory original request/job reader", () => {
  for (const testCase of createPolicyRequestJobReaderConformanceCases()) {
    it(testCase.name, async () => {
      const repository = new MemoryPolicyEvaluationJobRepository({
        now: () => "2026-09-07T12:00:00.123456Z",
      });
      await testCase.run({ control: repository, reader: repository });
    });
  }
  it("strictly admits the original reference without accepting an extra favorable job selector", async () => {
    const repository = new MemoryPolicyEvaluationJobRepository({
      now: () => "2026-09-07T12:00:00.123456Z",
    });
    const request = policyJobConformanceRequest();
    await expect(
      repository.findJobForRequest(request.scope, {
        evaluationRequestId: request.evaluationRequestId,
        definitionSha256: request.definitionSha256,
        ...{ jobId: "job_favorable_other" },
      }),
    ).rejects.toThrow();
  });
});
