import { describe, it } from "vitest";
import { releasePolicyRepositoryConformanceCases } from "./release-policy-repository-conformance.js";
import { createReleasePolicyRepositoryTestHarness } from "./release-policy-repository-fixtures.js";
import { MemoryReleasePolicyRepository } from "./memory-release-policy-repository.js";
import { releasePolicyLogicalRootConformanceCases } from "./release-policy-logical-root-conformance.js";

describe("MemoryReleasePolicyRepository conformance", () => {
  for (const conformanceCase of releasePolicyLogicalRootConformanceCases) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run((namespace) => ({
        ...createReleasePolicyRepositoryTestHarness(namespace),
        repository: new MemoryReleasePolicyRepository(),
      }));
    });
  }
  for (const conformanceCase of releasePolicyRepositoryConformanceCases) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run(createReleasePolicyRepositoryTestHarness);
    });
  }
});
