import { describe, it } from "vitest";
import { releaseCandidateRepositoryConformanceCases } from "./release-candidate-repository-conformance.js";
import { createReleaseCandidateRepositoryTestHarness } from "./release-candidate-repository-fixtures.js";

describe("MemoryReleaseCandidateRepository conformance", () => {
  for (const conformanceCase of releaseCandidateRepositoryConformanceCases) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run(createReleaseCandidateRepositoryTestHarness);
    });
  }
});
