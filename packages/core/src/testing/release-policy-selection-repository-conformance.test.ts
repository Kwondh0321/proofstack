import { describe, it } from "vitest";
import { MemoryReleasePolicySelectionRepository } from "./memory-release-policy-selection-repository.js";
import { releasePolicySelectionRepositoryFixture } from "./release-policy-selection-repository-fixtures.js";
import { releasePolicySelectionRepositoryConformanceCases } from "./release-policy-selection-repository-conformance.js";
describe("immutable target-owned selection memory repository / shared native contract", () => {
  for (const example of releasePolicySelectionRepositoryConformanceCases)
    it(example.name, () =>
      example.run((namespace) => ({
        repository: new MemoryReleasePolicySelectionRepository(),
        fixture: releasePolicySelectionRepositoryFixture(namespace),
      })),
    );
});
