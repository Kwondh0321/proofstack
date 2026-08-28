import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ARTIFACT_ENCRYPTION_VERSION } from "../artifact-ports.js";
import { MemoryArtifactObjectStore } from "./memory-artifact-object-store.js";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("MemoryArtifactObjectStore", () => {
  it("keeps the persisted encryption plan version explicit", () => {
    expect(ARTIFACT_ENCRYPTION_VERSION).toBe("a256gcm-v1");
  });

  it("creates one immutable object and returns an exact receipt", async () => {
    const store = new MemoryArtifactObjectStore();
    const value = Uint8Array.from([1, 2, 3]);

    await expect(store.putIfAbsent("objects/one", value)).resolves.toEqual({
      created: true,
      receipt: { sha256: sha256(value), sizeBytes: 3 },
    });
    value[0] = 9;
    await expect(store.get("objects/one")).resolves.toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("never overwrites an existing object", async () => {
    const store = new MemoryArtifactObjectStore();
    const original = Uint8Array.from([1, 2, 3]);
    const replacement = Uint8Array.from([4, 5]);
    await store.putIfAbsent("objects/one", original);

    await expect(store.putIfAbsent("objects/one", replacement)).resolves.toEqual({
      created: false,
      receipt: { sha256: sha256(original), sizeBytes: 3 },
    });
    await expect(store.get("objects/one")).resolves.toEqual(original);
  });

  it("returns defensive read copies and idempotent deletion state", async () => {
    const store = new MemoryArtifactObjectStore();
    await store.putIfAbsent("objects/one", Uint8Array.from([1, 2, 3]));

    const firstRead = await store.get("objects/one");
    expect(firstRead).not.toBeNull();
    if (firstRead) firstRead[0] = 9;
    await expect(store.get("objects/one")).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    await expect(store.delete("objects/one")).resolves.toEqual({ deleted: true });
    await expect(store.delete("objects/one")).resolves.toEqual({ deleted: false });
    await expect(store.get("objects/one")).resolves.toBeNull();
  });
});
