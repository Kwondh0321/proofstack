import type {
  ArtifactCatalogRepository,
  ArtifactKeyReferenceSummary,
  ArtifactObjectStore,
} from "@proofstack/artifacts";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactMaintenanceConfig, ArtifactMaintenanceCommandName } from "./config.js";
import {
  type ArtifactMaintenanceDatabase,
  type ArtifactMaintenanceObjectStorage,
  type ArtifactMaintenanceRuntimeDependencies,
  runArtifactMaintenance,
} from "./runtime.js";

const NOW = new Date("2026-08-29T00:00:00.000Z");
const KEY_MATERIAL = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

function config(command: ArtifactMaintenanceCommandName): ArtifactMaintenanceConfig {
  const base = {
    batchLimit: 7,
    databaseUrl: "postgresql://artifact@127.0.0.1:5432/proofstack",
    deploymentEnvironment: "test" as const,
    scope: {
      environmentId: "env_test",
      operatorPrincipalId: "svc_artifact_maintenance",
      projectId: "prj_test",
      tenantId: "ten_test",
    },
  };
  const objectStorage = {
    bucket: "proofstack-artifacts",
    endpoint: "http://127.0.0.1:8333",
    forcePathStyle: true,
    region: "us-east-1",
  };
  if (command === "key-status") {
    return {
      ...base,
      command,
      keyring: { activeKeyId: "key_primary", keys: { key_primary: KEY_MATERIAL } },
    };
  }
  if (command === "reconcile") {
    return {
      ...base,
      abandonedBefore: "2026-08-28T00:00:00.000Z",
      command,
      keyring: { activeKeyId: "key_primary", keys: { key_primary: KEY_MATERIAL } },
      objectStorage,
    };
  }
  if (command === "cleanup-abandoned") {
    return {
      ...base,
      abandonedBefore: "2026-08-28T00:00:00.000Z",
      command,
      objectStorage,
    };
  }
  return { ...base, command, objectStorage };
}

function unexpected(): Promise<never> {
  return Promise.reject(new Error("unexpected catalog operation"));
}

function catalog(overrides: Partial<ArtifactCatalogRepository> = {}): ArtifactCatalogRepository {
  return {
    activate: vi.fn(unexpected),
    find: vi.fn(unexpected),
    listAbandoned: vi.fn(async () => []),
    listExpired: vi.fn(async () => []),
    listKeyReferences: vi.fn(async () => []),
    listPendingPurge: vi.fn(async () => []),
    recordPurge: vi.fn(unexpected),
    reserve: vi.fn(unexpected),
    tombstone: vi.fn(unexpected),
    ...overrides,
  };
}

function database(
  artifactCatalog: ArtifactCatalogRepository,
  overrides: Partial<ArtifactMaintenanceDatabase> = {},
): ArtifactMaintenanceDatabase {
  return {
    assertCurrent: vi.fn(async () => undefined),
    catalog: artifactCatalog,
    close: vi.fn(async () => undefined),
    idleErrors: () => [],
    ...overrides,
  };
}

function objectStorage(
  overrides: Partial<ArtifactMaintenanceObjectStorage> = {},
): ArtifactMaintenanceObjectStorage {
  const store: ArtifactObjectStore = {
    delete: vi.fn(async () => ({ deleted: false })),
    get: vi.fn(async () => null),
    putIfAbsent: vi.fn(unexpected),
  };
  return {
    close: vi.fn(async () => undefined),
    store,
    ...overrides,
  };
}

function dependencies(
  artifactDatabase: ArtifactMaintenanceDatabase,
  storage: ArtifactMaintenanceObjectStorage,
): ArtifactMaintenanceRuntimeDependencies {
  return {
    clock: { now: () => new Date(NOW) },
    createRequestId: () => "req_artifact_maintenance_test",
    openDatabase: vi.fn(() => artifactDatabase),
    openObjectStorage: vi.fn(() => storage),
  };
}

