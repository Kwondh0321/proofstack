import { describe, it } from "vitest";
import {
  artifactCatalogRepositoryConformanceCases,
  MemoryArtifactCatalogRepository,
} from "./testing/index.js";

describe("MemoryArtifactCatalogRepository contract", () => {
  for (const testCase of artifactCatalogRepositoryConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(() => ({ repository: new MemoryArtifactCatalogRepository() }));
    });
  }
});
