import { randomBytes } from "node:crypto";
import {
  ArtifactCipher,
  InspectArtifactKeyReferences,
  LocalArtifactKeyring,
  ProcessAbandonedReservations,
  ProcessArtifactRetention,
  PurgeArtifact,
  ReconcileArtifactReservations,
  RetryArtifactPurges,
  SecureArtifactIdentityGenerator,
  type ArtifactCatalogRepository,
  type ArtifactMaintenanceResult,
  type ArtifactObjectStore,
  type InspectArtifactKeyReferencesResult,
  type ReconcileArtifactReservationsResult,
} from "@proofstack/artifacts";
import type { PrincipalContext } from "@proofstack/contracts";
import type { Clock } from "@proofstack/core";
import {
  PostgresArtifactCatalogRepository,
  assertMigrationsCurrent,
  createPostgresPool,
} from "@proofstack/postgres";
import { createS3ArtifactObjectStore } from "@proofstack/s3";
import type { ArtifactMaintenanceConfig } from "./config.js";

export interface ArtifactMaintenanceRunResult {
  readonly command: ArtifactMaintenanceConfig["command"];
  readonly result:
    | ArtifactMaintenanceResult
    | InspectArtifactKeyReferencesResult
    | ReconcileArtifactReservationsResult;
  readonly status: "ok" | "attention";
}

export interface ArtifactMaintenanceDatabase {
  readonly catalog: ArtifactCatalogRepository;
  assertCurrent(): Promise<void>;
  close(): Promise<void>;
  idleErrors(): readonly Error[];
}

export interface ArtifactMaintenanceObjectStorage {
  readonly store: ArtifactObjectStore;
  close(): Promise<void>;
}

export interface ArtifactMaintenanceRuntimeDependencies {
  readonly clock: Clock;
  readonly createRequestId: () => string;
  readonly openDatabase: (config: ArtifactMaintenanceConfig) => ArtifactMaintenanceDatabase;
  readonly openObjectStorage: (
    config: Exclude<ArtifactMaintenanceConfig, { readonly command: "key-status" }>,
  ) => ArtifactMaintenanceObjectStorage;
}

function openDatabase(config: ArtifactMaintenanceConfig): ArtifactMaintenanceDatabase {
  const errors: Error[] = [];
  const pool = createPostgresPool({
    applicationName: "proofstack-artifact-maintenance",
    connectionString: config.databaseUrl,
    maxConnections: 2,
    onIdleError: (error) => errors.push(error),
  });
  return {
    assertCurrent: () => assertMigrationsCurrent(pool),
    catalog: new PostgresArtifactCatalogRepository(pool),
    close: () => pool.end(),
    idleErrors: () => [...errors],
  };
}

function openObjectStorage(
  config: Exclude<ArtifactMaintenanceConfig, { readonly command: "key-status" }>,
): ArtifactMaintenanceObjectStorage {
  const store = createS3ArtifactObjectStore({
    allowInsecureLoopback: config.deploymentEnvironment !== "production",
    ...config.objectStorage,
  });
  return {
    close: async () => store.destroy(),
    store,
  };
}

const DEFAULT_DEPENDENCIES: ArtifactMaintenanceRuntimeDependencies = {
  clock: { now: () => new Date() },
  createRequestId: () => `req_artifact_maintenance_${randomBytes(12).toString("hex")}`,
  openDatabase,
  openObjectStorage,
};

function principal(
  config: ArtifactMaintenanceConfig,
  dependencies: ArtifactMaintenanceRuntimeDependencies,
): PrincipalContext {
  return {
    authentication: {
      authenticatedAt: dependencies.clock.now().toISOString(),
      credentialId: config.scope.operatorPrincipalId,
      method: "service_token",
    },
    capabilities: ["artifact:delete"],
    principalId: config.scope.operatorPrincipalId,
    principalType: "service",
    requestId: dependencies.createRequestId(),
    resourceScope: {
      mode: "restricted",
      projects: [
        {
          environmentIds: [config.scope.environmentId],
          projectId: config.scope.projectId,
        },
      ],
    },
    roles: ["admin"],
    tenantId: config.scope.tenantId,
  };
}

