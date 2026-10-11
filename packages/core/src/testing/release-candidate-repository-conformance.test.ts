import { describe, it } from "vitest";
import { MemoryReleaseCandidateRepository } from "./memory-release-candidate-repository.js";
import {
  releaseCandidateLogicalRootConformanceCases,
  releaseCandidateRepositoryConformanceCases,
} from "./release-candidate-repository-conformance.js";
import { createReleaseCandidateRepositoryTestHarness } from "./release-candidate-repository-fixtures.js";

describe("MemoryReleaseCandidateRepository conformance", () => {
  for (const conformanceCase of [
    ...releaseCandidateRepositoryConformanceCases,
    ...releaseCandidateLogicalRootConformanceCases,
  ]) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run((namespace) => ({
        ...createReleaseCandidateRepositoryTestHarness(namespace),
        repository: new MemoryReleaseCandidateRepository(),
      }));
    });
  }
});
