import { MemoryEvidenceRepository } from "@proofstack/core";
import {
  type createPostgresPool,
  MigrationRequiredError,
  PostgresEvidenceRepository,
} from "@proofstack/postgres";
import { describe, expect, it, vi } from "vitest";
import { createEvidenceStorage } from "./storage.js";

function postgresConfig() {
  return {
    databaseUrl: "postgresql://runtime@127.0.0.1:5432/proofstack",
    mode: "postgres" as const,
  };
}

function fakeDependencies(options: { readonly assertCurrent?: () => Promise<void> } = {}) {
  const end = vi.fn(async () => undefined);
  const pool = { end } as unknown as ReturnType<typeof createPostgresPool>;
  const assertCurrent = vi.fn(options.assertCurrent ?? (async () => undefined));
  const createPool = vi.fn(() => pool);
  return { assertCurrent, createPool, end, pool };
}

describe("createEvidenceStorage", () => {
  it("keeps the dependency-free memory adapter as the development default", async () => {
    const storage = await createEvidenceStorage({ mode: "memory" }, vi.fn());

    expect(storage.repository).toBeInstanceOf(MemoryEvidenceRepository);
    await expect(storage.checkReadiness()).resolves.toBeUndefined();
    await expect(storage.close()).resolves.toBeUndefined();
  });

  it("verifies migrations before exposing a PostgreSQL repository", async () => {
    const adapters = fakeDependencies();
    const onIdleError = vi.fn();

    const storage = await createEvidenceStorage(postgresConfig(), onIdleError, adapters);

    expect(storage.repository).toBeInstanceOf(PostgresEvidenceRepository);
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

  it("closes the pool when startup migration verification fails", async () => {
    const failure = new MigrationRequiredError(["0001_evidence_store"]);
    const adapters = fakeDependencies({
      assertCurrent: async () => {
        throw failure;
      },
    });

    await expect(createEvidenceStorage(postgresConfig(), vi.fn(), adapters)).rejects.toBe(failure);
    expect(adapters.end).toHaveBeenCalledOnce();
  });
});
