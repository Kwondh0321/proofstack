import { type EvidenceRepository, MemoryEvidenceRepository } from "@proofstack/core";
import {
  MemoryRegressionVersionRepository,
  type RegressionVersionRepository,
} from "@proofstack/datasets";
import {
  assertMigrationsCurrent,
  createPostgresPool,
  PostgresEvidenceRepository,
  PostgresRegressionVersionRepository,
} from "@proofstack/postgres";
import type { ApiConfig } from "./config.js";

export interface ApiStorage {
  readonly checkReadiness: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly evidenceRepository: EvidenceRepository;
  readonly regressionVersionRepository: RegressionVersionRepository;
}

interface StorageDependencies {
  readonly assertCurrent: typeof assertMigrationsCurrent;
  readonly createPool: typeof createPostgresPool;
}

const defaultDependencies: StorageDependencies = {
  assertCurrent: assertMigrationsCurrent,
  createPool: createPostgresPool,
};

export async function createApiStorage(
  config: ApiConfig["storage"],
  onIdleError: (error: Error) => void,
  dependencies: StorageDependencies = defaultDependencies,
): Promise<ApiStorage> {
  if (config.mode === "memory") {
    return {
      checkReadiness: async () => undefined,
      close: async () => undefined,
      evidenceRepository: new MemoryEvidenceRepository(),
      regressionVersionRepository: new MemoryRegressionVersionRepository(),
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
    evidenceRepository: new PostgresEvidenceRepository(pool),
    regressionVersionRepository: new PostgresRegressionVersionRepository(pool),
  };
}
