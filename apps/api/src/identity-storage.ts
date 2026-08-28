import {
  assertMigrationsCurrent,
  createPostgresPool,
  PostgresApiKeyCredentialRepository,
} from "@proofstack/postgres";
import type { ApiKeyCredentialLookup, ApiKeyCredentialStore } from "@proofstack/identity";

export type WorkloadCredentialRepository = ApiKeyCredentialLookup & ApiKeyCredentialStore;

export interface IdentityStorage {
  readonly checkReadiness: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly repository: WorkloadCredentialRepository;
}

interface IdentityStorageDependencies {
  readonly assertCurrent: typeof assertMigrationsCurrent;
  readonly createPool: typeof createPostgresPool;
  readonly createRepository: (
    pool: ReturnType<typeof createPostgresPool>,
  ) => WorkloadCredentialRepository;
}

const defaultDependencies: IdentityStorageDependencies = {
  assertCurrent: assertMigrationsCurrent,
  createPool: createPostgresPool,
  createRepository: (pool) => new PostgresApiKeyCredentialRepository(pool),
};

async function checkIdentityReadiness(
  pool: ReturnType<typeof createPostgresPool>,
  repository: WorkloadCredentialRepository,
  dependencies: IdentityStorageDependencies,
): Promise<void> {
  await dependencies.assertCurrent(pool);
  await repository.findActiveByPrefix("readiness");
}

export async function createIdentityStorage(
  databaseUrl: string,
  onIdleError: (error: Error) => void,
  dependencies: IdentityStorageDependencies = defaultDependencies,
): Promise<IdentityStorage> {
  const pool = dependencies.createPool({
    applicationName: "proofstack-identity",
    connectionString: databaseUrl,
    maxConnections: 5,
    onIdleError,
  });
  const repository = dependencies.createRepository(pool);
  try {
    await checkIdentityReadiness(pool, repository, dependencies);
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    checkReadiness: () => checkIdentityReadiness(pool, repository, dependencies),
    close: () => pool.end(),
    repository,
  };
}
