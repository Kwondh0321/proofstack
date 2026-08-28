import { type EvidenceRepository, MemoryEvidenceRepository } from "@proofstack/core";
import {
  assertMigrationsCurrent,
  createPostgresPool,
  PostgresEvidenceRepository,
} from "@proofstack/postgres";
import type { ApiConfig } from "./config.js";

export interface EvidenceStorage {
  readonly checkReadiness: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly repository: EvidenceRepository;
}

interface StorageDependencies {
  readonly assertCurrent: typeof assertMigrationsCurrent;
  readonly createPool: typeof createPostgresPool;
}

const defaultDependencies: StorageDependencies = {
  assertCurrent: assertMigrationsCurrent,
  createPool: createPostgresPool,
};

export async function createEvidenceStorage(
  config: ApiConfig["storage"],
  onIdleError: (error: Error) => void,
  dependencies: StorageDependencies = defaultDependencies,
): Promise<EvidenceStorage> {
  if (config.mode === "memory") {
    return {
      checkReadiness: async () => undefined,
      close: async () => undefined,
      repository: new MemoryEvidenceRepository(),
    };
  }

  const pool = dependencies.createPool({
    applicationName: "proofstack-api",
    connectionString: config.databaseUrl,
    onIdleError,
  });
  try {
    await dependencies.assertCurrent(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    checkReadiness: () => dependencies.assertCurrent(pool),
    close: () => pool.end(),
    repository: new PostgresEvidenceRepository(pool),
  };
}
