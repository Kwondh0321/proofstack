import { describe, it } from "vitest";
import {
  comparisonLogicalRootConformanceCases,
  comparisonRepositoryConformanceCases,
} from "./comparison-repository-conformance.js";
import { createComparisonRepositoryTestHarness } from "./comparison-repository-fixtures.js";
import { MemoryComparisonRepository } from "./memory-comparison-repository.js";

describe("MemoryComparisonRepository conformance", () => {
  for (const conformanceCase of [
    ...comparisonRepositoryConformanceCases,
    ...comparisonLogicalRootConformanceCases,
  ]) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run((namespace) => ({
        ...createComparisonRepositoryTestHarness(namespace),
        repository: new MemoryComparisonRepository(),
      }));
    });
  }
});
