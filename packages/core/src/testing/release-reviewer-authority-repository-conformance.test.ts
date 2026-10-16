import { describe, it } from "vitest";
import { MemoryReleaseReviewerAuthorityRepository } from "./memory-release-reviewer-authority-repository.js";
import { releaseReviewerAuthorityRepositoryFixture } from "./release-reviewer-authority-repository-fixtures.js";
import { releaseReviewerAuthorityRepositoryConformanceCases } from "./release-reviewer-authority-repository-conformance.js";
describe("immutable target-owned reviewer authority memory repository / shared native contract", () => {
  for (const example of releaseReviewerAuthorityRepositoryConformanceCases)
    it(example.name, () =>
      example.run((namespace) => ({
        repository: new MemoryReleaseReviewerAuthorityRepository(),
        fixture: releaseReviewerAuthorityRepositoryFixture(namespace),
      })),
    );
});