describe("artifact maintenance runtime", () => {
  it("checks key references without opening object storage", async () => {
    const artifactCatalog = catalog();
    const artifactDatabase = database(artifactCatalog);
    const storage = objectStorage();
    const runtime = dependencies(artifactDatabase, storage);

    await expect(runArtifactMaintenance(config("key-status"), runtime)).resolves.toEqual({
      command: "key-status",
      result: {
        activeKeyId: "key_primary",
        keys: [
          {
            active: true,
            configured: true,
            counts: { available: 0, purged: 0, reserved: 0, tombstoned: 0, total: 0 },
            keyId: "key_primary",
          },
        ],
      },
      status: "ok",
    });
    expect(runtime.openObjectStorage).not.toHaveBeenCalled();
    expect(artifactDatabase.assertCurrent).toHaveBeenCalledOnce();
    expect(artifactDatabase.close).toHaveBeenCalledOnce();
  });

  it("returns attention when catalog rows reference an unavailable key", async () => {
    const missingReference: ArtifactKeyReferenceSummary = {
      counts: { available: 1, purged: 0, reserved: 0, tombstoned: 0, total: 1 },
      keyId: "key_missing",
    };
    const artifactCatalog = catalog({
      listKeyReferences: vi.fn(async () => [missingReference]),
    });
    const artifactDatabase = database(artifactCatalog);

    const outcome = await runArtifactMaintenance(
      config("key-status"),
      dependencies(artifactDatabase, objectStorage()),
    );

    expect(outcome.status).toBe("attention");
    expect("keys" in outcome.result && outcome.result.keys).toContainEqual({
      active: false,
      configured: false,
      counts: missingReference.counts,
      keyId: "key_missing",
    });
  });

  it.each([
    ["cleanup-abandoned", { failedArtifactIds: [], inspected: 0, purged: 0, tombstoned: 0 }],
    ["reconcile", { activated: 0, failedArtifactIds: [], inspected: 0, missingObjects: 0 }],
    ["retention", { failedArtifactIds: [], inspected: 0, purged: 0, tombstoned: 0 }],
    ["retry-purges", { failedArtifactIds: [], inspected: 0, purged: 0, tombstoned: 0 }],
  ] as const)("runs and closes storage for %s", async (command, result) => {
    const artifactCatalog = catalog();
    const artifactDatabase = database(artifactCatalog);
    const storage = objectStorage();
    const runtime = dependencies(artifactDatabase, storage);

    await expect(runArtifactMaintenance(config(command), runtime)).resolves.toEqual({
      command,
      result,
      status: "ok",
    });
    expect(runtime.openObjectStorage).toHaveBeenCalledOnce();
    expect(storage.close).toHaveBeenCalledOnce();
    expect(artifactDatabase.close).toHaveBeenCalledOnce();
  });

  it("does not open object storage when migration verification fails", async () => {
    const migrationError = new Error("migrations are pending");
    const artifactDatabase = database(catalog(), {
      assertCurrent: vi.fn(async () => {
        throw migrationError;
      }),
    });
    const runtime = dependencies(artifactDatabase, objectStorage());

    await expect(runArtifactMaintenance(config("retention"), runtime)).rejects.toBe(migrationError);
    expect(runtime.openObjectStorage).not.toHaveBeenCalled();
    expect(artifactDatabase.close).toHaveBeenCalledOnce();
  });

  it("fails a successful command when the pool reported an idle error", async () => {
    const idleError = new Error("idle database connection failed");
    const artifactDatabase = database(catalog(), { idleErrors: () => [idleError] });

    await expect(
      runArtifactMaintenance(
        config("retry-purges"),
        dependencies(artifactDatabase, objectStorage()),
      ),
    ).rejects.toBe(idleError);
  });

  it("preserves operation and cleanup failures in one aggregate error", async () => {
    const operationError = new Error("catalog failed");
    const storageError = new Error("storage close failed");
    const databaseError = new Error("database close failed");
    const artifactDatabase = database(
      catalog({
        listExpired: vi.fn(async () => {
          throw operationError;
        }),
      }),
      {
        close: vi.fn(async () => {
          throw databaseError;
        }),
      },
    );
    const storage = objectStorage({
      close: vi.fn(async () => {
        throw storageError;
      }),
    });

    const promise = runArtifactMaintenance(
      config("retention"),
      dependencies(artifactDatabase, storage),
    );
    await expect(promise).rejects.toBeInstanceOf(AggregateError);
    await expect(promise).rejects.toMatchObject({
      errors: [operationError, storageError, databaseError],
    });
  });
});
