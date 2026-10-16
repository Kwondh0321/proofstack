import { describe, it } from "vitest";
import { MemoryReleaseApprovalRepository } from "./memory-release-approval-repository.js";
import { releaseApprovalRepositoryFixture } from "./release-approval-repository-fixtures.js";
import { releaseApprovalRepositoryConformanceCases } from "./release-approval-repository-conformance.js";
describe("trusted approval receipt persistence / shared native contract, not authentication", () => {
  for (const example of releaseApprovalRepositoryConformanceCases)
    it(example.name, () =>
      example.run((namespace) => ({
        repository: new MemoryReleaseApprovalRepository(),
        fixture: releaseApprovalRepositoryFixture(namespace),
      })),
    );
});
