import { randomBytes } from "node:crypto";
import {
  type ArtifactCatalogRepository,
  ArtifactCipher,
  type ArtifactObjectStore,
  LocalArtifactKeyring,
  SecureArtifactIdentityGenerator,
} from "@proofstack/artifacts";
import { MemoryArtifactObjectStore } from "@proofstack/artifacts/testing";
import {
  type ComparisonRepository,
  type EvaluationRepository,
  type EvidenceRepository,
  MemoryComparisonRepository,
  MemoryEvaluationRepository,
  MemoryEvidenceRepository,
  MemoryModelAssuranceRepository,
  MemoryReleaseCandidateRepository,
  MemoryReleasePolicyRepository,
  type ModelAssuranceRepository,
  type ReleaseCandidateRepository,
  type ReleasePolicyRepository,
} from "@proofstack/core";
import type {
  InteractionFixtureVersionRepository,
  RegressionVersionRepository,
} from "@proofstack/datasets";
import { MemoryPolicyEvaluationJobRepository } from "@proofstack/core/testing";
import type {
  PolicyEvaluationJobControlRepository,
  PolicyEvaluationSnapshotReader,
  PolicyEvaluationResultReader,
} from "@proofstack/core";
import {
  assertMigrationsCurrent,
  createPostgresPool,
  createPolicyPostgresPool,
  assertPostgresPolicyControlRole,
  PostgresPolicyEvaluationJobControlRepository,
  PostgresPolicySnapshotRepository,
  PostgresPolicyEvaluationResultRepository,
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
import type { ReplayDefinitionRepository, ReplayJobControlRepository } from "@proofstack/replay";
import {
  MemoryReplayDefinitionRepository,
  MemoryReplayJobRepository,
} from "@proofstack/replay/testing";
import { createS3ArtifactObjectStore } from "@proofstack/s3";
import type { ApiConfig } from "./config.js";
import { createMemoryInteractionStorage } from "./memory-interaction-storage.js";

export interface ApiPolicyEvaluationStorage {
  readonly control: PolicyEvaluationJobControlRepository;
  readonly snapshots: PolicyEvaluationSnapshotReader;
  readonly results: PolicyEvaluationResultReader;
}

export interface ApiArtifactStorage {
  readonly catalog: ArtifactCatalogRepository;
  readonly encryption: ArtifactCipher;
  readonly identities: SecureArtifactIdentityGenerator;
  readonly objects: ArtifactObjectStore;
}

export interface ApiStorage {
  readonly policyEvaluation: ApiPolicyEvaluationStorage;
  readonly artifacts?: ApiArtifactStorage;
  readonly checkReadiness: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly comparisonRepository: ComparisonRepository;
  readonly evaluationRepository: EvaluationRepository;
  readonly evidenceRepository: EvidenceRepository;
  readonly interactionFixtureVersionRepository?: InteractionFixtureVersionRepository;
  readonly regressionVersionRepository: RegressionVersionRepository;
  readonly modelAssuranceRepository: ModelAssuranceRepository;
  readonly releaseCandidateRepository: ReleaseCandidateRepository;
  readonly releasePolicyRepository: ReleasePolicyRepository;
  readonly replayDefinitionRepository: ReplayDefinitionRepository;
  readonly replayJobControlRepository: ReplayJobControlRepository;
}

type ManagedArtifactObjectStore = ArtifactObjectStore & {
  readonly destroy: () => void;
};

type ArtifactObjectStoreFactory = (
  ...parameters: Parameters<typeof createS3ArtifactObjectStore>
) => ManagedArtifactObjectStore;

interface StorageDependencies {
  readonly createPolicyPool: typeof createPolicyPostgresPool;
  readonly assertPolicyControl: typeof assertPostgresPolicyControlRole;
  readonly assertCurrent: typeof assertMigrationsCurrent;
  readonly createObjectStore: ArtifactObjectStoreFactory;
  readonly createPool: typeof createPostgresPool;
}

const defaultDependencies: StorageDependencies = {
  createPolicyPool: createPolicyPostgresPool,
  assertPolicyControl: assertPostgresPolicyControlRole,
  assertCurrent: assertMigrationsCurrent,
  createObjectStore: createS3ArtifactObjectStore,
  createPool: createPostgresPool,
};

async function drainStorageResources(
  objects: ManagedArtifactObjectStore | undefined,
  pools: readonly ReturnType<typeof createPostgresPool>[],
) {
  const errors: unknown[] = [];
  try {
    objects?.destroy();
  } catch (error) {
    errors.push(error);
  }
  const results = await Promise.allSettled(
    pools.map((pool) => Promise.resolve().then(() => pool.end())),
  );
  for (const result of results) if (result.status === "rejected") errors.push(result.reason);
  return errors;
}

export async function createApiStorage(
  config: ApiConfig["storage"],
  onIdleError: (error: Error) => void,
  dependencies: StorageDependencies = defaultDependencies,
): Promise<ApiStorage> {
  if (config.mode === "memory") {
    const interactionStorage = createMemoryInteractionStorage();
    const policyJobs = new MemoryPolicyEvaluationJobRepository({
      now: () => new Date().toISOString(),
    });
    const replayDefinitionRepository = new MemoryReplayDefinitionRepository();
    const replayJobRepository = new MemoryReplayJobRepository({
      definitions: replayDefinitionRepository,
      now: () => new Date().toISOString(),
    });
    const keyring = new LocalArtifactKeyring({
      activeKeyId: "key_memory_process",
      keys: { key_memory_process: randomBytes(32) },
    });
    return {
      policyEvaluation: { control: policyJobs, snapshots: policyJobs, results: policyJobs },
      artifacts: {
        catalog: interactionStorage.artifactCatalogRepository,
        encryption: new ArtifactCipher(keyring),
        identities: new SecureArtifactIdentityGenerator(),
        objects: new MemoryArtifactObjectStore(),
      },
      checkReadiness: async () => undefined,
      close: async () => undefined,
      comparisonRepository: new MemoryComparisonRepository(),
      evaluationRepository: new MemoryEvaluationRepository(),
      evidenceRepository: new MemoryEvidenceRepository(),
      interactionFixtureVersionRepository: interactionStorage.regressionVersionRepository,
      regressionVersionRepository: interactionStorage.regressionVersionRepository,
      modelAssuranceRepository: new MemoryModelAssuranceRepository(),
      releaseCandidateRepository: new MemoryReleaseCandidateRepository(),
      releasePolicyRepository: new MemoryReleasePolicyRepository(),
      replayDefinitionRepository,
      replayJobControlRepository: replayJobRepository,
    };
  }

  const pool = dependencies.createPool({
    applicationName: "proofstack-api",
    connectionString: config.databaseUrl,
    onIdleError,
  });
  const ownedPools = [pool];
  let policyAuthorPool: ReturnType<typeof createPostgresPool>;
  let policyControlPool: ReturnType<typeof createPolicyPostgresPool>;
  let persistentObjects: ManagedArtifactObjectStore | undefined;
  let artifacts: ApiArtifactStorage | undefined;
  try {
    policyAuthorPool = dependencies.createPool({
      applicationName: "proofstack-api-policy-author",
      connectionString: config.policyAuthorDatabaseUrl,
      onIdleError,
    });
    ownedPools.push(policyAuthorPool);
    await dependencies.assertCurrent(pool);
    await dependencies.assertCurrent(policyAuthorPool);
    policyControlPool = dependencies.createPolicyPool({
      applicationName: "proofstack-api-policy-control",
      connectionString: config.policyEvaluationControlDatabaseUrl,
      onIdleError,
    });
    ownedPools.push(policyControlPool);
    await dependencies.assertCurrent(policyControlPool);
    await dependencies.assertPolicyControl(
      policyControlPool,
      config.policyEvaluationControlDatabaseUrl,
    );
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
    const failures = await drainStorageResources(persistentObjects, ownedPools);
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "API storage initialization and cleanup failed",
      );
    throw error;
  }

  const regressionVersionRepository = new PostgresRegressionVersionRepository(pool);
  const releasePolicyRepository = new PostgresReleasePolicyRepository(policyAuthorPool);
  return {
    policyEvaluation: {
      control: new PostgresPolicyEvaluationJobControlRepository(policyControlPool),
      snapshots: new PostgresPolicySnapshotRepository(policyControlPool),
      results: new PostgresPolicyEvaluationResultRepository(policyControlPool),
    },
    ...(artifacts ? { artifacts } : {}),
    checkReadiness: async () => {
      await Promise.all([
        dependencies.assertCurrent(pool),
        dependencies.assertCurrent(policyAuthorPool),
        dependencies.assertCurrent(policyControlPool),
        dependencies.assertPolicyControl(
          policyControlPool,
          config.policyEvaluationControlDatabaseUrl,
        ),
      ]);
    },
    close: async () => {
      const failures = await drainStorageResources(persistentObjects, ownedPools);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "API storage cleanup failed");
    },
    comparisonRepository: new PostgresComparisonRepository(pool),
    evaluationRepository: new PostgresEvaluationRepository(pool),
    evidenceRepository: new PostgresEvidenceRepository(pool),
    interactionFixtureVersionRepository: regressionVersionRepository,
    regressionVersionRepository,
    modelAssuranceRepository: new PostgresModelAssuranceRepository(pool),
    releaseCandidateRepository: new PostgresReleaseCandidateRepository(pool),
    releasePolicyRepository,
    replayDefinitionRepository: new PostgresReplayDefinitionRepository(pool),
    replayJobControlRepository: new PostgresReplayJobControlRepository(pool),
  };
}
