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
  PostgresArtifactCatalogRepository,
  PostgresEvidenceRepository,
  PostgresRegressionVersionRepository,
} from "@proofstack/postgres";
import { createS3ArtifactObjectStore } from "@proofstack/s3";
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

type ManagedArtifactObjectStore = ArtifactObjectStore & {
  readonly destroy: () => void;
};

type ArtifactObjectStoreFactory = (
  ...parameters: Parameters<typeof createS3ArtifactObjectStore>
) => ManagedArtifactObjectStore;

interface StorageDependencies {
  readonly assertCurrent: typeof assertMigrationsCurrent;
  readonly createObjectStore: ArtifactObjectStoreFactory;
  readonly createPool: typeof createPostgresPool;
}

const defaultDependencies: StorageDependencies = {
  assertCurrent: assertMigrationsCurrent,
  createObjectStore: createS3ArtifactObjectStore,
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
  let persistentObjects: ManagedArtifactObjectStore | undefined;
  let artifacts: ApiArtifactStorage | undefined;
  try {
    await dependencies.assertCurrent(pool);
    if (config.artifacts.mode === "s3_local_keyring") {
      const keys = Object.fromEntries(
        Object.entries(config.artifacts.keys).map(([keyId, encoded]) => [
          keyId,
          Uint8Array.from(Buffer.from(encoded, "base64url")),
        ]),
      );
      const keyring = new LocalArtifactKeyring({
        activeKeyId: config.artifacts.activeKeyId,
        keys,
      });
      persistentObjects = dependencies.createObjectStore({
        allowInsecureLoopback: config.artifacts.allowInsecureLoopback,
        bucket: config.artifacts.bucket,
        ...(config.artifacts.endpoint ? { endpoint: config.artifacts.endpoint } : {}),
        ...(config.artifacts.expectedBucketOwner
          ? { expectedBucketOwner: config.artifacts.expectedBucketOwner }
          : {}),
        forcePathStyle: config.artifacts.forcePathStyle,
        region: config.artifacts.region,
      });
      artifacts = {
        catalog: new PostgresArtifactCatalogRepository(pool),
        encryption: new ArtifactCipher(keyring),
        identities: new SecureArtifactIdentityGenerator(),
        objects: persistentObjects,
      };
    }
  } catch (error) {
    persistentObjects?.destroy();
    await pool.end();
    throw error;
  }

  const regressionVersionRepository = new PostgresRegressionVersionRepository(pool);
  return {
    ...(artifacts ? { artifacts } : {}),
    checkReadiness: () => dependencies.assertCurrent(pool),
    close: async () => {
      persistentObjects?.destroy();
      await pool.end();
    },
    evidenceRepository: new PostgresEvidenceRepository(pool),
    interactionFixtureVersionRepository: regressionVersionRepository,
    regressionVersionRepository,
  };
}
