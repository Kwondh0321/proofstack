import { createHash, randomUUID } from "node:crypto";
import { CreateBucketCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import {
  ArtifactCipher,
  LocalArtifactKeyring,
  ReserveArtifact,
  SecureArtifactIdentityGenerator,
  UploadArtifact,
} from "@proofstack/artifacts";
import type { PrincipalContext, ReserveArtifactRequest } from "@proofstack/contracts";
import {
  PostgresArtifactCatalogRepository,
  createPostgresPool,
  migrateDatabase,
  provisionRuntimeRoles,
  type RuntimeRoleProvisioningOptions,
} from "@proofstack/postgres";
import { createS3ArtifactObjectStore, createS3Client } from "@proofstack/s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ArtifactMaintenanceCommandName, loadArtifactMaintenanceConfig } from "./config.js";
import { runArtifactMaintenance } from "./runtime.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for artifact maintenance integration tests`);
  return value;
}

const databaseUrl = requiredEnvironment("PROOFSTACK_TEST_DATABASE_URL");
const s3AccessKeyId = requiredEnvironment("PROOFSTACK_TEST_S3_ACCESS_KEY_ID");
const s3SecretAccessKey = requiredEnvironment("PROOFSTACK_TEST_S3_SECRET_ACCESS_KEY");
const s3Endpoint = requiredEnvironment("PROOFSTACK_TEST_S3_ENDPOINT");
const s3Region = requiredEnvironment("PROOFSTACK_TEST_S3_REGION");
const runKey = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const bucket = `proofstack-maintenance-${randomUUID()}`;
const keyMaterial = Buffer.alloc(32, 17);
const keyId = "key_maintenance_integration";
const scope = {
  environmentId: `env_${runKey}`,
  projectId: `prj_${runKey}`,
  tenantId: `ten_${runKey}`,
};
const roleOptions: RuntimeRoleProvisioningOptions = {
  api: { name: `ps_it_api_${runKey}`, password: `proofstack-api-${runKey}` },
  artifact: {
    name: `ps_it_artifact_${runKey}`,
    password: `proofstack-artifact-${runKey}`,
  },
  consumer: { name: `ps_it_consumer_${runKey}`, password: `proofstack-consumer-${runKey}` },
  identity: { name: `ps_it_identity_${runKey}`, password: `proofstack-identity-${runKey}` },
  publisher: { name: `ps_it_publisher_${runKey}`, password: `proofstack-publisher-${runKey}` },
};

function readEnvironmentVariable(name: string): string | undefined {
  return process.env[name];
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

const previousAwsCredentials = {
  accessKeyId: readEnvironmentVariable("AWS_ACCESS_KEY_ID"),
  secretAccessKey: readEnvironmentVariable("AWS_SECRET_ACCESS_KEY"),
};
const adminErrors: Error[] = [];
const adminPool = createPostgresPool({
  applicationName: "proofstack-artifact-maintenance-integration-admin",
  connectionString: databaseUrl,
  maxConnections: 2,
  onIdleError: (error) => adminErrors.push(error),
});
const s3Connection = {
  allowInsecureLoopback: true,
  credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey },
  endpoint: s3Endpoint,
  forcePathStyle: true,
  region: s3Region,
};
const bucketClient = createS3Client(s3Connection);
const trackedObjectKeys = new Set<string>();
let bucketCreated = false;
let writerPool: ReturnType<typeof createPostgresPool> | undefined;
let writerCatalog: PostgresArtifactCatalogRepository | undefined;
let writerObjects: ReturnType<typeof createS3ArtifactObjectStore> | undefined;

function roleDatabaseUrl(role: { readonly name: string; readonly password: string }): string {
  const value = new URL(databaseUrl);
  value.username = role.name;
  value.password = role.password;
  return value.toString();
}

function writerPrincipal(): PrincipalContext {
  return {
    authentication: {
      authenticatedAt: new Date().toISOString(),
      credentialId: "key_artifact_integration_writer",
      method: "api_key",
    },
    capabilities: ["artifact:write"],
    principalId: "wrk_artifact_integration_writer",
    principalType: "workload",
    requestId: `req_${runKey}`,
    resourceScope: {
      mode: "restricted",
      projects: [{ environmentIds: [scope.environmentId], projectId: scope.projectId }],
    },
    roles: ["ingest"],
    tenantId: scope.tenantId,
  };
}

