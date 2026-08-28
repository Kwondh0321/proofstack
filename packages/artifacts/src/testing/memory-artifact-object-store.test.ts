import { describe, expect, it } from "vitest";
import { ARTIFACT_ENCRYPTION_VERSION } from "../artifact-ports.js";
import { artifactObjectStoreConformanceCases } from "./artifact-object-store-conformance.js";
import { MemoryArtifactObjectStore } from "./memory-artifact-object-store.js";

describe("MemoryArtifactObjectStore", () => {
  it("keeps the persisted encryption plan version explicit", () => {
    expect(ARTIFACT_ENCRYPTION_VERSION).toBe("a256gcm-v1");
  });

  for (const testCase of artifactObjectStoreConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(() => ({ store: new MemoryArtifactObjectStore() }));
    });
  }
});
