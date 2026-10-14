import { describe, it } from "vitest";
import { MemoryPolicyEvaluationJobRepository } from "./memory-policy-evaluation-job-repository.js";
import {
  policyAcquisitionRepositoryConformanceCases,
  policyJobConformanceRequest,
} from "./policy-acquisition-repository-conformance.js";
describe("memory acquisition allowance shared conformance", () => {
  for (const testcase of policyAcquisitionRepositoryConformanceCases)
    it(testcase.name, async () => {
      const request = policyJobConformanceRequest();
      const repository = new MemoryPolicyEvaluationJobRepository({ now: () => request.createdAt });
      await testcase.run({
        control: repository,
        worker: repository,
        acquisition: repository,
        request: (scope) => (scope ? policyJobConformanceRequest(scope) : request),
      });
    });
});