function maintenanceConfig(command: ArtifactMaintenanceCommandName) {
  return loadArtifactMaintenanceConfig(command, {
    PROOFSTACK_ARTIFACT_ABANDONED_BEFORE: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
    PROOFSTACK_ARTIFACT_ACTIVE_KEY_ID: keyId,
    PROOFSTACK_ARTIFACT_BATCH_LIMIT: "100",
    PROOFSTACK_ARTIFACT_DATABASE_URL: roleDatabaseUrl(roleOptions.artifact),
    PROOFSTACK_ARTIFACT_ENVIRONMENT_ID: scope.environmentId,
    PROOFSTACK_ARTIFACT_KEYS: JSON.stringify({ [keyId]: keyMaterial.toString("base64url") }),
    PROOFSTACK_ARTIFACT_OPERATOR_PRINCIPAL_ID: "svc_artifact_maintenance_integration",
    PROOFSTACK_ARTIFACT_PROJECT_ID: scope.projectId,
    PROOFSTACK_ARTIFACT_S3_BUCKET: bucket,
    PROOFSTACK_ARTIFACT_S3_ENDPOINT: s3Endpoint,
    PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
    PROOFSTACK_ARTIFACT_S3_REGION: s3Region,
    PROOFSTACK_ARTIFACT_TENANT_ID: scope.tenantId,
    PROOFSTACK_ENV: "test",
  });
}

async function seedArtifact(
  artifactId: string,
  state: "available" | "reserved-empty" | "reserved-stored",
  retention: ReserveArtifactRequest["retention"],
): Promise<string> {
  if (!writerCatalog || !writerObjects) throw new Error("integration writer is not ready");
  const content = Buffer.from(JSON.stringify({ artifactId, evidence: "integration" }), "utf8");
  const createdAt = new Date(Date.now() - 48 * 60 * 60 * 1_000);
  const cipher = new ArtifactCipher(
    new LocalArtifactKeyring({
      activeKeyId: keyId,
      keys: { [keyId]: keyMaterial },
    }),
  );
  const identities = new SecureArtifactIdentityGenerator();
  const principal = writerPrincipal();
  const reserve = new ReserveArtifact({
    catalog: writerCatalog,
    clock: { now: () => new Date(createdAt) },
    encryption: cipher,
    identities,
  });
  await reserve.execute({
    environmentId: scope.environmentId,
    principal,
    projectId: scope.projectId,
    request: {
      artifactId,
      classification: "confidential",
      mediaType: "application/json",
      redaction: { status: "not_required" },
      retention,
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.byteLength,
    },
  });
  const entry = await writerCatalog.find(scope, artifactId);
  if (!entry) throw new Error(`Reserved artifact ${artifactId} is missing`);
  trackedObjectKeys.add(entry.objectKey);
  if (state === "available") {
    await new UploadArtifact({
      catalog: writerCatalog,
      clock: { now: () => new Date(createdAt.getTime() + 1_000) },
      encryption: cipher,
      objects: writerObjects,
    }).execute({
      artifactId,
      content,
      environmentId: scope.environmentId,
      principal,
      projectId: scope.projectId,
    });
  } else if (state === "reserved-stored") {
    const encrypted = await cipher.encrypt(entry.metadata, entry.encryption, content);
    await writerObjects.putIfAbsent(entry.objectKey, encrypted.bytes);
  }
  return entry.objectKey;
}

beforeAll(async () => {
  restoreEnvironmentVariable("AWS_ACCESS_KEY_ID", s3AccessKeyId);
  restoreEnvironmentVariable("AWS_SECRET_ACCESS_KEY", s3SecretAccessKey);
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, roleOptions);
  await bucketClient.send(new CreateBucketCommand({ Bucket: bucket }));
  bucketCreated = true;
  writerPool = createPostgresPool({
    applicationName: "proofstack-artifact-maintenance-integration-writer",
    connectionString: roleDatabaseUrl(roleOptions.api),
    maxConnections: 2,
    onIdleError: (error) => adminErrors.push(error),
  });
  writerCatalog = new PostgresArtifactCatalogRepository(writerPool);
  writerObjects = createS3ArtifactObjectStore({ ...s3Connection, bucket });
});

