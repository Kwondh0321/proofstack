import { evidenceRepositoryConformanceCases, MemoryEvidenceRepository } from "../testing/index.js";
import { describe, it } from "vitest";

describe("MemoryEvidenceRepository contract", () => {
  for (const testCase of evidenceRepositoryConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(() => ({ repository: new MemoryEvidenceRepository() }));
    });
  }
});
