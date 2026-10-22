import { describe, expect, it } from "vitest";
import { ARTIFACT_ENCRYPTION_VERSION } from "../artifact-ports.js";
import { artifactObjectStoreConformanceCases } from "./artifact-object-store-conformance.js";
import { MemoryArtifactObjectStore } from "./memory-artifact-object-store.js";

describe("MemoryArtifactObjectStore", () => {
  it("forks ciphertext into independent stores without losing absence or byte copies", async () => {
    const parent = new MemoryArtifactObjectStore();
    expect(await parent.fork().get("missing")).toBeNull();
    await parent.putIfAbsent("retained", Uint8Array.of(1, 2, 3));
    const fork = parent.fork();
    const bytes = await fork.get("retained");
    bytes![0] = 9;
    expect(await fork.get("retained")).toEqual(Uint8Array.of(1, 2, 3));
    await fork.delete("retained");
    await fork.putIfAbsent("new", Uint8Array.of(4));
    expect(await parent.get("retained")).toEqual(Uint8Array.of(1, 2, 3));
    expect(await parent.get("new")).toBeNull();
    await parent.delete("retained");
    expect(await fork.get("new")).toEqual(Uint8Array.of(4));
  });
  it("keeps the persisted encryption plan version explicit", () => {
    expect(ARTIFACT_ENCRYPTION_VERSION).toBe("a256gcm-v1");
  });

  for (const testCase of artifactObjectStoreConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(() => ({ store: new MemoryArtifactObjectStore() }));
    });
  }
});