afterAll(async () => {
  for (const objectKey of trackedObjectKeys) {
    await writerObjects?.delete(objectKey);
  }
  writerObjects?.destroy();
  await writerPool?.end();
  if (bucketCreated) await bucketClient.send(new DeleteBucketCommand({ Bucket: bucket }));
  bucketClient.destroy();
  for (const role of Object.values(roleOptions)) {
    const exists = await adminPool.query<{ readonly present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present",
      [role.name],
    );
    if (exists.rows[0]?.present) {
      await adminPool.query(`DROP OWNED BY "${role.name}"`);
      await adminPool.query(`DROP ROLE "${role.name}"`);
    }
  }
  await adminPool.end();
  restoreEnvironmentVariable("AWS_ACCESS_KEY_ID", previousAwsCredentials.accessKeyId);
  restoreEnvironmentVariable("AWS_SECRET_ACCESS_KEY", previousAwsCredentials.secretAccessKey);
});

describe("artifact maintenance real adapters", () => {
  it("converges interrupted, expired, abandoned, and pending-purge artifacts", async () => {
    if (!writerCatalog || !writerObjects) throw new Error("integration writer is not ready");
    const expiredId = `art_expired_${runKey}`;
    const pendingId = `art_pending_${runKey}`;
    const reconciledId = `art_reconciled_${runKey}`;
    const abandonedId = `art_abandoned_${runKey}`;
    const expiredKey = await seedArtifact(expiredId, "available", {
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
      mode: "expire",
    });
    const pendingKey = await seedArtifact(pendingId, "available", { mode: "retain" });
    const reconciledKey = await seedArtifact(reconciledId, "reserved-stored", { mode: "retain" });
    const abandonedKey = await seedArtifact(abandonedId, "reserved-empty", { mode: "retain" });
    await writerCatalog.tombstone(scope, {
      actorPrincipalId: "svc_artifact_integration_setup",
      artifactId: pendingId,
      occurredAt: new Date(Date.now() - 12 * 60 * 60 * 1_000).toISOString(),
      reason: "Integration fixture pending purge",
      tombstoneId: `del_${runKey}`,
      trigger: "manual",
    });

    await expect(runArtifactMaintenance(maintenanceConfig("key-status"))).resolves.toMatchObject({
      command: "key-status",
      status: "ok",
    });
    await expect(runArtifactMaintenance(maintenanceConfig("reconcile"))).resolves.toEqual({
      command: "reconcile",
      result: { activated: 1, failedArtifactIds: [], inspected: 2, missingObjects: 1 },
      status: "ok",
    });
    await expect(runArtifactMaintenance(maintenanceConfig("retention"))).resolves.toEqual({
      command: "retention",
      result: { failedArtifactIds: [], inspected: 1, purged: 1, tombstoned: 1 },
      status: "ok",
    });
    await expect(runArtifactMaintenance(maintenanceConfig("retry-purges"))).resolves.toEqual({
      command: "retry-purges",
      result: { failedArtifactIds: [], inspected: 1, purged: 1, tombstoned: 0 },
      status: "ok",
    });
    await expect(runArtifactMaintenance(maintenanceConfig("cleanup-abandoned"))).resolves.toEqual({
      command: "cleanup-abandoned",
      result: { failedArtifactIds: [], inspected: 1, purged: 1, tombstoned: 1 },
      status: "ok",
    });

    await expect(writerCatalog.find(scope, expiredId)).resolves.toMatchObject({
      metadata: { state: "purged" },
    });
    await expect(writerCatalog.find(scope, pendingId)).resolves.toMatchObject({
      metadata: { state: "purged" },
    });
    await expect(writerCatalog.find(scope, reconciledId)).resolves.toMatchObject({
      metadata: { state: "available" },
    });
    await expect(writerCatalog.find(scope, abandonedId)).resolves.toMatchObject({
      metadata: { state: "purged" },
    });
    await expect(writerObjects.get(expiredKey)).resolves.toBeNull();
    await expect(writerObjects.get(pendingKey)).resolves.toBeNull();
    await expect(writerObjects.get(reconciledKey)).resolves.not.toBeNull();
    await expect(writerObjects.get(abandonedKey)).resolves.toBeNull();
    await expect(runArtifactMaintenance(maintenanceConfig("key-status"))).resolves.toMatchObject({
      result: {
        activeKeyId: keyId,
        keys: [
          {
            active: true,
            configured: true,
            counts: { available: 1, purged: 3, reserved: 0, tombstoned: 0, total: 4 },
            keyId,
          },
        ],
      },
      status: "ok",
    });
    expect(adminErrors).toEqual([]);
  });
});
