import {
  MemoryComparisonRepository,
  MemoryEvaluationRepository,
  MemoryEvidenceRepository,
  MemoryModelAssuranceRepository,
  MemoryReleaseCandidateRepository,
  MemoryReleasePolicyRepository,
} from "@proofstack/core";
import {
  type createPostgresPool,
  MigrationRequiredError,
  PostgresArtifactCatalogRepository,
  PostgresComparisonRepository,
  PostgresEvaluationRepository,
  PostgresEvidenceRepository,
  PostgresModelAssuranceRepository,
  PostgresRegressionVersionRepository,
  PostgresReleaseCandidateRepository,
  PostgresReleasePolicyRepository,
  PostgresReplayDefinitionRepository,
  PostgresReplayJobControlRepository,
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
    policyAuthorDatabaseUrl: "postgresql://policy-author@127.0.0.1:5432/proofstack",
    policyEvaluationControlDatabaseUrl: "postgresql://policy-control@127.0.0.1:5432/proofstack",
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
    policyAuthorDatabaseUrl: "postgresql://policy-author@127.0.0.1:5432/proofstack",
    policyEvaluationControlDatabaseUrl: "postgresql://policy-control@127.0.0.1:5432/proofstack",
  };
}

function fakeDependencies(options: { readonly assertCurrent?: () => Promise<void> } = {}) {
  const end = vi.fn(async () => undefined);
  const policyAuthorEnd = vi.fn(async () => undefined);
  const policyControlEnd = vi.fn(async () => undefined);
  const policyControlPool = { end: policyControlEnd } as unknown as ReturnType<
    typeof createPostgresPool
  >;
  const createPolicyPool = vi.fn(() => policyControlPool);
  const assertPolicyControl = vi.fn(async () => undefined);
  const pool = { end } as unknown as ReturnType<typeof createPostgresPool>;
  const policyAuthorPool = {
    end: policyAuthorEnd,
  } as unknown as ReturnType<typeof createPostgresPool>;
  const assertCurrent = vi.fn(options.assertCurrent ?? (async () => undefined));
  const createPool = vi.fn((value: Parameters<typeof createPostgresPool>[0]) =>
    value.applicationName === "proofstack-api-policy-author" ? policyAuthorPool : pool,
  );
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
  return {
    policyControlEnd,
    policyControlPool,
    createPolicyPool,
    assertPolicyControl,
    assertCurrent,
    createObjectStore,
    createPool,
    end,
    objects,
    policyAuthorEnd,
    policyAuthorPool,
    pool,
  };
}

