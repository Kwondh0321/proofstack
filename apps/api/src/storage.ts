import { randomBytes } from "node:crypto";
import {
  type ArtifactCatalogRepository,
  ArtifactCipher,
  type ArtifactObjectStore,
  LocalArtifactKeyring,
  SecureArtifactIdentityGenerator,
} from "@proofstack/artifacts";
import { MemoryArtifactObjectStore } from "@proofstack/artifacts/testing";
import { type EvidenceRepository, MemoryEvidenceRepository } from "@proofstack/core";
import type {
  InteractionFixtureVersionRepository,
  RegressionVersionRepository,
} from "@proofstack/datasets";
import {
  assertMigrationsCurrent,
  createPostgresPool,
  PostgresEvidenceRepository,
  PostgresRegressionVersionRepository,
} from "@proofstack/postgres";
import type { ApiConfig } from "./config.js";
import { createMemoryInteractionStorage } from "./memory-interaction-storage.js";

export interface ApiArtifactStorage {
  readonly catalog: ArtifactCatalogRepository;
  readonly encryption: ArtifactCipher;
  readonly identities: SecureArtifactIdentityGenerator;
  readonly objects: ArtifactObjectStore;
}

export interface ApiStorage {
  readonly artifacts?: ApiArtifactStorage;
  readonly checkReadiness: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly evidenceRepository: EvidenceRepository;
  readonly interactionFixtureVersionRepository?: InteractionFixtureVersionRepository;
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
    const interactionStorage = createMemoryInteractionStorage();
    const keyring = new LocalArtifactKeyring({
      activeKeyId: "key_memory_process",
      keys: { key_memory_process: randomBytes(32) },
    });
    return {
      artifacts: {
        catalog: interactionStorage.artifactCatalogRepository,
        encryption: new ArtifactCipher(keyring),
        identities: new SecureArtifactIdentityGenerator(),
        objects: new MemoryArtifactObjectStore(),
      },
      checkReadiness: async () => undefined,
      close: async () => undefined,
      evidenceRepository: new MemoryEvidenceRepository(),
      interactionFixtureVersionRepository: interactionStorage.regressionVersionRepository,
      regressionVersionRepository: interactionStorage.regressionVersionRepository,
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

  const regressionVersionRepository = new PostgresRegressionVersionRepository(pool);
  return {
    checkReadiness: () => dependencies.assertCurrent(pool),
    close: () => pool.end(),
    evidenceRepository: new PostgresEvidenceRepository(pool),
    interactionFixtureVersionRepository: regressionVersionRepository,
    regressionVersionRepository,
  };
}
