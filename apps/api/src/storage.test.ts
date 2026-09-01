import { MemoryEvaluationRepository, MemoryEvidenceRepository } from "@proofstack/core";
import {
  type createPostgresPool,
  MigrationRequiredError,
  PostgresArtifactCatalogRepository,
  PostgresEvaluationRepository,
  PostgresEvidenceRepository,
  PostgresReplayDefinitionRepository,
  PostgresReplayJobControlRepository,
  PostgresRegressionVersionRepository,
} from "@proofstack/postgres";
import {
  MemoryReplayDefinitionRepository,
  MemoryReplayJobRepository,
} from "@proofstack/replay/testing";
import { describe, expect, it, vi } from "vitest";
import { createApiStorage } from "./storage.js";

function postgresConfig() {
  return {
    artifacts: { mode: "disabled" as const },
    databaseUrl: "postgresql://runtime@127.0.0.1:5432/proofstack",
    mode: "postgres" as const,
  };
}

function persistentPostgresConfig() {
  return {
    artifacts: {
      activeKeyId: "key_primary",
      allowInsecureLoopback: true,
      bucket: "proofstack-artifacts",
      endpoint: "http://127.0.0.1:8333",
      forcePathStyle: true,
      keys: { key_primary: Buffer.alloc(32, 1).toString("base64url") },
      mode: "s3_local_keyring" as const,
      region: "us-east-1",
    },
    databaseUrl: "postgresql://runtime@127.0.0.1:5432/proofstack",
    mode: "postgres" as const,
  };
}

function fakeDependencies(options: { readonly assertCurrent?: () => Promise<void> } = {}) {
  const end = vi.fn(async () => undefined);
  const pool = { end } as unknown as ReturnType<typeof createPostgresPool>;
  const assertCurrent = vi.fn(options.assertCurrent ?? (async () => undefined));
  const createPool = vi.fn(() => pool);
  const objects = {
    delete: vi.fn(async () => ({ deleted: false })),
    destroy: vi.fn(),
    get: vi.fn(async () => null),
    putIfAbsent: vi.fn(async () => ({
      created: true,
      receipt: { sha256: "a".repeat(64), sizeBytes: 1 },
    })),
  };
  const createObjectStore = vi.fn(() => objects);
  return { assertCurrent, createObjectStore, createPool, end, objects, pool };
}

describe("createApiStorage", () => {
  it("keeps dependency-free memory adapters as the development default", async () => {
    const storage = await createApiStorage({ mode: "memory" }, vi.fn());

    expect(storage.evaluationRepository).toBeInstanceOf(MemoryEvaluationRepository);
    expect(storage.evidenceRepository).toBeInstanceOf(MemoryEvidenceRepository);
    expect(storage.interactionFixtureVersionRepository).toBe(storage.regressionVersionRepository);
    expect(storage.replayDefinitionRepository).toBeInstanceOf(MemoryReplayDefinitionRepository);
    expect(storage.replayJobControlRepository).toBeInstanceOf(MemoryReplayJobRepository);
    expect(storage.artifacts).toMatchObject({
      catalog: expect.any(Object),
      encryption: expect.any(Object),
      identities: expect.any(Object),
      objects: expect.any(Object),
    });
    await expect(storage.checkReadiness()).resolves.toBeUndefined();
    await expect(storage.close()).resolves.toBeUndefined();
  });

  it("verifies migrations before exposing a PostgreSQL repository", async () => {
    const adapters = fakeDependencies();
    const onIdleError = vi.fn();

    const storage = await createApiStorage(postgresConfig(), onIdleError, adapters);

    expect(storage.evaluationRepository).toBeInstanceOf(PostgresEvaluationRepository);
    expect(storage.evidenceRepository).toBeInstanceOf(PostgresEvidenceRepository);
    expect(storage.regressionVersionRepository).toBeInstanceOf(PostgresRegressionVersionRepository);
    expect(storage.replayDefinitionRepository).toBeInstanceOf(PostgresReplayDefinitionRepository);
    expect(storage.replayJobControlRepository).toBeInstanceOf(PostgresReplayJobControlRepository);
    expect(adapters.createPool).toHaveBeenCalledWith({
      applicationName: "proofstack-api",
      connectionString: postgresConfig().databaseUrl,
      onIdleError,
    });
    expect(adapters.assertCurrent).toHaveBeenCalledOnce();

    await storage.checkReadiness();
    expect(adapters.assertCurrent).toHaveBeenCalledTimes(2);
    await storage.close();
    expect(adapters.end).toHaveBeenCalledOnce();
  });

  it("composes a persistent PostgreSQL catalog, S3 object store, and stable keyring", async () => {
    const adapters = fakeDependencies();
    const storage = await createApiStorage(persistentPostgresConfig(), vi.fn(), adapters);

    expect(storage.artifacts?.catalog).toBeInstanceOf(PostgresArtifactCatalogRepository);
    expect(storage.artifacts).toMatchObject({
      encryption: expect.any(Object),
      identities: expect.any(Object),
      objects: adapters.objects,
    });
    expect(adapters.createObjectStore).toHaveBeenCalledWith({
      allowInsecureLoopback: true,
      bucket: "proofstack-artifacts",
      endpoint: "http://127.0.0.1:8333",
      forcePathStyle: true,
      region: "us-east-1",
    });

    await storage.close();
    expect(adapters.objects.destroy).toHaveBeenCalledOnce();
    expect(adapters.end).toHaveBeenCalledOnce();
  });

  it("closes PostgreSQL if persistent object storage construction fails", async () => {
    const adapters = fakeDependencies();
    const failure = new Error("invalid object storage");
    adapters.createObjectStore.mockImplementation(() => {
      throw failure;
    });

    await expect(createApiStorage(persistentPostgresConfig(), vi.fn(), adapters)).rejects.toBe(
      failure,
    );
    expect(adapters.end).toHaveBeenCalledOnce();
  });

  it("closes the pool when startup migration verification fails", async () => {
    const failure = new MigrationRequiredError(["0001_evidence_store"]);
    const adapters = fakeDependencies({
      assertCurrent: async () => {
        throw failure;
      },
    });

    await expect(createApiStorage(postgresConfig(), vi.fn(), adapters)).rejects.toBe(failure);
    expect(adapters.end).toHaveBeenCalledOnce();
  });
});
