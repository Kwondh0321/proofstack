import {
  assertMigrationsCurrent,
  createPostgresPool,
  PostgresApiKeyCredentialRepository,
  PostgresOidcIdentityRepository,
} from "@proofstack/postgres";
import type {
  ApiKeyCredentialLookup,
  ApiKeyCredentialStore,
  BrowserSessionCreator,
  BrowserSessionLookup,
  BrowserSessionRevoker,
  OidcBindingLookup,
  OidcLoginTransactionStore,
} from "@proofstack/identity";

export type WorkloadCredentialRepository = ApiKeyCredentialLookup & ApiKeyCredentialStore;
export type OidcIdentityRepository = OidcBindingLookup &
  OidcLoginTransactionStore &
  BrowserSessionCreator &
  BrowserSessionLookup &
  BrowserSessionRevoker;

export interface IdentityStorage {
  readonly checkReadiness: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly oidcRepository: OidcIdentityRepository;
  readonly repository: WorkloadCredentialRepository;
}

interface IdentityStorageDependencies {
  readonly assertCurrent: typeof assertMigrationsCurrent;
  readonly createPool: typeof createPostgresPool;
  readonly createOidcRepository: (
    pool: ReturnType<typeof createPostgresPool>,
  ) => OidcIdentityRepository;
  readonly createRepository: (
    pool: ReturnType<typeof createPostgresPool>,
  ) => WorkloadCredentialRepository;
}

const defaultDependencies: IdentityStorageDependencies = {
  assertCurrent: assertMigrationsCurrent,
  createPool: createPostgresPool,
  createOidcRepository: (pool) => new PostgresOidcIdentityRepository(pool),
  createRepository: (pool) => new PostgresApiKeyCredentialRepository(pool),
};

async function checkIdentityReadiness(
  pool: ReturnType<typeof createPostgresPool>,
  repository: WorkloadCredentialRepository,
  oidcRepository: OidcIdentityRepository,
  dependencies: IdentityStorageDependencies,
): Promise<void> {
  await dependencies.assertCurrent(pool);
  await repository.findActiveByPrefix("readiness");
  await oidcRepository.findActiveByIssuerSubject(
    "https://readiness.invalid",
    "proofstack-readiness",
  );
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
  const oidcRepository = dependencies.createOidcRepository(pool);
  try {
    await checkIdentityReadiness(pool, repository, oidcRepository, dependencies);
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    checkReadiness: () => checkIdentityReadiness(pool, repository, oidcRepository, dependencies),
    close: () => pool.end(),
    oidcRepository,
    repository,
  };
}