describe("createApiStorage", () => {
  it("keeps dependency-free memory adapters as the development default", async () => {
    const storage = await createApiStorage({ mode: "memory" }, vi.fn());
    expect(storage.policyEvaluation.control).toBe(storage.policyEvaluation.snapshots);
    expect(storage.policyEvaluation.results).toBe(storage.policyEvaluation.snapshots);

    expect(storage.comparisonRepository).toBeInstanceOf(MemoryComparisonRepository);
    expect(storage.evaluationRepository).toBeInstanceOf(MemoryEvaluationRepository);
    expect(storage.evidenceRepository).toBeInstanceOf(MemoryEvidenceRepository);
    expect(storage.modelAssuranceRepository).toBeInstanceOf(MemoryModelAssuranceRepository);
    expect(storage.releaseCandidateRepository).toBeInstanceOf(MemoryReleaseCandidateRepository);
    expect(storage.releasePolicyRepository).toBeInstanceOf(MemoryReleasePolicyRepository);
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

    expect(storage.comparisonRepository).toBeInstanceOf(PostgresComparisonRepository);
    expect(storage.evaluationRepository).toBeInstanceOf(PostgresEvaluationRepository);
    expect(storage.evidenceRepository).toBeInstanceOf(PostgresEvidenceRepository);
    expect(storage.modelAssuranceRepository).toBeInstanceOf(PostgresModelAssuranceRepository);
    expect(storage.regressionVersionRepository).toBeInstanceOf(PostgresRegressionVersionRepository);
    expect(storage.releaseCandidateRepository).toBeInstanceOf(PostgresReleaseCandidateRepository);
    expect(storage.releasePolicyRepository).toBeInstanceOf(PostgresReleasePolicyRepository);
    expect(storage.replayDefinitionRepository).toBeInstanceOf(PostgresReplayDefinitionRepository);
    expect(storage.replayJobControlRepository).toBeInstanceOf(PostgresReplayJobControlRepository);
    expect(adapters.createPool).toHaveBeenCalledWith({
      applicationName: "proofstack-api",
      connectionString: postgresConfig().databaseUrl,
      onIdleError,
    });
    expect(adapters.createPool).toHaveBeenCalledWith({
      applicationName: "proofstack-api-policy-author",
      connectionString: postgresConfig().policyAuthorDatabaseUrl,
      onIdleError,
    });
    expect(adapters.assertCurrent).toHaveBeenNthCalledWith(1, adapters.pool);
    expect(adapters.assertCurrent).toHaveBeenNthCalledWith(2, adapters.policyAuthorPool);
    expect(adapters.assertCurrent).toHaveBeenNthCalledWith(3, adapters.policyControlPool);
    expect(adapters.assertPolicyControl).toHaveBeenCalledWith(
      adapters.policyControlPool,
      postgresConfig().policyEvaluationControlDatabaseUrl,
    );

    await storage.checkReadiness();
    expect(adapters.assertCurrent).toHaveBeenCalledTimes(6);
    await storage.close();
    expect(adapters.end).toHaveBeenCalledOnce();
    expect(adapters.policyAuthorEnd).toHaveBeenCalledOnce();
    expect(adapters.policyControlEnd).toHaveBeenCalledOnce();
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
    expect(adapters.policyAuthorEnd).toHaveBeenCalledOnce();
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
    expect(adapters.policyAuthorEnd).toHaveBeenCalledOnce();
  });

  it("drains preceding pools when policy control pool construction fails", async () => {
    const adapters = fakeDependencies(),
      failure = new Error("test policy pool construction");
    adapters.createPolicyPool.mockImplementation(() => {
      throw failure;
    });
    await expect(createApiStorage(postgresConfig(), vi.fn(), adapters)).rejects.toBe(failure);
    expect(adapters.end).toHaveBeenCalledOnce();
    expect(adapters.policyAuthorEnd).toHaveBeenCalledOnce();
    expect(adapters.policyControlEnd).not.toHaveBeenCalled();
  });
  it("rejects changing role authority on readiness and still closes every owned pool", async () => {
    const adapters = fakeDependencies(),
      failure = new Error("test effective role changed");
    const storage = await createApiStorage(postgresConfig(), vi.fn(), adapters);
    adapters.assertPolicyControl.mockRejectedValue(failure);
    await expect(storage.checkReadiness()).rejects.toBe(failure);
    await storage.close();
    expect(adapters.end).toHaveBeenCalledOnce();
    expect(adapters.policyAuthorEnd).toHaveBeenCalledOnce();
    expect(adapters.policyControlEnd).toHaveBeenCalledOnce();
  });
  it("preserves initialization and cleanup failures after draining all three pools", async () => {
    const adapters = fakeDependencies(),
      failure = new Error("test wrong role"),
      cleanup = new Error("test failed close");
    adapters.assertPolicyControl.mockRejectedValue(failure);
    adapters.policyControlEnd.mockRejectedValue(cleanup);
    const outcome = await createApiStorage(postgresConfig(), vi.fn(), adapters).catch(
      (error) => error,
    );
    expect(outcome).toBeInstanceOf(AggregateError);
    expect(outcome.errors).toEqual([failure, cleanup]);
    expect(adapters.end).toHaveBeenCalledOnce();
    expect(adapters.policyAuthorEnd).toHaveBeenCalledOnce();
    expect(adapters.policyControlEnd).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "drains pools even if object cleanup throws (multiple failures %s)",
    async (multiple) => {
      const adapters = fakeDependencies(),
        failure = new Error("test object close"),
        cleanup = new Error("test policy close");
      const storage = await createApiStorage(persistentPostgresConfig(), vi.fn(), adapters);
      adapters.objects.destroy.mockImplementation(() => {
        throw failure;
      });
      if (multiple) adapters.policyControlEnd.mockRejectedValue(cleanup);
      const outcome = await storage.close().catch((error) => error);
      if (multiple) {
        expect(outcome).toBeInstanceOf(AggregateError);
        expect(outcome.errors).toEqual([failure, cleanup]);
      } else expect(outcome).toBe(failure);
      expect(adapters.end).toHaveBeenCalledOnce();
      expect(adapters.policyAuthorEnd).toHaveBeenCalledOnce();
      expect(adapters.policyControlEnd).toHaveBeenCalledOnce();
    },
  );
  it("closes the pool when startup migration verification fails", async () => {
    const failure = new MigrationRequiredError(["0001_evidence_store"]);
    const adapters = fakeDependencies({
      assertCurrent: async () => {
        throw failure;
      },
    });

    await expect(createApiStorage(postgresConfig(), vi.fn(), adapters)).rejects.toBe(failure);
    expect(adapters.end).toHaveBeenCalledOnce();
    expect(adapters.policyAuthorEnd).toHaveBeenCalledOnce();
  });
});
