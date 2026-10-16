import { describe, it } from "vitest";
import { MemoryReleaseDecisionInputRepository } from "./memory-release-decision-input-repository.js";
import { releaseDecisionInputRepositoryFixture } from "./release-decision-input-repository-fixtures.js";
import { releaseDecisionInputRepositoryConformanceCases } from "./release-decision-input-repository-conformance.js";

describe("original decision input / shared repository conformance", () => {
  for (const example of releaseDecisionInputRepositoryConformanceCases)
    it(example.name, () =>
      example.run((namespace) => ({
        repository: new MemoryReleaseDecisionInputRepository(),
        graph: releaseDecisionInputRepositoryFixture(namespace),
      })),
    );
});
