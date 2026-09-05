import { describe, it } from "vitest";
import { comparisonRepositoryConformanceCases } from "./comparison-repository-conformance.js";
import { createComparisonRepositoryTestHarness } from "./comparison-repository-fixtures.js";

describe("MemoryComparisonRepository conformance", () => {
  for (const conformanceCase of comparisonRepositoryConformanceCases) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run(createComparisonRepositoryTestHarness);
    });
  }
});
