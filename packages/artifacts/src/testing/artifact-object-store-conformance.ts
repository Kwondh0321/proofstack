import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ArtifactObjectReceipt, ArtifactObjectStore } from "../artifact-ports.js";

export interface ArtifactObjectStoreTestHarness {
  readonly dispose?: () => Promise<void>;
  readonly store: ArtifactObjectStore;
}

export type ArtifactObjectStoreTestFactory = (
  namespace: string,
) => ArtifactObjectStoreTestHarness | Promise<ArtifactObjectStoreTestHarness>;

export interface ArtifactObjectStoreConformanceCase {
  readonly name: string;
  readonly run: (factory: ArtifactObjectStoreTestFactory) => Promise<void>;
}

function receipt(value: Uint8Array): ArtifactObjectReceipt {
  return {
    sha256: createHash("sha256").update(value).digest("hex"),
    sizeBytes: value.byteLength,
  };
}

async function withStore(
  factory: ArtifactObjectStoreTestFactory,
  namespace: string,
  test: (store: ArtifactObjectStore) => Promise<void>,
): Promise<void> {
  const harness = await factory(namespace);
  try {
    await test(harness.store);
  } finally {
    await harness.dispose?.();
  }
}

export const artifactObjectStoreConformanceCases: readonly ArtifactObjectStoreConformanceCase[] = [
  {
    name: "creates an exact object receipt and never aliases caller-owned bytes",
    async run(factory) {
      await withStore(factory, "object_create", async (store) => {
        const objectKey = "artifacts/object_create/content";
        const value = Uint8Array.from([1, 2, 3]);

        assert.deepEqual(await store.putIfAbsent(objectKey, value), {
          created: true,
          receipt: receipt(value),
        });

        value[0] = 9;
        const firstRead = await store.get(objectKey);
        assert.deepEqual(firstRead, Uint8Array.from([1, 2, 3]));
        assert.ok(firstRead);
        firstRead[1] = 9;
        assert.deepEqual(await store.get(objectKey), Uint8Array.from([1, 2, 3]));
      });
    },
  },
  {
    name: "treats retries as idempotent and never overwrites an existing key",
    async run(factory) {
      await withStore(factory, "object_immutable", async (store) => {
        const objectKey = "artifacts/object_immutable/content";
        const original = Uint8Array.from([1, 2, 3]);
        const replacement = Uint8Array.from([4, 5]);
        const first = await store.putIfAbsent(objectKey, original);

        assert.deepEqual(await store.putIfAbsent(objectKey, original), {
          created: false,
          receipt: first.receipt,
        });
        assert.deepEqual(await store.putIfAbsent(objectKey, replacement), {
          created: false,
          receipt: first.receipt,
        });
        assert.deepEqual(await store.get(objectKey), original);
      });
    },
  },
  {
    name: "isolates exact keys without prefix or case matching",
    async run(factory) {
      await withStore(factory, "object_keys", async (store) => {
        const value = Uint8Array.from([7, 8, 9]);
        await store.putIfAbsent("artifacts/object_keys/content", value);

        assert.equal(await store.get("artifacts/object_keys"), null);
        assert.equal(await store.get("artifacts/object_keys/content-extra"), null);
        assert.equal(await store.get("artifacts/OBJECT_KEYS/content"), null);
      });
    },
  },
  {
    name: "serializes concurrent conditional creates without losing the winning receipt",
    async run(factory) {
      await withStore(factory, "object_race", async (store) => {
        const objectKey = "artifacts/object_race/content";
        const candidates = [Uint8Array.from([1, 1, 1]), Uint8Array.from([2, 2])];
        const results = await Promise.all(
          candidates.map((candidate) => store.putIfAbsent(objectKey, candidate)),
        );
        const stored = await store.get(objectKey);

        assert.ok(stored);
        assert.equal(results.filter((result) => result.created).length, 1);
        assert.equal(
          candidates.some((candidate) => Buffer.from(candidate).equals(Buffer.from(stored))),
          true,
        );
        for (const result of results) assert.deepEqual(result.receipt, receipt(stored));
      });
    },
  },
  {
    name: "reports deletion idempotently and permits an intentional key reuse after deletion",
    async run(factory) {
      await withStore(factory, "object_delete", async (store) => {
        const objectKey = "artifacts/object_delete/content";
        const first = Uint8Array.from([1, 2, 3]);
        const second = Uint8Array.from([4, 5]);
        await store.putIfAbsent(objectKey, first);

        assert.deepEqual(await store.delete(objectKey), { deleted: true });
        assert.deepEqual(await store.delete(objectKey), { deleted: false });
        assert.equal(await store.get(objectKey), null);
        assert.deepEqual(await store.putIfAbsent(objectKey, second), {
          created: true,
          receipt: receipt(second),
        });
        assert.deepEqual(await store.get(objectKey), second);
      });
    },
  },
] as const;
