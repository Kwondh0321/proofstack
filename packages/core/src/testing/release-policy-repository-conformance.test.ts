import { describe, it } from "vitest";
import { releasePolicyRepositoryConformanceCases } from "./release-policy-repository-conformance.js";
import { createReleasePolicyRepositoryTestHarness } from "./release-policy-repository-fixtures.js";

describe("MemoryReleasePolicyRepository conformance", () => {
  for (const conformanceCase of releasePolicyRepositoryConformanceCases) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run(createReleasePolicyRepositoryTestHarness);
    });
  }
});