function needsAttention(
  result:
    | ArtifactMaintenanceResult
    | InspectArtifactKeyReferencesResult
    | ReconcileArtifactReservationsResult,
): boolean {
  if ("failedArtifactIds" in result) return result.failedArtifactIds.length > 0;
  return result.keys.some((key) => !key.configured && key.counts.total > 0);
}

function runtimeDependencies(
  overrides: Partial<ArtifactMaintenanceRuntimeDependencies>,
): ArtifactMaintenanceRuntimeDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

async function execute(
  config: ArtifactMaintenanceConfig,
  dependencies: ArtifactMaintenanceRuntimeDependencies,
  database: ArtifactMaintenanceDatabase,
  setObjectStorage: (storage: ArtifactMaintenanceObjectStorage) => void,
): Promise<ArtifactMaintenanceRunResult> {
  await database.assertCurrent();
  const maintenancePrincipal = principal(config, dependencies);
  const command = {
    environmentId: config.scope.environmentId,
    limit: config.batchLimit,
    principal: maintenancePrincipal,
    projectId: config.scope.projectId,
  };
  let result: ArtifactMaintenanceRunResult["result"];
  if (config.command === "key-status") {
    const keyring = new LocalArtifactKeyring(config.keyring);
    result = await new InspectArtifactKeyReferences({
      catalog: database.catalog,
      keys: keyring,
    }).execute(command);
  } else {
    const storage = dependencies.openObjectStorage(config);
    setObjectStorage(storage);
    const identities = new SecureArtifactIdentityGenerator();
    const purge = new PurgeArtifact({
      catalog: database.catalog,
      clock: dependencies.clock,
      identities,
      objects: storage.store,
    });
    if (config.command === "reconcile") {
      const keyring = new LocalArtifactKeyring(config.keyring);
      result = await new ReconcileArtifactReservations({
        catalog: database.catalog,
        clock: dependencies.clock,
        encryption: new ArtifactCipher(keyring),
        objects: storage.store,
      }).execute({ ...command, abandonedBefore: config.abandonedBefore });
    } else if (config.command === "cleanup-abandoned") {
      result = await new ProcessAbandonedReservations({
        catalog: database.catalog,
        clock: dependencies.clock,
        identities,
        purge,
      }).execute({ ...command, abandonedBefore: config.abandonedBefore });
    } else if (config.command === "retention") {
      result = await new ProcessArtifactRetention({
        catalog: database.catalog,
        clock: dependencies.clock,
        identities,
        purge,
      }).execute(command);
    } else {
      result = await new RetryArtifactPurges({ catalog: database.catalog, purge }).execute(command);
    }
  }
  return { command: config.command, result, status: needsAttention(result) ? "attention" : "ok" };
}

export async function runArtifactMaintenance(
  config: ArtifactMaintenanceConfig,
  overrides: Partial<ArtifactMaintenanceRuntimeDependencies> = {},
): Promise<ArtifactMaintenanceRunResult> {
  const dependencies = runtimeDependencies(overrides);
  const database = dependencies.openDatabase(config);
  let storage: ArtifactMaintenanceObjectStorage | undefined;
  let outcome: ArtifactMaintenanceRunResult | undefined;
  const failures: unknown[] = [];
  try {
    outcome = await execute(config, dependencies, database, (opened) => {
      storage = opened;
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    await storage?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await database.close();
  } catch (error) {
    failures.push(error);
  }
  failures.push(...database.idleErrors());
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Artifact maintenance failed and cleanup was incomplete");
  }
  if (!outcome) throw new Error("Artifact maintenance finished without an outcome");
  return outcome;
}
