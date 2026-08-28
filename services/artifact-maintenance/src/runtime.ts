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
  type ArtifactMaintenanceResult,
  type InspectArtifactKeyReferencesResult,
  type ReconcileArtifactReservationsResult,
} from "@proofstack/artifacts";
import type { PrincipalContext } from "@proofstack/contracts";
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

function clock() {
  return { now: () => new Date() };
}

function principal(config: ArtifactMaintenanceConfig): PrincipalContext {
  return {
    authentication: {
      authenticatedAt: clock().now().toISOString(),
      credentialId: config.scope.operatorPrincipalId,
      method: "service_token",
    },
    capabilities: ["artifact:delete"],
    principalId: config.scope.operatorPrincipalId,
    principalType: "service",
    requestId: `req_artifact_maintenance_${randomBytes(12).toString("hex")}`,
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

export async function runArtifactMaintenance(
  config: ArtifactMaintenanceConfig,
): Promise<ArtifactMaintenanceRunResult> {
  const idleErrors: Error[] = [];
  const pool = createPostgresPool({
    applicationName: "proofstack-artifact-maintenance",
    connectionString: config.databaseUrl,
    maxConnections: 2,
    onIdleError: (error) => idleErrors.push(error),
  });
  let objects: ReturnType<typeof createS3ArtifactObjectStore> | undefined;
  try {
    await assertMigrationsCurrent(pool);
    const catalog = new PostgresArtifactCatalogRepository(pool);
    const maintenancePrincipal = principal(config);
    const command = {
      environmentId: config.scope.environmentId,
      limit: config.batchLimit,
      principal: maintenancePrincipal,
      projectId: config.scope.projectId,
    };
    let result: ArtifactMaintenanceRunResult["result"];
    if (config.command === "key-status") {
      const keyring = new LocalArtifactKeyring(config.keyring);
      result = await new InspectArtifactKeyReferences({ catalog, keys: keyring }).execute(command);
    } else {
      objects = createS3ArtifactObjectStore({
        allowInsecureLoopback: config.deploymentEnvironment !== "production",
        ...config.objectStorage,
      });
      const identities = new SecureArtifactIdentityGenerator();
      const purge = new PurgeArtifact({ catalog, clock: clock(), identities, objects });
      if (config.command === "reconcile") {
        const keyring = new LocalArtifactKeyring(config.keyring);
        result = await new ReconcileArtifactReservations({
          catalog,
          clock: clock(),
          encryption: new ArtifactCipher(keyring),
          objects,
        }).execute({ ...command, abandonedBefore: config.abandonedBefore });
      } else if (config.command === "cleanup-abandoned") {
        result = await new ProcessAbandonedReservations({
          catalog,
          clock: clock(),
          identities,
          purge,
        }).execute({ ...command, abandonedBefore: config.abandonedBefore });
      } else if (config.command === "retention") {
        result = await new ProcessArtifactRetention({
          catalog,
          clock: clock(),
          identities,
          purge,
        }).execute(command);
      } else {
        result = await new RetryArtifactPurges({ catalog, purge }).execute(command);
      }
    }
    if (idleErrors.length > 0) throw idleErrors[0];
    return { command: config.command, result, status: needsAttention(result) ? "attention" : "ok" };
  } finally {
    objects?.destroy();
    await pool.end();
  }
}
