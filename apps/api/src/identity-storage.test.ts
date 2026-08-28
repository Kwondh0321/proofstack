import type { createPostgresPool, PostgresApiKeyCredentialRepository } from "@proofstack/postgres";
import { MigrationRequiredError } from "@proofstack/postgres";
import { describe, expect, it, vi } from "vitest";
import { createIdentityStorage } from "./identity-storage.js";

const DATABASE_URL = "postgresql://identity@127.0.0.1:5432/proofstack";

function fakeDependencies(
  options: {
    readonly assertCurrent?: () => Promise<void>;
    readonly findActiveByPrefix?: () => Promise<null>;
  } = {},
) {
  const end = vi.fn(async () => undefined);
  const pool = { end } as unknown as ReturnType<typeof createPostgresPool>;
  const assertCurrent = vi.fn(options.assertCurrent ?? (async () => undefined));
  const findActiveByPrefix = vi.fn(options.findActiveByPrefix ?? (async () => null));
  const repository = { findActiveByPrefix } as unknown as PostgresApiKeyCredentialRepository;
  const createPool = vi.fn(() => pool);
  const createRepository = vi.fn(() => repository);
  return {
    assertCurrent,
    createPool,
    createRepository,
    end,
    findActiveByPrefix,
    pool,
    repository,
  };
}

describe("createIdentityStorage", () => {
  it("verifies migrations and exact lookup privileges before exposure", async () => {
    const adapters = fakeDependencies();
    const onIdleError = vi.fn();

    const storage = await createIdentityStorage(DATABASE_URL, onIdleError, adapters);

    expect(adapters.createPool).toHaveBeenCalledWith({
      applicationName: "proofstack-identity",
      connectionString: DATABASE_URL,
      maxConnections: 5,
      onIdleError,
    });
    expect(adapters.createRepository).toHaveBeenCalledWith(adapters.pool);
    expect(adapters.assertCurrent).toHaveBeenCalledOnce();
    expect(adapters.findActiveByPrefix).toHaveBeenCalledWith("readiness");

    await storage.checkReadiness();
    expect(adapters.assertCurrent).toHaveBeenCalledTimes(2);
    expect(adapters.findActiveByPrefix).toHaveBeenCalledTimes(2);
    await storage.close();
    expect(adapters.end).toHaveBeenCalledOnce();
  });

  it("closes the pool when migration verification fails", async () => {
    const failure = new MigrationRequiredError(["0004_workload_identity"]);
    const adapters = fakeDependencies({
      assertCurrent: async () => {
        throw failure;
      },
    });

    await expect(createIdentityStorage(DATABASE_URL, vi.fn(), adapters)).rejects.toBe(failure);
    expect(adapters.findActiveByPrefix).not.toHaveBeenCalled();
    expect(adapters.end).toHaveBeenCalledOnce();
  });

  it("closes the pool when lookup privileges are unavailable", async () => {
    const failure = new Error("permission denied");
    const adapters = fakeDependencies({
      findActiveByPrefix: async () => {
        throw failure;
      },
    });

    await expect(createIdentityStorage(DATABASE_URL, vi.fn(), adapters)).rejects.toBe(failure);
    expect(adapters.end).toHaveBeenCalledOnce();
  });
});
